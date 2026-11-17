import { createMemo, createSignal, Index } from "solid-js";
import { Sprite, Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import {
  buildCreatures,
  DEFAULT_CONFIG,
  exhaustedQuotaLabel,
  hasSignal,
  PROVIDER_LABEL,
  spriteFor,
  wakesLabel,
  type Creature,
  type Provider,
  type ProviderTelemetry,
} from "./aquarium.ts";
import { CREATURE_OUTLINES } from "./creature-sprites.ts";
import {
  keepAwakeTick,
  readBuddySnapshot,
  readState,
  systemSnapshot,
  writeState,
  type SystemSnapshot,
} from "./platform.ts";

const INK = "#f8fafc";
const DIM = "#94a3b8";
const VOID = "#03060c";
const SAND = "#1b2436";
const PANEL = "#111827";

function outlineSpriteFor(creature: Creature): string | undefined {
  const outlines = CREATURE_OUTLINES[creature.provider as keyof typeof CREATURE_OUTLINES];
  if (!outlines) return undefined;
  return outlines[creature.posture === "sleeping" ? "sleeping" : "normal"];
}

/** Tank geometry. The PSP viewport is 480x272 integer-fit. */
const TANK_W = 456;
const TANK_H = 176;
const FLOOR_H = 30;
const CREATURE_PX = 48;

/** The complete habitat always fits inside the PSP viewport. */
const SCENE_W = TANK_W;
/** Height of the sky band at the top of the scene, when one is shown. */
const SKY_H = 72;
/** Match the bridge poll interval so live output rates do not sit stale for
 * half a minute after a conversation turn changes. */
const BRIDGE_REFRESH_FRAMES = 120;

// Kimi is a routed backend that can appear inside a mixed OpenClaw session;
// it is not one of the subscriptions represented by this tank. Muse is.
const PROVIDERS: Provider[] = ["codex", "minimax", "muse", "meta", "opencode-go"];

/** Per-provider tint, so a provider is recognisable at a glance. */
const PROVIDER_TINT: Record<Provider, string> = {
  codex: "#facc15",
  minimax: "#66e6ff",
  kimi: "#ff6ee0",
  muse: "#ff8a6a",
  meta: "#ffd75e",
  "opencode-go": "#a78bfa",
};

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/**
 * Elapsed seconds since the app started, measured by DELTA.
 *
 * The PSP's `Date.now()` is not a Unix epoch: QuickJS implements it with
 * `gettimeofday`, which on the PSP does not agree with the server's
 * timestamps. Comparing a server timestamp against it produced a nonsense
 * wake countdown ("wakes in 2076d") and made every model look stale.
 *
 * The DIFFERENCE between two readings is still valid, so elapsed time is
 * accumulated from deltas and never from an absolute value.
 */
function elapsedTracker(): { now(): number; reset(): void } {
  let last = Date.now();
  let total = 0;
  return {
    now() {
      const current = Date.now();
      const delta = current - last;
      if (Number.isFinite(delta) && delta > 0) total += delta;
      last = current;
      return total / 1000;
    },
    reset() {
      last = Date.now();
      total = 0;
    },
  };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Per-model telemetry from the bridge snapshot.
 *
 * The bridge publishes one entry per model provider that Token Monitor has
 * live limits for (minimax, kimi, muse-bridge, meta). Each entry carries the
 * session/weekly quota, the token rate in tokens/sec, and the number of
 * agents currently running on that model.
 *
 * A provider with no entry is simply absent from the hub -- it is not
 * configured, or it is unauthorised. Those render as "no signal" rather
 * than a made-up quota.
 */
function telemetryFrom(
  snapshot: Record<string, unknown> | undefined,
  secondsSinceSample: number,
): Record<Provider, ProviderTelemetry> {
  const mode = String(snapshot?.mode ?? "offline");
  const sampledAt = Number(snapshot?.sampledAt ?? 0);
  // stale telemetry != disconnection: keep the alpha, drop to idle.
  //
  // The age is measured in ELAPSED seconds on the device, never by
  // subtracting the server's timestamp from the PSP's clock: the two
  // epochs do not agree, and the subtraction produced a huge negative
  // age that marked every model as freshly sampled.
  const stale = secondsSinceSample > 300;
  // The native poller retains the last good body through transient failures.
  // Keep that population visible even once it ages out; only stop assigning
  // motion energy. Marking stale data offline makes populationFor() erase all
  // creatures, which is exactly the misleading blank-tank behavior we want
  // to avoid.
  const bridgeOnline = mode !== "offline";

  const models = (snapshot?.models ?? {}) as Record<string, Record<string, unknown>>;

  const out = {} as Record<Provider, ProviderTelemetry>;
  for (const p of PROVIDERS) {
    const key = p === "muse" ? "muse-bridge" : p;
    const m = models[key];
    if (!m) {
      // No published limits for this model: present but idle, unknown quota.
      out[p] = {
        tokensPerSecond: 0,
        tokensPerSecondPerAgent: 0,
        agentRates: [],
        quotaRemaining: null,
        quotaResetsAt: 0,
        quotaResetsInSec: -1,
        weeklyRemaining: -1,
        monthlyRemaining: -1,
        online: bridgeOnline,
        sampledAt,
        agentCount: 0,
      };
      continue;
    }
    const sessionRemaining = Number(m.sessionRemaining ?? -1);
    const agentCount = Number(m.agentCount ?? 0);
    const tokensPerSecond = Number(m.tokensPerSecond ?? 0);
    const agentRates = Array.isArray(m.agentRates)
      ? (m.agentRates as unknown[]).map((rate) => Number(rate) || 0)
      : [];
    out[p] = {
      tokensPerSecond: stale ? 0 : tokensPerSecond,
      tokensPerSecondPerAgent: stale ? 0 : Number(m.tokensPerSecondPerAgent ?? 0),
      agentRates: stale ? agentRates.map(() => 0) : agentRates,
      quotaRemaining: sessionRemaining >= 0 ? sessionRemaining / 100 : null,
      quotaResetsAt: Number(m.sessionResetsAt ?? 0),
      quotaResetsInSec: Number(m.sessionResetsInSec ?? -1),
      weeklyRemaining: Number(m.weeklyRemaining ?? -1),
      monthlyRemaining: Number(m.monthlyRemaining ?? -1),
      online: true,
      sampledAt,
      agentCount,
    };
  }
  return out;
}

export default function App() {
  const firstSystem = systemSnapshot();
  const saved = readState<{ keepAwake?: boolean }>();
  const [system, setSystem] = createSignal<SystemSnapshot>(firstSystem);
  const [creatures, setCreatures] = createSignal<Creature[]>([]);
  const [notice, setNotice] = createSignal("starting...");
  const [toast, setToast] = createSignal("");
  const [keepAwake, setKeepAwake] = createSignal(saved?.keepAwake === true);
  const [simRate, setSimRate] = createSignal(0);
  const [simQuota, setSimQuota] = createSignal(1);
  const [showSim, setShowSim] = createSignal(false);
  // Live telemetry for the provider strip, so quota/usage/agent-count are
  // visible without digging. Updated on refresh and in sim mode.
  const [telemetry, setTelemetry] = createSignal<Record<Provider, ProviderTelemetry>>(telemetryFrom(undefined, 0));

  let frames = 0;
  let lastMs = 0;
  let toastFrames = 0;
  // Elapsed seconds since the last successful refresh. The count-down
  // labels and the staleness check are both driven from this, never from
  // comparing a server timestamp with the PSP's clock.
  const elapsed = elapsedTracker();
  let secondsSinceRefresh = 0;
  let lastSampledAt = 0;

  function refresh(): void {
    setNotice("checking gilbert...");
    const raw = readBuddySnapshot() as Record<string, unknown> | undefined;
    const sampledAt = Number(raw?.sampledAt ?? 0);
    const isNewSample = sampledAt > 0 && sampledAt !== lastSampledAt && raw?.mode !== "offline";
    const next = telemetryFrom(raw, isNewSample ? 0 : secondsSinceRefresh);
    setNotice(String(raw?.message ?? "NO SIGNAL").toLowerCase());
    telemetryRef = next;
    setTelemetry(next);
    // Restart only when a genuinely newer bridge sample arrived. The PSP
    // transport deliberately retains the last good body across a transient
    // request failure, so blindly resetting here would keep old data
    // "fresh" forever and prevent the stale-age policy from ever firing.
    if (isNewSample) {
      lastSampledAt = sampledAt;
      elapsed.reset();
      secondsSinceRefresh = 0;
    }
  }

  let telemetryRef = telemetryFrom(undefined, 0);

  onButtonPress(BTN.CROSS, refresh);
  // CIRCLE is the PSP "click/activate" button, so the framework's focus
  // pipeline can swallow it (buttonHandlerBlockDepth). allowWhenBlocked
  // lets the SIM toggle fire even when a focus block is active -- this is
  // why O "did nothing" before.
  onButtonPress(BTN.CIRCLE, () => setShowSim(!showSim()), { allowWhenBlocked: true });
  onButtonPress(BTN.TRIANGLE, () => {
    const next = clamp(simRate() + 0.25, 0, 1);
    setSimRate(next);
  });
  onButtonPress(BTN.SQUARE, () => {
    const next = clamp(simQuota() - 0.25, 0, 1);
    setSimQuota(next);
  });
  onButtonPress(BTN.START, () => {
    const enabled = !keepAwake();
    setKeepAwake(enabled);
    writeState({ keepAwake: enabled });
    if (enabled) keepAwakeTick();
    setToast(`SCREEN STAY-AWAKE: ${enabled ? "ON" : "OFF"}`);
    toastFrames = 120;
  });

  onFrame(() => {
    frames++;
    if (toastFrames > 0) {
      toastFrames--;
      if (toastFrames === 0) setToast("");
    }
    const now = Date.now();
    const dt = lastMs ? Math.min(0.1, (now - lastMs) / 1000) : 0.016;
    lastMs = now;
    if (keepAwake()) keepAwakeTick();
    if (frames % 60 === 0) setSystem(systemSnapshot());
    if (frames === 120 || frames % BRIDGE_REFRESH_FRAMES === 0) refresh();
    // Age the sample. The delta is accumulated locally, so it stays
    // correct regardless of what the device's absolute clock reads.
    secondsSinceRefresh = elapsed.now();

    // Simulated telemetry overrides the bridge so the behaviour can be
    // exercised on the device without live data.
    let telemetry = telemetryRef;
    if (showSim()) {
      telemetry = {} as Record<Provider, ProviderTelemetry>;
      for (const p of PROVIDERS) {
        const agentCount = Math.max(1, Math.round(simRate() * 8));
        telemetry[p] = {
          tokensPerSecond: simRate() * DEFAULT_CONFIG.rateForFullEnergy,
          tokensPerSecondPerAgent: simRate() * DEFAULT_CONFIG.rateForFullEnergy,
          agentRates: Array(agentCount)
            .fill(simRate() * DEFAULT_CONFIG.rateForFullEnergy),
          quotaRemaining: simQuota(),
          quotaResetsAt: 0,
          quotaResetsInSec: -1,
          weeklyRemaining: simQuota() * 100,
          monthlyRemaining: -1,
          online: true,
          sampledAt: Math.floor(now / 1000),
          agentCount,
        };
      }
      setTelemetry(telemetry);
    }

    const next = buildCreatures(telemetry, creatures(), dt);
    // attach the wake label for any sleeping creature
    for (const c of next) {
      if (c.posture === "sleeping") {
        // The label counts down a server-measured DURATION, so it stays
        // correct on a device whose clock has no usable epoch.
        const provider = telemetry[c.provider];
        const remaining = provider
          ? provider.quotaResetsInSec - Math.floor(secondsSinceRefresh)
          : -1;
        c.wakesLabel = wakesLabel(remaining);
      }
    }
    setCreatures(next);
  });

  const clock = createMemo(() => `${pad2(system().hour)}:${pad2(system().minute)}`);
  const battery = createMemo(() => {
    const b = system().battery;
    if (b < 0) return "BAT --";
    return `${system().charging ? "+" : ""}BAT ${b}%`;
  });

  /**
   * Is there a sky creature on screen?
   *
   * The sky band exists for the entire lifetime of any butterfly. Tying it
   * to the butterfly's animated depth made the whole habitat switch between
   * sky and water and visually teleported the butterfly into the ocean.
   */
  const skyVisible = createMemo(() => {
    return creatures().some((c) => c.provider === "kimi");
  });

  // Keep provider-row native nodes stable across telemetry refreshes. A plain
  // reactive `.map()` destroys and recreates the whole row whenever telemetry
  // changes; PocketJS cannot reclaim that native/reactive graph reliably on
  // the PSP's small QuickJS arena.
  const reportingProviders = createMemo(() => {
    return PROVIDERS.filter((p) => hasSignal(telemetry()[p]));
  });

  /** Vertical placement for a creature, in SCENE pixels. */
  function topFor(c: Creature): number {
    // Butterflies live wholly inside the conditional sky band. The generic
    // water-depth mapping put part of them below the sky and made them look
    // submerged even though the upper scene was painted as air.
    if (c.provider === "kimi") {
      const skyTravel = Math.max(0, SKY_H - CREATURE_PX - 4);
      const normalized = clamp((1 - c.depth) / 0.45, 0, 1);
      return 2 + normalized * skyTravel;
    }
    // depth 0 = on the sand, 1 = near the surface
    const band = TANK_H - FLOOR_H - CREATURE_PX;
    return FLOOR_H + band - c.depth * band;
  }

  function leftFor(c: Creature): number {
    return c.x * (SCENE_W - CREATURE_PX);
  }

  /**
   * One-line summary of the models actually on screen.
   *
   * The bridge's mood string describes CODEX, which is quota telemetry but
   * not its own creature -- so it could say "HIBERNATING IN THE CAVE" while
   * the tank showed nothing about caves. This summarises what is visible instead:
   * how many models are reporting, and whether any of them is in trouble.
   */
  const statusText = createMemo(() => {
    const rows = reportingProviders();
    if (rows.length === 0) return "NO MODELS REPORTING";
    const parts: string[] = [`${rows.length} MODEL${rows.length === 1 ? "" : "S"}`];
    const asleep = rows.filter((p) => {
      const q = telemetry()[p]?.quotaRemaining;
      return q !== null && q !== undefined && q <= 0.001;
    });
    if (asleep.length > 0) {
      parts.push(`${asleep.length} EXHAUSTED`);
    }
    const busy = rows.filter((p) => (telemetry()[p]?.tokensPerSecond ?? 0) > 0);
    if (busy.length > 0) parts.push(`${busy.length} ACTIVE`);
    return parts.join(" / ");
  });

  return (
    <View class="w-full h-full flex-col" style={{ bgColor: VOID }}>
      {/* header */}
      <View class="h-[26] flex-row items-center justify-between px-3" style={{ bgColor: "#080d18" }}>
        <Text class="text-xs font-bold tracking-wide" style={{ textColor: INK }}>{clock()}</Text>
        <Text class="text-xs font-bold tracking-wide" style={{ textColor: "#a5b4fc" }}>AQUARIUM</Text>
        <Text class="text-xs font-bold" style={{ textColor: system().powerOnline ? "#34d399" : DIM }}>{battery()}</Text>
      </View>

      {/* The full habitat is always visible: sky (when needed), water, and
          floor. D-pad, analog stick, and shoulder buttons are intentionally
          unmapped. */}
      <View
        class="relative overflow-hidden rounded-lg mx-2"
        style={{ height: TANK_H, bgColor: "#050a14", borderWidth: 1, borderColor: "#16233a" }}
      >
        {/* fixed scene layer; no camera or off-screen world */}
        <View
          class="absolute"
          style={{
            insetL: 0,
            insetT: 0,
            width: SCENE_W,
            height: TANK_H,
          }}
        >
          {/* water column gradient: darker at the bottom */}
          <View
            class="absolute inset-0"
            style={{ gradFrom: "#0e2038", gradTo: "#040a16", gradDir: 1 }}
          />

          {/* sky band, shown only when a sky creature exists. A butterfly
              needs a sky to fly in; with no sky creature the top of the
              tank is just more water. */}
          {skyVisible() ? (
            <View
              class="absolute left-0 right-0 top-0"
              style={{
                height: SKY_H,
                gradFrom: "#2a4a7a",
                gradTo: "#16305a",
                gradDir: 1,
                opacity: 0.9,
              }}
            />
          ) : null}

          {/* aquarium floor: one wide textured strip of rippled sand. The
              earlier version drew flat rounded rectangles and then rock
              sprites on top, which read as coloured blocks and as inactive
              sprites. It is now a texture applied to the ground surface,
              with nothing on it but the bottom dwellers. */}
          <View class="absolute bottom-0 left-0 right-0" style={{ height: FLOOR_H }}>
            <Sprite sprite="floor.png" class="w-full h-full" />
          </View>

          {/* Index preserves each native image node while its position changes.
              A plain reactive .map() rebuilt every Sprite on every frame,
              continuously resetting atlas playback to frame zero and
              eventually exhausting the native tree with node churn. */}
          <Index each={creatures()}>
            {(creature) => {
              // Keep the accessor itself. Reading creature() once here would
              // freeze every transform at mount time.
              const c = creature;
              return (
              <View
                class="absolute"
                style={{
                  insetL: leftFor(c()),
                  insetT: topFor(c()),
                  width: CREATURE_PX,
                  height: CREATURE_PX,
                  opacity: c().opacity,
                  scale: c().scale,
                }}
              >
                {/* facing: mirror by the sprite's own scaleX, because the
                    art's native facing differs per species (the fish is
                    drawn nose-left). */}
                <View
                  class="w-full h-full"
                  style={{ scaleX: c().scaleX }}
                >
                    {outlineSpriteFor(c()) ? (
                      <Sprite
                        sprite={outlineSpriteFor(c())!}
                        class="absolute w-full h-full"
                        frameStep={c().frameStep}
                      />
                    ) : null}
                  <Sprite
                    sprite={spriteFor(c())}
                    class="w-full h-full"
                    frameStep={c().frameStep}
                  />
                </View>
                {c().wakesLabel ? (
                  <View class="absolute" style={{ insetL: -6, insetT: -12 }}>
                    <Text class="text-xs font-bold" style={{ textColor: "#9fb4d4" }}>{c().wakesLabel}</Text>
                  </View>
                ) : null}
              </View>
              );
            }}
          </Index>
        </View>
      </View>

      {/* provider strip -- one compact row per model that has MEASURABLE
          data. A model we have never heard from is omitted entirely: an
          empty "--" row for a provider that is not reporting anything is
          clutter, and it would imply we know more than we do. */}
      <View class="flex-row items-center justify-between px-2" style={{ height: 30 }}>
        {reportingProviders().length === 0 ? (
          <View class="flex-row items-center justify-center w-full">
            <Text class="text-xs font-bold" style={{ textColor: DIM }}>
              NO MODELS REPORTING
            </Text>
          </View>
        ) : (
          <Index each={reportingProviders()}>
            {(provider: () => Provider) => {
              const p = () => provider();
              const t = () => telemetry()[p()];
              const q = () => t()?.quotaRemaining;
              const exhaustedWindow = () => exhaustedQuotaLabel(
                t()?.weeklyRemaining ?? -1,
                t()?.monthlyRemaining ?? -1,
              );
              // Prefer the exhausted longer window over a misleading healthy
              // session percentage (e.g. Codex S=100%, W=0%).
              const quotaTxt = () => exhaustedWindow()
                || (q() === null || q() === undefined ? "--" : `${Math.round(q()! * 100)}%`);
              const rateTxt = () => {
                const rate = t()?.tokensPerSecond ?? 0;
                return rate >= 1000 ? `${(rate / 1000).toFixed(1)}k` : `${Math.round(rate)}`;
              };
              const dot = () => !t()?.online
                ? "#334155"
                : exhaustedWindow() || (q() !== null && q()! <= 0.001)
                  ? "#ef4444"
                  : PROVIDER_TINT[p()];
              const qColor = () => exhaustedWindow() || (q() !== null && q()! <= 0.001)
                ? "#ef4444"
                : q() === null ? DIM : q()! < 0.25 ? "#fbbf24" : INK;
            return (
              <View class="flex-col" style={{ width: reportingProviders().length >= 6 ? 74 : reportingProviders().length >= 5 ? 88 : 110 }}>
                <View class="flex-row items-center gap-1">
                  <View class="w-[6] h-[6] rounded-full" style={{ bgColor: dot() }} />
                  <Text class="text-xs font-bold" style={{ textColor: t()?.online ? INK : DIM }}>
                    {PROVIDER_LABEL[p()]}
                  </Text>
                  <Text class="text-xs font-bold" style={{ textColor: DIM }}>
                    {`${t()?.agentCount ?? 0}ag`}
                  </Text>
                </View>
                <Text class="text-xs" style={{ textColor: qColor() }}>
                  {`${quotaTxt()}  ${rateTxt()} out/s`}
                </Text>
              </View>
            );
            }}
          </Index>
        )}
      </View>

      {/* Footer summarises the models actually on screen, not the bridge's
          Codex-derived mood. */}
      <View class="h-[24] flex-row items-center justify-center gap-3 px-2" style={{ bgColor: "#080d18" }}>
        <Text class="text-xs font-bold" style={{ textColor: "#fbbf24" }}>
          {showSim() ? "SIM" : statusText()}
        </Text>
        {showSim() ? (
          <>
            <Text class="text-xs font-bold" style={{ textColor: INK }}>{`RATE ${Math.round(simRate() * 100)}%`}</Text>
            <Text class="text-xs font-bold" style={{ textColor: INK }}>{`QUOTA ${Math.round(simQuota() * 100)}%`}</Text>
            <Text class="text-xs font-bold" style={{ textColor: DIM }}>TRI RATE / SQR QUOTA</Text>
          </>
        ) : (
          <Text class="text-xs font-bold" style={{ textColor: DIM }}>X REFRESH / O SIM</Text>
        )}
      </View>
      {toast() ? (
        <View
          class="absolute rounded-lg px-3 py-2"
          style={{ insetL: 118, insetT: 224, bgColor: PANEL, borderWidth: 1, borderColor: "#334155" }}
        >
          <Text class="text-xs font-bold" style={{ textColor: INK }}>{toast()}</Text>
        </View>
      ) : null}
    </View>
  );
}
