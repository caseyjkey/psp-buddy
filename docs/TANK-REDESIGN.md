# PSP Buddy — "The Tank" Redesign Plan

Status: **new plan in flight (2026-11-02).** Casey's revised plan replaces
reference-frame extraction with **procedural creature generation**: the agent
writes every sprite and animation from maths, no reference artwork is
extracted, and nothing is hand-edited. The effect chain (stipple, chromatic
tracer, palette) stays in the offline generator; the runtime drives playback
speed, position, tint, opacity and population.

**v0.8.1-alpha is built, hash-verified and staged** (see "Build status" below)
but the PSP was not on USB, so it is awaiting Casey's hardware launch.

Supersedes the face/status-text UI as the primary visual. obtainer-style
pixel-art aquarium: pure black void, particle-stipple creatures with chromatic
aberration, gentle sine motion, zero UI chrome. The creature *is* the
dashboard.

## Build status (2026-11-02)

| what | state |
|---|---|
| Procedural generator | `tools/creatures/generate.py` — all 4 species, awake + sleeping variants |
| Sprite atlases | 8 atlases baked, 8-bit RGBA, pow2, 4×2 = 512×256 each |
| Aquarium controller | `src/aquarium.ts` — rate→energy, quota→posture, presence separate |
| Tank scene | `src/app.tsx` — black void, water gradient, sand floor, provider strip |
| Runtime wiring | `frameStep` from token rate, position/opacity/scale from quota |
| EBOOT | `dist/EBOOT-v0.8.1-alpha.PBP`, 4,827,560 bytes, sha256 `a606a065402412dd7fb1053ef4ced37c4b24819dda5d8d3ed8dc6a2df4918573` |
| Deploy | STAGED on the Windows host; PSP not on USB at build time |
| Hardware launch | **PENDING — Casey** |

**Sim controls on-device** (Phase 1 acceptance): `O` toggles the sim panel,
`TRIANGLE` raises simulated rate, `SQUARE` lowers simulated quota, `X`
refreshes telemetry. This exercises the full behaviour path without live
data.

### Framework constraints verified (2026-11-02)

- `frameStep` **is per-instance** — `framework/src/native-tree.ts:636` reads
  `node.domAttrs?.frameStep` — so each creature can animate at its own speed.
- Atlas: 8-bit RGBA PNG, pow2 dims ≤512, grid must divide evenly. 8 frames of
  128px = **4 cols × 2 rows = 512×256**.
- **No runtime shaders.** Runtime props are transform + colour only
  (`scale`, `rotate`, `rotateX/Y`, `opacity`, `bgColor`, `gradFrom/To/Dir`,
  `inset*`, `zIndex`). Pixel stages (RGB separation, tracer, quantise) must be
  baked or approximated.
- **The cooker discovers sprite atlases by scanning LITERAL strings**
  (`tools/build.ts:441`: `classStrings.filter(s => /^[\w./-]+\.(?:png|svg)$/i)`).
  A computed name like ``sprite={`${base}.png`}`` is a template literal, so
  the atlas is silently NOT baked and the sprite renders as nothing. Every
  atlas name must be a literal — hence `src/creature-sprites.ts`, which holds
  the names as literals and is looked up at runtime. This cost a build cycle:
  the first tank build produced a 3-entry, 52KB pak with no creatures in it.

## Core principle

**Rate never controls presence.** Every provider has one alpha creature that
is always in the tank. tokens/min controls company/energy around the alpha;
quota controls posture/color. The only empty-tank state is offline (no data).

## Scene layout (480×272, fixed logical viewport)

- Pure black void background.
- Seabed strip ~15% (bottom), open water ~65%, surface shimmer ~20% (top).
- Mostly water → crab for Muse (bird only if a large sky region is added later).

## Creature roster — 4 alphas, always present, one per provider

| Provider | Creature | Zone            | Notes                                  |
|----------|----------|-----------------|----------------------------------------|
| OpenClaw/GPT | Fish   | mid-water cruiser | the workhorse                        |
| MiniMax    | Jellyfish | upper column, pulses | present-but-idle until telemetry catches up |
| Kimi       | Butterfly | surface flutterer |                                      |
| Muse       | Crab      | seabed scuttler   | locked                                 |

