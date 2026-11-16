# PSP Buddy — brief for review

Status: **re-thinking requested by Casey (2026-11-01).** Read this before
touching code. The previous approach is documented here so it can be judged,
not repeated.

## 1. The goal

**A fishtank on the PSP.** A black-void aquarium where each **model
provider** is a resident creature. The *number* of creatures and their
behaviour are driven by **live token usage**.

The agreed behavioural rules (Casey's decisions, not suggestions):

| signal | drives | never drives |
|---|---|---|
| token **rate** (company + energy) | motion: beat speed, drift, colour crawl | presence |
| token **quota** (posture + colour) | posture: sinking to the sand, sleeping, waking | presence |
| **presence** | only: fully offline → empty tank | — |

Every provider gets **one always-present resident "alpha"**. Zero
tokens/min = a lone alpha drifting calmly, **not** an empty tank. Quota
exhausted = the alpha sinks to the sand and sleeps with a floating
`wakes in Xh Ym` tag. Only a fully offline provider leaves the tank empty.

Creature roster (Casey's picks): **Fish = OpenClaw, Jellyfish = MiniMax,
Butterfly = Kimi, Crab = Muse.**

Scene spans sea bed to surface.

## 2. What was actually built (and why Casey is right to reject it)

### 2.1 The pipeline (offline, Python, in `/home/alpha/psp-refs/`)

A "model" is JSON data — a dot cloud with per-limb periodic transforms:

```
{ "cell":128, "frames":8, "cols":4, "travel":2,
  "shades":4, "tracer":2, "blur":0.35,
  "limbs":[ {"name":"upperL", "pivot":[x,y],
             "wingAngle":-1.93, "flapAmp":1.25, "flapPhase":0.0,
             "mode":"flap", "points":[[x,y,r,g,b], ...]} ] }
```

Build steps (`build_model.py` → `model_cloud.py` → `model_clean.py`):

1. `extract_points()` — pull the reference's **stipple dots** with their RGB.
2. `keep_largest_cluster()` — connected components on the **dots themselves**
   (distance graph). Drops neighbouring creatures. *Not* morphological
   dilation — dilating merges separate creatures into one blob.
3. `find_body_apex()` — the body is where the wings **converge**. Density is
   the wrong signal (a neighbour's wing out-densifies the body); column
   *span* is also wrong (a near-vertical wing wins, putting the pivot at the
   wing tip → the wing swings sideways like a windshield wiper).
4. `split_by_body()` → limbs; `assign_flap()` → each wing gets a rest
   `wingAngle` from its own centroid and a `flapAmp`.
5. `render_planes()` → R/G/B planes; `slide_planes()` → independent channel
   orbits (colour crawl); `tracer()` → anaglyph fringe; `posterize()`;
   `quantize()` → 16-entry RGB-primary palette.
6. Atlas: 8 frames of 128px cells = **4×2 grid = 512×256** (pow2, and the
   8MB pak budget rules out a 1024-wide strip).

The loop is seamless **by construction**: every transform is a sinusoid of
period 1.0, so `t=0.0` is pixel-identical to `t=1.0` (asserted in the build).

### 2.2 The defect Casey identified

**The creature is a pre-baked GIF.** The entire effect chain —
the wingbeat, the RGB tracer, the colour crawl, the quantisation — is
applied **once, offline, in Python**, and baked into `src/butterfly.png`.
The PSP runtime contains **no effect code at all**; it just plays an atlas:

```tsx
<Sprite sprite="butterfly.png" class="w-[128] h-[128]" />
```

`grep -rn "posterize|tracer|quantize|slide|flap|travel" src/` → **nothing**.

So there is **one** butterfly, with **fixed** beat speed, **fixed** colour
crawl, and **fixed** colour. There is no parameter that token usage can
move. The "fish tank" was never actually built — there is one sprite and a
meter.

The model JSON is *parameterised*, but nothing at runtime reads it. The
parameters are baked into pixels at build time.

### 2.3 What was learned along the way (keep these)

- obtainer's creatures are **filled with stipple**, not outlines. Tracing
  (potrace) is useless: thresholding yields disconnected specks and potrace
  finds zero paths. The dot cloud *is* the model.
- Don't normalise each dot to a saturated hue. obtainer's colour separation
  is **chromatic aberration on bright stipple**. Forcing one channel to 255
  pins RGB spread at 255 (a hard 3-colour graphic) vs the reference's ~165.
- Scale to the creature's **own content bbox**, not the crop region.
- Measured against a tracked single butterfly from the reference video:

  | metric | obtainer | what shipped |
  |---|---|---|
  | fill (lit ÷ bbox) | 0.29 – 0.38 | 0.06 – 0.11 |
  | RGB spread | 156 – 178 | 230 – 235 |

## 3. The hard constraint that decides the re-design

**The Pocket framework has no runtime shader / post-process API.** Runtime
style props are *transform-and-colour only*:

```
transform: translateX/Y, scale, rotate, scaleX/Y, originX/Y,
           rotateX, rotateY, translateZ, perspective, skewX
colour:    bgColor, gradFrom/To/Dir, opacity, radius, borderColor, shadow
layout:    width/height, inset*, margin*, flex*, zIndex, ...
```

So:

- **Possible at runtime:** per-creature `scale` / `rotate` / `rotateX` /
  `rotateY` / `opacity` / `bgColor` / position, and **animation speed**
  (`frameStep` overrides the atlas manifest).
- **Impossible at runtime:** per-pixel RGB channel separation, tracer
  fringes, palette quantisation, colour crawl.

That means a *literal* obtainer-style per-pixel tracer cannot be computed
on-device. The re-design has to either:

**(a) Pre-bake more, parameterise less.** Bake N atlases (e.g. beat speeds ×
colour intensities) and pick/switch at runtime. Cheap on PSP, coarse.

**(b) Bake the *parts*, animate the *whole*.** Ship the creature as
composed sub-sprites (wing L, wing R, body, tentacles…) and drive each
part's transform at runtime. This gives real 3D-ish flap, real beat speed,
real per-creature colour, and scales to *N* creatures — and it's the only
option that satisfies "dynamic number of models whose quantity corresponds
to model usage". Cost: more texture memory per creature type and a runtime
compositor budget (PSP is 60fps with a 480×272 viewport).

**(c) Do the effect on the host, ship frames.** The PSP already has a
tethered host channel (`svcPoll`, `svcSend`, `loadImgFile`, `videoOpen`).
The host could render the tracer/quantise per frame and stream textures.
Real obtainer fidelity, but it needs the host tethered — and the design
goal says the tank should work standalone.

**(d) Approximate the tracer in-engine.** Use 3 pre-baked channel-offset
copies of the creature as three overlapping sprites, each with a small
runtime offset + `bgColor` tint. Approximates the RGB fringe with
transform-only ops. Cheap, but limited.

I believe **(b)** is the strongest: it directly delivers a *tank of
creatures whose number and behaviour track token usage*, and it's the only
option where token usage can change beat speed and colour *per frame*.

## 4. Open questions for the review

1. Is (b) the right shape, or is there a better decomposition?
2. Should the *creature* be a single sprite with a transform, or a small
   rig of parts? (A rig costs more textures but gives real articulation.)
3. Where should the RGB tracer live — accept an approximation (d), or
   accept the host-tethered route (c)?
4. How many creature types, and does each provider get its own colour?
5. What's the texel budget? 8MB pak total, PSP texture dims pow2 ≤ 512.
6. Should behaviour be a **state machine** (posture per provider) rather
   than a continuous parameter map?

## 5. Where things live

| what | where |
|---|---|
| app (runtime) | `/home/alpha/Development/psp-buddy/src/` — `app.tsx`, `model.ts`, `platform.ts` |
| sprite atlas | `src/butterfly.png` + `src/sprites.json` (`cols`,`rows`,`frames`,`step`,`psm`) |
| design doc | `docs/TANK-REDESIGN.md` |
| model JSON | `models/butterfly.json` |
| offline pipeline | `/home/alpha/psp-refs/` — `build_model.py`, `model_cloud.py`, `model_clean.py` |
| reference footage | `/home/alpha/psp-refs/xr_*.png` (obtainer X video), `bf/` (older, poor segment) |
| comparison artefacts | `/home/alpha/psp-refs/COMPARE2.png`, `ref-track.png` |
| host bridge | `bridge/server.js`, `bridge/state.js` |
| native PSP net | `native/psp/buddy_net.rs` + `patches/` |

**Deployed on the PSP right now:** `EBOOT.PBP` 3,071,648 bytes, sha256
`E818C1D93A30BCDCB056DBAF4E56E3CA05FF60800169D63A9348B42B0CBB7FB7`
(v0.7.4 — the calibrated single butterfly). Rollbacks
`EBOOT.pre-v0.7.4.PBP` and earlier are on the device.
