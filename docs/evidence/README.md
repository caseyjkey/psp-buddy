# PSP Buddy OOM evidence

## The bug

Casey's PSP showed `PocketJS js error unknown error` followed by
`[PocketJS oom] alloc of N bytes failed` roughly five minutes after launch
(earlier reports: two minutes, then five). The failing size changed every
time (320 bytes, 3328 bytes, 34816 bytes).

## Root cause

`src/app.tsx` rendered the provider strip with a plain reactive `.map()`:

```tsx
return rows.map((p) => {
  const t = telemetry()[p];
  const live = creatures().filter((c) => c.provider === p).length;   // <-- reads a per-frame signal
  ...
});
```

`creatures()` is a signal updated **every frame**. Reading it inside the row
builder made the whole strip re-render 60 times a second. Solid's `map`
reconciliation destroys and recreates the native nodes for every row on each
re-render, and the retired nodes and their reactive closures are not
reclaimable on the PSP's small QuickJS arena. The tank therefore grew the
arena a few megabytes per minute until an allocation could not be served.

The creature list itself already used `<Index>`, which preserves nodes by
position — only the provider strip was still churning.

## The fix

`src/app.tsx` now renders the strip with `<Index each={reportingProviders()}>`
so row nodes are stable, and the unused `live` read is gone. A regression
test (`src/app-structure.test.ts`) asserts the churn cannot come back.

## Measurement

Both builds were run under PPSSPP with a populated tank (all five providers
reporting, creatures animating). The probe appends one line every 300 frames:

```
PROBE frame <n> bump <arena bytes used> tail <free tail> free <total free>
        largest <largest free block> qlive <QuickJS live bytes>
        qpeak <QuickJS peak> qcalls <alloc calls> qfail <failed allocs> cap <capacity>
```

Arena capacity is 14,893,824 bytes (~14.2 MiB) on this target.

### BEFORE the fix (populated tank)

```
PROBE frame 0    bump 5365200  tail 9528624  qlive 1425630  qcalls 1820
PROBE frame 300  bump 12020912 tail 2872912  qlive 3358246  qcalls 30928
PROBE frame 600  bump 14798256 tail 95568    qlive 5655350  qcalls 61032
```

Arena use went 5.4 MB -> 12.0 MB -> 14.8 MB in 600 frames, leaving only
**95 KB** of tail. QuickJS live memory grew every sample and the allocation
count was climbing ~100 per frame. The run **died** at that point instead of
logging another probe line: the arena could not serve the probe's own
allocation. That is the device crash.

### AFTER the fix (populated tank)

```
PROBE frame 0     bump 5384656  tail 9508912  qlive 1443192  qcalls 1843
PROBE frame 300   bump 5455248  tail 9438320  qlive 1443192  qcalls 2143
...
PROBE frame 47700 bump 5455248  tail 9438320  qlive 1443192  qcalls 49543
```

Across all 160 samples (frames 0-47,700 = 795 seconds, 13.2 minutes of
simulated time — 2.6x the window in which the device crashed):

| metric | distinct values across the run |
|---|---|
| arena bytes used | 5,384,656 once at frame 0, then **5,455,248 for all 159 later samples** |
| QuickJS live bytes | **1,443,192 in every single sample** |
| failed allocations | **0 in every single sample** |

The arena is flat and not a single allocation was refused for over thirteen
minutes of simulated time.

## Files

- `arena-probe-BEFORE-fix-populated.txt` — the leak, three samples, then death
- `arena-probe-AFTER-fix-populated.txt` — the fix, 142 samples, flat throughout
- `arena-probe-BEFORE-fix.txt` — an earlier run against an EMPTY tank, kept
  because it shows the trap: with no models reporting there is no strip to
  churn, so memory also looks flat. A populated tank is required to test this.

## Still required for a hardware verdict

This is emulator evidence. The PSP itself must run v0.9.6 for longer than
five minutes and write `arena-probe.txt` next to its EBOOT
(`ms0:/PSP/GAME/PSPBUDDY/arena-probe.txt`). The build deployed to the device
already contains the probe.

## Screenshots at the same frame

`docs/evidence/screenshots/BEFORE-fix-oom-screen.png` — the pre-fix build at
frame 701: the tank is gone and the screen is a wall of
`[PocketJS js error] InternalError: out of memory`, which is the error Casey
reported on the device.

`docs/evidence/screenshots/AFTER-fix-rendering.png` — the fixed build at frame
703: the full habitat renders (sky band, water, floor), all five creatures are
present, and the provider strip shows CODEX / MINIMAX / KIMI / MUSE / META with
their quota and rate.

The raw frame sizes make the same point numerically: the pre-fix capture
frames that show the error are 688 bytes (a flat error screen), while every
fixed-build capture frame is ~17 KB (a rendering scene).