Extras (lowest priority, only if real estate allows): generic snails for
OpenCode's free / untracked models. Main 4 stay prominent and well-defined.

## Behavior rule (the cohesive state machine)

Per-alpha state, driven by bridge data:

- **tokens/min →** school density + swim speed + glow around that alpha.
- **quota →** posture/color: thriving → draining → asleep-on-sand.
- **reset →** a small `wakes in Xh Ym` tag floats over any sleeper.
- **0 t/m + quota OK →** lone alpha drifting calmly, full color.
- **offline →** black tank, faint static.

States:
- **Thriving** — vivid color, brisk pace, 3–8 fry trailing.
- **Idle** — lone alpha, slow sine drift, full color, calm.
- **Draining** — quota < ~20%, desaturates, fins droop.
- **Asleep** — quota 0, bottom of tank, dim, slow breath-pulse, wakes-in tag.
- **Hibernating** — weekly quota 0, whole tank dark, everyone asleep.
- **Offline** — black tank, faint static.

## Interactivity

- **X** = tap the glass — creatures scatter and regroup (also refresh).
- **Circle** = reset / detail overlay (existing countdown view).
- **START** = keep-awake toggle (existing).
- Stretch: D-pad drops a pellet, fish chase it.

## Data source (Token Monitor bridge)

Bridge already polls TM hub and serves `/v1/buddy`. Needs to also surface:
- **Per-model token rates** — TM exposes `models`, `modelThroughput`
  (timed tokens/duration), `clientModels`. Model→vendor inference exists in
  TM (`usage.js`): `kimi`→kimi, `minimax`/`mcode`→minimax, `muse`→muse,
  `gpt-*`→codex/openai.
- **Provider status** — TM limit providers carry a `status` field
  (`ok` / `sourceRateLimited` / `unauthorized` / `notConfigured`). Out-of-token
  is readable as a status flip, but only for providers wired into TM limits.

### Known data gaps (separate workstreams)

- **MiniMax under-reporting — ROOT CAUSE FOUND AND PROVEN (2026-11-02).**

  **The MiniMax endpoint is fine.** Called directly with the real key, it
  returns correct usage in BOTH modes:

  ```
  non-streaming: {"total_tokens":213,"prompt_tokens":203,"completion_tokens":10,
                   "prompt_tokens_details":{"cached_tokens":202}, ...}
  streaming + stream_options.include_usage: same usage block
  ```

  So the fault is in **OpenClaw**, not MiniMax and not Token Monitor.

  **The chain (all verified against the installed build
  `openclaw-2026.9.8`):**

  1. MiniMax is configured as `api: "openai-completions"`, `baseUrl:
     https://api.minimax.io/v1` (`~/.openclaw/openclaw.json`).
  2. In the OpenAI-completions transport, usage is only requested when the
     model opts in:
     `kn.supportsUsageInStreaming && (Hr.stream_options = {include_usage:!0})`.
     Without it, the endpoint returns `usage: null` on every chunk — which is
     exactly what MiniMax does unless asked.
  3. That flag comes from
     `resolveOpenAICompletionsCompatDefaults(...)`, whose
     `supportsUsageInStreaming` defaults to **false** for an unknown
     custom endpoint class:
     `supportsUsageInStreaming: Pn || !Si && (Di || !Jn || kn)` where
     `Pn = supportsOpenAICompletionsStreamingUsageCompat`.
  4. `Pn` is fed from the **plugin manifest**:
     `supportsOpenAICompletionsStreamingUsageCompat:
        Fn?.openAICompletions?.supportsStreamingUsage === true`
     (`plugin-provider-request-policy-BTFcZHnv.mjs`).
  5. The bundled MiniMax plugin (`dist/extensions/minimax/openclaw.plugin.json`)
     declares a `minimax-native` endpoint class and **no**
     `openAICompletions.supportsStreamingUsage` flag. The Kimi plugin
     (`~/.openclaw/extensions/kimi/openclaw.plugin.json`) declares
     `providerRequest.providers.kimi.compatibilityFamily: "moonshot"`,
     which sets `supportsNativeStreamingUsageCompat` — **that is why Kimi
     works and MiniMax does not.** Same endpoint family, same model, same
     transport; only the manifest opt-in differs.

  **Consequence in the transcript:** OpenClaw writes the usage it was handed,
  which is the zero block:

  ```json
  {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,
   "cost":{...all 0},"contextUsage":{"state":"unavailable"}}
  ```

  Over the last 1500 transcript events:

  | model | events | events with 0 tokens | sum of tokens | contextUsage.state |
  |---|---|---|---|---|
  | `MiniMax-M3.1-Flash` | 314 | **314** | **0** | `unavailable` |
  | `kimi-for-coding` | 17 | 0 | 4,176,639 | `available` |
  | `delivery-mirror` | 9 | 9 | 0 | — |

  It is **always** been zero, not a regression: across 135 days of daily
  history, `minimax-m3.1-flash` shows **1302 messages and 0 tokens**, while
  `muse-spark-1.3` (15.5M) and `kimi-for-coding` (158M) count normally.

  **Fix:** make the MiniMax plugin declare the opt-in, e.g. in
  `dist/extensions/minimax/openclaw.plugin.json`:

  ```json
  "providerRequest": {
    "providers": {
      "minimax": { "openAICompletions": { "supportsStreamingUsage": true } }
    }
  }
  ```

  (Kimi's `providerRequest.providers.<id>` shape is the reference; the
  normalisation lives in `plugin-provider-request-policy-BTFcZHnv.mjs`.)
  No Token Monitor change is needed — see the period note below.

  **FIXED AND PROVEN LIVE (2026-11-02 ~20:47 UTC).** Rather than patch the
  bundled plugin manifest (wiped on every npm update), the flag was set on the
  model row in user config — the exact lever OpenClaw's own warning message
  names:

  ```bash
  openclaw config set \
    'models.providers.minimax.models[0].compat.supportsUsageInStreaming' true \
    --strict-json
  ```

  The gateway hot-reloaded it (journal: `config hot reload applied
  (models.providers.minimax.models)`), and the agent transcript — the ground
  truth — now records non-zero MiniMax usage where it was always zero before:

  ```
  20:49:43  total=414691  (was 0 for every event before the fix)
  20:49:16  total=412907
  20:48:55  total=412261
  ...
  ```

  Proof chain, end to end:
  1. `openclaw config get models.providers.minimax.models --json` shows the
     flag persisted.
  2. A fresh subagent on `minimax/MiniMax-M3.1-Flash` returned the exact
     string `MINIMAX-PROOF-OK` — the route is live and authorised.
  3. The transcript store shows non-zero `totalTokens` on every MiniMax turn
     after the reload, vs zero on every turn before.

  Note for durability: this is a per-model config flag in `~/.openclaw/
  openclaw.json`; it survives npm updates (unlike a manifest patch). If the
  provider is ever re-added from scratch, re-apply the flag.

- **OpenClaw `today` / `month` periods are empty, `allTime` is not — SAME
  CAUSE.** Token Monitor's period model comes from `tokscale`:
  `--today`, `--month`, `--since <allTimeSince>`. The session-usage archive
  (`~/.config/Token Monitor/session-usage-archive.sqlite`) holds 1848 rows,
  and the period sets per client are:

  | client | periods present | rows |
  |---|---|---|
  | openclaw | `allTime` only | 1824 |
  | openclaw | `allTime` + `month` | 3 |
  | codex | `allTime` only | 20 |
  | claude | `allTime` only | 1 |

  Two mechanisms then hide the rest:
  1. `hasSessionUsage()` (Token Monitor `shared/usage/sessionUsageArchive.js:68`)
     keeps a session only if `totalTokens > 0 || costUsd > 0`. A MiniMax
     session has messages but no tokens, so it is **dropped entirely** —
     it never reaches `today` or `month`, only the raw `allTime` scan.
  2. `pruneExpiredSessionUsagePeriods()` deletes a session's `today`/`month`
     copy once the day/month window rolls over, keeping only `allTime`.
     So a zero-token session is invisible in the recent periods and
     survives only in the all-time totals.

  That is why the observed shape is exactly what Casey reported:
  **openclaw usage tracked, but only in all-time; daily and monthly empty.**

  **Fix path:** the MiniMax plugin opt-in above. Once `totalTokens > 0`,
  Token Monitor's existing logic carries the session into `today` and `month`
  with no Token Monitor change at all.

  Note the same pruning also explains why `today` is empty for *every* client
  today: the archive keeps only `allTime` rows for openclaw/codex/claude, and
  the day/month copies are dropped on rollover.

- **Quota for non-Codex providers:** only configured TM limit providers report
  live windows. `limits.providers` shows `codex: ok`, but `kimi` and
  `minimax` are both `notConfigured` — they need an API key in Token Monitor's
  settings (`providers.minimax.apiKey`, `providers.kimi.apiKey`; MiniMax reads
  `MINIMAX_CODING_API_KEY` or the key set in its settings form). Until those are
  configured, assume quota-full until the provider returns an out-of-token
  signal.

## Rendering approach (PocketJS)

- Native `Sprite` primitive: auto-playing sprite-atlas, cycled by the Rust core
  per vblank — zero per-frame JS, byte-exact, ideal for the 8MB budget.
- Atlas format (from DESIGN.md): `setSprite(id, atlas, frames, cols, step)` —
  a `cols`-wide grid of `frames` cells; core draws cell
  `(frame−start)/step % frames` as a UV sub-rect.
- Creature body animation = sprite atlas (tail-swish / pulse / flap / scuttle).
  Position drift = JS sine paths on the node.
- Target creature size ~24–32px tall, indexed palette, black background so
  creatures blend into the void.

## Implementation phases

### Phase 0 — sprite-atlas spike (RISK: make-or-break)
Confirm the exact `ui:sprite` atlas format the PocketJS cooker expects. DONE:
format is `sprites.json` (`name.png` → `{cols,rows,frames,step,psm}`), 8-bit
PNG only (cooker rejects 16-bit), `<Sprite sprite="name" class="w-X h-Y"/>`,
native core cycles frames per vblank (zero per-frame JS). A procedural test
fish baked into the pak and animated on real PSP hardware (hash-verified
deploy to `PSP\GAME\FISHSPIKE`). Pipeline PROVEN.

**Art direction (corrected 2026-10-31):** obtainer's style is NOT clean neon
vector outlines. Decoded from his reference frames (`~/psp-refs/`): pure black
void; creatures built from hundreds of scattered particle-dots (pointillist
stipple, no solid fill); strong RGB chromatic aberration (each dot split into
R/G/B channel offsets — the signature glitchy anaglyph fringe); sparse dots
dense at the outline scattering inward; ethereal noisy grain. This is a
particle-shader/post-processing look, not hand-drawn polygons. obtainer has
NOT published his method (tweets are just "GIF"+title, empty bio, sells them
as SuperRare NFTs) — confirmed via logged-in Chrome CDP search.

**Art method:** crop the creature from real obtainer gif frames (authentic motion,
not synthetic), then run a 4-stage transform: (1) per-channel brightness
threshold → scattered pure-tone dots on black (this is what creates stipple
instead of noise); (2) posterize each channel to 4 levels → preserves multiple
RGB shades rather than flattening; (3) chromatic tracer → split R/G/B into
ghost copies (the anaglyph fringe); (4) temporal smear → blend a faded previous
frame for motion exaggeration. Finally quantize to a fixed 16-entry RGB-primary
palette (black, 3 shades each of R/G/B, yellow/magenta/cyan/white/greys) and
re-export as RGBA — **the PocketJS cooker rejects palette PNGs (color type 3)**.

**Phase-0 art gate: PASSED (build + deploy).** Jellyfish atlas baked and
verified in the pak (`ui:sprite.jelly.png` present, 256×64 RGBA, 4 frames,
16-colour).

EBOOT deployed to `D:\PSP\GAME\PSPBUDDY\EBOOT.PBP` — 2,842,252 bytes,
SHA-256 `6ebd5fa38b1a02ec716531f0f88e792ab407872a6c3453d4858f0b0f672a4ae4`,
dest hash identical to source (byte-for-byte verified). Rollback preserved at
`EBOOT.pre-v0.5.0.PBP` (the v0.4.2 build, hash `81FBF55E…1693C`).

**Still open: on-hardware visual confirmation** — build/copy is never launch
proof. Casey to launch PSP Buddy and confirm the jellyfish reads as
particle-stipple + chromatic fringe on the real 480×272 screen.

### Phase 1 — static scene
Black void, seabed strip, surface shimmer. Place all 4 alphas at zone anchors
with sine-drift motion. Confirm 480×272 layout + 8MB budget on hardware.

*Current:* the jellyfish sprite is already wired into `src/app.tsx` in place of
the old text face, replacing the 150×112 face block with a 192×48 animated
Sprite. Remaining Phase-1 work: swap the dashboard chrome for the black void
scene, then add the fish/butterfly/crab atlases.

### Phase 2 — behavior engine
Extend bridge for per-model rates + provider status. Implement the state
machine (thriving/idle/draining/asleep/hibernating/offline), school density,
glow, wakes-in tags.

### Phase 3 — interactivity
X tap-glass, Circle reset overlay, START keep-awake. Stretch: D-pad pellet.

### Phase 4 — polish + deploy
Snails for OpenCode free models if real estate allows. Hash-verified USB deploy
via the established path (verify Sony VID/PID, SHA-256 dest-vs-source, rollback
EBOOT preserved).

## Hardware / deploy constraints (unchanged)

- 8MB memory budget, 480×272 viewport, `text.glyphs.baked` + `input.buttons`.
- PSP-1000 (32MB) vs 2000/3000 (64MB) paths distinct; validate on 64MB first.
- Deploy: verify drive via Sony USB VID 054C + PID 01C8/02D2, confirm
  `PSP\GAME` present, copy only while PSP attached, SHA-256 verify, never
  touch CFW flash/plugins.
- Progress gates: USB detected → app checks pass → EBOOT builds → EBOOT
  launches on hardware. Build/copy is never launch proof.

## Toolchain gotchas (learned 2026-11-01)
- **PocketJS cooker rejects palette PNGs** (`png: unsupported color type 3`).
  Sprite atlases must be exported as RGBA even when the source art is indexed.
- **PSP texture dims must be pow2 ≤ 512** — `pak image: dims must be pow2 <= 512,
  got 192x192`. 192 is rejected; use 128/256/512.
- **`sprites.json` lives at `dirname(entry)`** — for this app that is `src/`,
  not the repo root. The PNG sits beside it.
- Atlas manifest fields: `{cols, rows, frames, step, psm}`. `psm: 2` =
  PSM_4444, halves atlas texmem on PSP (use it).
- `<Sprite sprite="name.png" class="w-[W] h-[H]" />` — the `sprite` prop literal
  is what the cooker scans for; the PNG filename must match it exactly.
  `<Image src="name.png" .../>` works the same way for a static image.
- **Cell aspect must equal display aspect.** A 4-cell atlas of 64×64 cells
  rendered at `w-[192] h-[48]` is a 3× horizontal stretch + 0.75× vertical
  squash. Square cell, square display, 1:1.

## Art pipeline (final, 2026-11-01)

**Core insight (Casey):** obtainer's look is a **post-process**, not hand-drawn
art. The creature *source* and the *effect* are separate. That means any input
works — an SVG we author (2D vector), a rendered 3D model, a gif frame, a
hand-drawn still — and the pipeline is identical for all of them. This is the
path to animating everything we don't have art for.

### Two-stage split

**Stage 1 — geometry:** the creature's actual articulation.

**Stage 2 — colour:** slide R/G/B along independent orbits. The outline holds
while the colours crawl inside it — obtainer's signature.

**Both are needed.** Colour slide alone is only a shimmer; the outline must
move like an animated character.

### Geometry source: DOT-CLOUD MODEL, not strokes and not gif

Casey's corrections, in order:
1. The outline must move — colour slide alone reads as a shimmer.
2. "Otherwise i could have just had you use the original gif from X" — the
   reference gif already contains real motion, so use it rather than
   synthesising it.
3. A hand-authored **stroke** model read as **wireframe**. Obtainer's
   creatures are **filled** with stipple.

Then the decisive observation: **a gif can't loop perfectly** because sampled
frames don't wrap. That is a property of *sampling*, not of the art.

A **model** fixes it by construction: motion is a sum of sinusoids with period
1.0, so `t=1.0` is pixel-identical to `t=0.0`. The renderer asserts this
(`loop check: t=0.0 == t=1.0 -> True`).

A model is also **data** — add / remove / alter a creature = edit JSON and
regenerate. That is the answer to "can we programmatically add/remove/alter
the model?" Yes, and it is the reason to prefer models over baked atlases.

### Two model flavours tried

**(a) Stroke model** — polylines with pivots; dots placed along each line.
Result: reads as **wireframe**, because the dots only trace the lines.
Rejected.

**(b) Dot-cloud model (current, correct)** — extract the reference's actual
stipple dots *with their colours*, partition them into limbs, and give each
limb a periodic transform. The dots then move **as one articulated body**.

`model_cloud.py`:
- `extract_points()` — pull every bright dot from a reference frame with its
  normalised RGB.
- `partition_limbs()` — spatial split into `upperL` / `upperR` / `lowerL` /
  `lowerR` / `body`.
- `render_planes()` — evaluate every limb's transform at time t, emit
  separate R/G/B planes (colour stays separable from geometry).

**Why not potrace:** the reference is scattered *dots*, not solid regions, so
thresholding yields disconnected specks and potrace finds zero paths. The dot
cloud **is** the model — tracing is the wrong tool for stipple art.

### Model build pipeline (current)

`build_model.py` — one command, reference frame → model JSON + atlas:

1. `extract_points()` — the reference's stipple dots with normalised RGB.
2. `keep_largest_cluster()` — **connected components on the DOTS themselves**
   (distance graph, radius 14); keep only the largest. This drops
   neighbouring creatures that would otherwise ride along with the wings.
   *Not* morphological dilation — dilating merges separate creatures into
   one blob (verified: dilation at every radius kept 100% of points).
3. `find_body_apex()` — the body is where the wings **CONVERGE**. Scoring by
   column *density* is wrong (a neighbour's wing can out-densify the body);
   scoring by column *span* is also wrong (a near-vertical wing spans a lot
   vertically and wins, putting the pivot out at the wing tip → the wing
   swings sideways like a windshield wiper). The apex is the lowest
   smoothed column with enough dots to be real geometry.
4. `split_by_body()` — limbs around that axis.
5. `assign_flap()` — all limbs pivot at the body; wings share the **same
   phase** so they rise and fall together.

### Transform modes

- `rotate` — swing the limb about a pivot (tails, scuttles).
- `flap` — PSEUDO-3D WINGBEAT. The wing is a **flat plate rotating about the
  body's long axis**. We fake the projection: the wing's span direction
  rotates (tips sweep a vertical arc) and the span **foreshortens** as the
  plate turns edge-on. Foreshortening uses a **squared** `cos` so the wing
  collapses hard at the top of the beat, matching obtainer.

  A plain scaleY squash reads as side-to-side **oscillation** — that was
  the bug MiniMax's transform had.

Per-limb fields: `wingAngle` (rest direction, from the wing's own
centroid), `flapAmp` (peak out-of-plane rotation, radians), `flapPhase`.

Both wings share one phase → a wingbeat, not a windmill.

### Calibration against the obtainer reference (measured, not eyeballed)

Reference: X status `2010721082874151334` → `video.twimg.com/tweet_video/
G-eEF1TXQAAIF_h.mp4`. One butterfly **tracked across 8 frames** (flood-fill
from a seed, re-cropped each frame) so the comparison is same-creature.

Metrics used: `lit` (lit pixels), `bbox`, `fill` (lit / bbox area),
`rgbSpread` (mean per-pixel max−min channel).

| metric | reference | v0.7.3 (was deployed) | v0.7.4 (calibrated) |
|---|---|---|---|
| fill | 0.29 – 0.38 | 0.06 – 0.11 | 0.29 |
| rgbSpread | 156 – 178 | 230 – 235 | 165 |
| lit px | 7.4k – 9.6k | 670 – 1115 | ~3.0k |

Three real defects, none of them the transform:

1. **Wrong source footage.** `bf/*.png` was a cluttered segment — a steep
   thin V plus a grey streak object. Re-sourced from the clean X video
   segment (`xr_001.png`), which has broad filled fans.

2. **Colour normalisation destroyed the fringes.** `extract_points` forced
   every dot to a saturated hue (`scale = 255/m`), pinning one channel to
   255 on *every* lit pixel → rgbSpread 233–235, i.e. a hard 3-colour
   graphic instead of luminous stipple. Now keeps the sampled RGB and adds
   a `desat` knob (0.25 → rgbSpread 165.1) so greys/near-whites survive
   quantisation.

3. **Creature didn't fill the cell.** Scale used the *crop region*, not the
   creature's own bbox, leaving fill at 0.105 vs 0.31. Now scales on the
   content bbox (167×116 → scale 0.720).

### Pipeline (model → atlas)

1. `render_planes()` → limb transforms at time t → R/G/B planes
2. `slide_planes()` → each plane offset along its own orbit (colour crawl)
3. `tracer()` → R/G/B ghost split (anaglyph fringe)
4. `posterize()` → keeps multiple RGB shades
5. `quantize()` → fixed 16-entry RGB-primary palette
6. grid atlas (4×2 of 128px cells = 512×256)

### Frame alignment (for the reference-frame path)

Frames are aligned by **bright-pixel centroid** before processing. This cancels
translation drift (the creature sliding across frame) which read as a "jump",
while preserving articulation (the actual wing flap). Skipping this was the
earlier bug where the creature appeared to teleport between frames.

### Atlas grid constraint

Texture dims must be pow2 ≤ 512. 8 frames of 128px cells must be a **4×2 grid
(512×256)**, not a horizontal strip (1024 wide was rejected).

### Runtime option (not yet used)

The PSP host implements `uploadTexture` (`hosts/psp/src/ffi.rs:249`) and a
native `uploadIndexedImage` CLUT path, so a model could in principle be
re-rendered and uploaded **at runtime** rather than baked into the pak. That
would make creature geometry data-driven on the device. Deferred — baking is
simpler and fits the 8MB budget for now.

### Full pipeline

`build_creature.py` / `build_slide.py` / `build_creature_fit.py` in `~/psp-refs/`:

1. **auto-crop** to the creature's content bbox within a search region —
   a loose crop downsampled to a small cell shreds the silhouette into noise
   and no shape survives (first deployed bug).
2. **square the region** (no aspect distortion), or fit into a pow2 canvas
   preserving aspect for non-square creatures.
3. downscale to the target cell size (128 for a full creature).
4. **per-channel brightness threshold** → scattered pure-tone dots. This step
   is what creates the stipple; without it you just get a dim blurry photo.
5. **posterize per channel** to 4 levels → keeps multiple RGB shades instead
   of flattening to single primaries (Casey: "different shades of RGB").
6. **chromatic tracer** → R/G/B split into ghost copies (the anaglyph fringe).
7. **quantize** to a fixed 16-entry RGB-primary palette.
8. **export RGBA** (cooker rejects palette PNGs).
9. *(animation only)* per frame, slide R/G/B along independent orbits →
   4-frame atlas at 128px cell = 512 wide.

### Vector-source note

Thresholding a **solid white SVG stroke** yields continuous lines, not dots —
the stroke survives the threshold intact. To get dotted outlines from vector
art you need either:
- **stochastic dithering** (randomly drop a fraction of lit pixels) →
  scattered organic dots, or
- **dashed strokes** (`stroke-dasharray`) → regular dots.

Both work; dithering matches obtainer better.

## Open questions / next decisions
- **Next action:** deploy the filled dot-cloud butterfly (EBOOT staged + hash-
  verified on aurora-wsl; PSP was offline at stage time) and confirm the
  creature reads as FILLED (not wireframe) and the wings flap with a seamless
  loop.
- **Model authoring:** the dot-cloud model is extracted from a reference frame
  and partitioned by spatial rules. For the other three creatures (fish,
  jellyfish, crab) the same pipeline applies, but each needs the right
  crop region + limb split + flap params. Next: jellyfish (bell pulse),
  then fish (tail swish), then crab (scuttle).
- **Runtime rendering:** PSP supports `uploadTexture` + native
  `uploadIndexedImage`, so models could be re-rendered on-device. Deferred
  until the baked path proves out.
- **Phase 1 scene:** once one model is confirmed, place all creatures on the
  black-void scene with sine drift.
- MiniMax telemetry + non-Codex quota are parallel workstreams, not design
  blockers.
- Obtainer's exact generation method remains unpublished; we match the *look*,
  not a known recipe. No further X research planned.
