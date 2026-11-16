/**
 * Aquarium controller — turns telemetry into creature behaviour.
 *
 * Three INDEPENDENT axes, deliberately kept separate (Casey's rule):
 *
 *   rate   (tokens/min) -> ENERGY  : animation speed, swim speed, size
 *   quota  (% remaining)-> POSTURE : vertical position, colour, sleep state
 *   online/offline      -> PRESENCE: whether any creature is drawn at all
 *
 * Presence is NEVER driven by quota. A provider with an exhausted quota
 * keeps its creatures; they sink and sleep instead of vanishing. Only a
 * provider that is genuinely unreachable empties its slot.
 *
 * The alpha creature is always present while the provider is online, even
 * at zero usage.
 */

/**
 * The models that appear in the tank.
 *
 * NOT "openclaw": OpenClaw is the AGENT, not a model. It does not have its
 * own quota -- it consumes whichever model provider it routes to. Showing
 * it as a peer of the models is a category error, so the roster is the set
 * of model providers Token Monitor reports usage for.
 *
 * `muse` is the Muse bridge (provider key "muse-bridge" in Token Monitor);
 * `meta` is the upstream model the Muse bridge actually calls.
 */
export type Provider = "codex" | "minimax" | "kimi" | "muse" | "meta" | "opencode-go";

import { CREATURE_SPRITES, type CreatureSpriteKey } from "./creature-sprites.ts";

export interface ProviderTelemetry {
  /** Tokens per second, 0 when idle. */
  tokensPerSecond: number;
  /** Quota remaining 0..1, or null when unknown. */
  quotaRemaining: number | null;
  /** Epoch seconds when the quota resets, 0 when unknown. */
  quotaResetsAt: number;
  /**
   * Seconds until this model's session quota resets, measured by the server.
   *
   * The PSP's `Date.now()` is NOT a Unix epoch -- QuickJS implements it with
   * `gettimeofday`, which on the PSP is not comparable with the server's
   * timestamps. An absolute reset time therefore produced a nonsense
   * countdown ("wakes in 2076d"). A DURATION can be counted down locally
   * against the device's own elapsed time.
   */
  quotaResetsInSec: number;
  /** Weekly quota remaining 0..100, or -1 when no window is reported. */
  weeklyRemaining: number;
  /** Monthly quota remaining 0..100, or -1 when no window is reported. */
  monthlyRemaining: number;
  /** False only when the provider is genuinely unreachable. */
  online: boolean;
  /** Epoch seconds of the last sample; used to detect stale telemetry. */
  sampledAt: number;
  /**
   * How many agents are currently running on this model.
   *
   * This is the number worth showing: it is a real count of live sessions
   * on that provider, not a decorative multiplier. It is NOT the number of
   * creatures (that is derived from the token rate).
   */
  agentCount: number;
  /**
   * Output tokens per second, per agent.
   *
   * The provider-level `tokensPerSecond` is the SUM over every agent on
   * that model. A creature that swims at the sum's speed is wrong when
   * two agents share a model: each one is only working at half that
   * rate, and each should move at its own share.
   */
  tokensPerSecondPerAgent: number;
  /** Output tokens/sec for each individual live agent, in stable order. */
  agentRates: number[];
}

export type Posture = "normal" | "tired" | "sleeping";

export interface Creature {
  provider: Provider;
  /** 0-based index within the provider's group. Index 0 is the alpha. */
  index: number;
  posture: Posture;
  /** 0..1, drives animation speed and swim speed. */
  energy: number;
  /** Fraction of the tank height, 0 = sand, 1 = surface. */
  depth: number;
  /** Horizontal position in tank fractions, 0..1. */
  x: number;
  /** Animation frame step: lower = faster. */
  frameStep: number;
  /** Sprite opacity 0..1. */
  opacity: number;
  /** Sprite scale 1 = normal size. */
  scale: number;
  /** 1 = facing right, -1 = facing left. Set from horizontal velocity. */
  facing: number;
  /**
   * The horizontal scale to draw the sprite at.
   *
   * The art's native facing is baked into the atlas (the fish is drawn
   * nose-left), so the renderer mirrors by this value rather than by
   * negating `facing` at the call site.
   */
  scaleX: number;
  /** Integrated horizontal wander phase, in radians. */
  wanderPhase: number;
  /** Vertical bob phase; swimmers drift up and down. */
  bobPhase: number;
  /** Wakes-at label for a sleeping creature, else "". */
  wakesLabel: string;
}

export interface AquariumConfig {
  /** Height of the swimming band in pixels; the sand floor is below it. */
  tankHeight: number;
  tankWidth: number;
  /** Creature size in pixels. */
  creatureSize: number;
  /** Seconds. How fast a creature eases toward its target position. */
  smoothing: number;
  /** Max creatures per provider, including the alpha. */
  maxPerProvider: number;
  /**
   * Tokens/second that counts as "full energy".
   *
   * This is OUTPUT throughput, not total tokens: a long OpenClaw session
   * re-reads a huge cached prompt every turn, so a total-token rate reads
   * in the tens of thousands while real generation sits around 30-100
   * tokens/sec. Full energy is therefore ~120 output tok/s, which a busy
   * agent reaches during heavy turns.
   */
  rateForFullEnergy: number;
}

export const DEFAULT_CONFIG: AquariumConfig = {
  tankHeight: 200,
  tankWidth: 460,
  creatureSize: 48,
  smoothing: 0.6,
  maxPerProvider: 6,
  // OUTPUT tokens/second that counts as "flat out". Measured real
  // throughput on this host runs ~16-100 output tok/s depending on the
  // model, so 120 is a sensible ceiling.
  rateForFullEnergy: 120,
};

export const PROVIDER_CREATURE: Record<Provider, string> = {
  codex: "fish",
  minimax: "jellyfish",
  kimi: "butterfly",
  muse: "crab",
  meta: "snail",
  "opencode-go": "crab",
};

export const PROVIDER_LABEL: Record<Provider, string> = {
  codex: "CODEX",
  minimax: "MINIMAX",
  kimi: "KIMI",
  muse: "MUSE",
  meta: "META",
  "opencode-go": "OC-GO",
};

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Exponential ease toward a target, framerate-independent. */
function ease(current: number, target: number, rate: number, dt: number): number {
  const k = 1 - Math.exp(-rate * dt);
  return current + (target - current) * k;
}

/**
 * Do we have any MEASURABLE signal for this model?
 *
 * A model is shown only when we can actually say something about it:
 * its quota is known (including a known-exhausted quota, which must still
 * show so the creature can sleep on the sand rather than vanish), or tokens
 * are flowing, or agents are running on it.
 *
 * A model we have never heard from is hidden from both the tank and the
 * HUD -- an empty row saying "--" for a provider that is not reporting
 * anything is clutter, and a creature for it would be a lie.
 *
 * Note the quota case deliberately counts as measurable even at 0%: an
 * exhausted quota is a REAL, known state, and the sleeping creature with
 * its "wakes in Xh Ym" label is how that state is expressed.
 */
export function hasSignal(telemetry: ProviderTelemetry | undefined): boolean {
  if (!telemetry) return false;
  if (telemetry.quotaRemaining !== null && telemetry.quotaRemaining !== undefined) {
    return true;
  }
  return telemetry.tokensPerSecond > 0 || telemetry.agentCount > 0;
}

/**
 * How many creatures a provider should have.
 *
 * ONE CREATURE PER AGENT.
 *
 * The count used to be derived from the token rate, which meant a model
 * could report "3 agents" while the tank showed a single jellyfish -- the
 * number on screen did not match the number being reported. The agent
 * count is the real, countable thing: one creature per agent running on
 * that model.
 *
 * The alpha always exists while the provider is measurable, so a provider
 * with a live agent never goes completely blank.
 */
export function populationFor(
  telemetry: ProviderTelemetry,
  config: AquariumConfig = DEFAULT_CONFIG,
): number {
  if (!telemetry.online) return 0;
  if (!hasSignal(telemetry)) return 0;
  const agents = Math.max(0, Math.floor(telemetry.agentCount || 0));
  // One creature per agent, capped so a burst of agents cannot flood the
  // tank. Zero agents means zero creatures; quota alone stays in the HUD.
  return Math.min(agents, config.maxPerProvider);
}

/** Posture from quota. Presence is never derived from quota. */
export function postureFor(telemetry: ProviderTelemetry): Posture {
  if (!telemetry.online) return "sleeping";
  const q = telemetry.quotaRemaining;
  if (q === null) return "normal";       // unknown quota -> neutral look
  if (q <= 0.001) return "sleeping";
  if (q < 0.25) return "tired";
  return "normal";
}

/**
 * How fast ONE agent on this model is working, in output tokens/second.
 *
 * This is the creature's personal speed: the provider's rate divided by
 * the number of agents on it, so a model with three agents shows three
 * creatures each moving at a third of the provider rate.
 *
 * The provider total is the fallback when the bridge did not publish a
 * per-agent figure, so a single agent still moves at the full rate.
 */
export function agentRate(telemetry: ProviderTelemetry, index = 0): number {
  const measured = telemetry.agentRates?.[index];
  if (Number.isFinite(measured) && measured >= 0) return measured;
  const perAgent = telemetry.tokensPerSecondPerAgent;
  if (perAgent > 0) return perAgent;
  const agents = Math.max(1, Math.floor(telemetry.agentCount || 0));
  return Math.max(0, telemetry.tokensPerSecond || 0) / agents;
}

/**
 * Target depth for a creature.
 *
 * A sleeping creature sits on the sand. A tired one sinks. An energetic one
 * rises toward the surface. The creature's INDEX staggers them so a group
 * does not stack into one column.
 */
/**
 * The vertical band a species lives in.
 *
 * depth is 0 = on the sand, 1 = at the surface. Each species gets its own
 * band so the tank reads as a habitat with territories rather than a soup:
 *
 *   butterfly (Kimi)  SKY    0.66..1.00   it flies, it does not swim
 *   jellyfish (MiniMax) WATER 0.38..0.86   it drifts MID-WATER -- a
 *                                jellyfish is not a bottom feeder, so its
 *                                band deliberately does not reach the sand
 *   crab / snail       FLOOR  0.00..0.26   bottom dwellers
 *
 * The band is a soft limit: a creature is eased TOWARD the band rather
 * than clamped into it, so it can still cross slightly and the movement
 * never looks mechanical.
 */
export interface DepthBand {
  low: number;
  high: number;
}

/**
 * A swimmer's personal vertical range, chosen at random.
 *
 * The band only says WHERE a species may swim. Within it, each creature
 * picks its own floor and ceiling, so a group does not all bounce off the
 * same invisible line -- which is what made the jellyfish look like it was
 * running into a wall above and below.
 */
export interface SwimRange {
  floor: number;
  ceiling: number;
}

/**
 * Pick a personal vertical range inside a band.
 *
 * The range is jittered per creature (from a hash of its provider and
 * index, so it is stable frame to frame) and always leaves at least a
 * little room to move. `spread` is how much of the band it may use.
 */
export function swimRangeFor(
  band: DepthBand,
  index: number,
  providerKey: string,
  spread = 0.7,
): SwimRange {
  const height = band.high - band.low;
  const usable = height * spread;
  // Deterministic jitter in [0,1) from the creature's identity.
  const seed = (index + 1) * 2654435761 + providerKey.length * 40503;
  const jitter = ((seed >>> 8) % 1000) / 1000;
  // Centre the range inside the band, then offset it by the jitter.
  const slack = height - usable;
  const floor = band.low + slack * 0.5 + slack * jitter;
  return {
    floor,
    ceiling: Math.min(band.high, floor + usable),
  };
}

export const DEPTH_BAND: Record<Provider, DepthBand> = {
  codex: { low: 0.42, high: 0.82 },
  kimi: { low: 0.66, high: 1.0 },
  minimax: { low: 0.38, high: 0.86 },
  muse: { low: 0.0, high: 0.26 },
  meta: { low: 0.0, high: 0.26 },
  "opencode-go": { low: 0.0, high: 0.26 },
};

/**
 * Target depth for a creature.
 *
 * A sleeping creature sits on the sand. A tired one sinks. An energetic
 * one rises toward the surface. The creature's INDEX staggers them so a
 * group does not stack into one column.
 */
export function depthFor(posture: Posture, energy: number, index: number): number {
  if (posture === "sleeping") return 0.02;
  if (posture === "tired") return 0.18 + 0.10 * (index % 3);
  // energetic: higher energy -> nearer the surface
  return 0.34 + 0.48 * energy - 0.06 * (index % 3);
}

/**
 * Pull a target depth into the species' band.
 *
 * The band is applied as a gentle pull rather than a hard clamp: a
 * creature whose natural depth is outside its band is moved toward the
 * nearest edge of the band, and one already inside is left alone but
 * nudged toward the band centre. That keeps every species in its own
 * zone while still letting the energy signal express itself.
 */
export function applyBand(
  depth: number,
  band: DepthBand,
  energy: number,
  index: number,
): number {
  const centre = (band.low + band.high) / 2;
  const halfWidth = (band.high - band.low) / 2;
  // Spread the members of a group through the band.
  const slot = ((index % 3) - 1) / 2;         // -0.5 .. 0.5
  const target = centre + slot * halfWidth * 0.8;
  if (depth < band.low) return band.low + (depth - band.low) * 0.25;
  if (depth > band.high) return band.high + (depth - band.high) * 0.25;
  // inside the band: ease toward the slot position so a group spreads out
  return target + (depth - target) * (0.45 - energy * 0.25);
}

/** Animation speed from energy. Lower frameStep = faster playback. */
export function frameStepFor(energy: number): number {
  // Keep even an idle resident visibly alive. At 60 Hz this is roughly
  // 12 fps idle and 30 fps at full energy, instead of the glacial cadence
  // that looked like one frame every several seconds on the PSP display.
  return Math.round(clamp(5 - energy * 3, 2, 5));
}

/**
 * Build the full creature list for the tank.
 *
 * `previous` is the last frame's list so positions can be smoothed instead
 * of snapping -- both population and position must ease, or the tank
 * flickers when the telemetry updates.
 */
export function buildCreatures(
  telemetry: Record<Provider, ProviderTelemetry>,
  previous: Creature[],
  dt: number,
  config: AquariumConfig = DEFAULT_CONFIG,
): Creature[] {
  const prevByKey = new Map<string, Creature>();
  for (const c of previous) prevByKey.set(`${c.provider}:${c.index}`, c);

  const out: Creature[] = [];
  for (const provider of Object.keys(telemetry) as Provider[]) {
    const t = telemetry[provider];
    if (!t.online) continue;

    const count = populationFor(t, config);
    const posture = postureFor(t);
    // The creature's speed is ITS OWN rate, not the model's total: a model
    // with three agents shows three creatures, each working at a third of
    // the provider's token rate, and each should move at that share.
    for (let i = 0; i < count; i++) {
      const rate = agentRate(t, i);
      const energy = clamp(rate / config.rateForFullEnergy, 0, 1);
      const step = frameStepFor(energy);
      const key = `${provider}:${i}`;
      const prev = prevByKey.get(key);

      // Bottom dwellers: the crab and the snail hug the sand regardless of
      // energy. The swimming creatures rise with energy and sink when
      // tired/asleep -- and every species is pulled into its own vertical
      // band, so the tank has territories (sky / water / floor) instead of
      // a soup.
      const isBottomDweller = provider === "muse" || provider === "meta" || provider === "opencode-go";
      const rawDepth = isBottomDweller
        // Bottom dwellers are bottom-aligned, not merely assigned a low
        // swim band. Any positive depth leaves a visible gap above the sand.
        ? 0
        : depthFor(posture, energy, i);
      const band = DEPTH_BAND[provider];
      // Each swimmer gets its OWN floor and ceiling inside the band, so a
      // group does not all bounce off one invisible line. That is what made
      // the jellyfish look like it was running into a wall above and below.
      const swim = swimRangeFor(band, i, provider);
      const targetDepth = isBottomDweller
        ? rawDepth
        : clamp(applyBand(rawDepth, band, energy, i), swim.floor, swim.ceiling);

      // Horizontal wander: each creature gets a stable phase from its index
      // so they move independently instead of as a block.
      //
      // MOVEMENT MUST NEVER STOP. Energy scales the amplitude and the speed
      // of the wander, but the wander itself is always present: a previous
      // version multiplied the wander RATE by energy, so an idle model
      // (energy 0) produced a nearly constant position and the creatures
      // froze solid. A living tank keeps moving even when nothing is
      // happening on that provider.
      const phase = (i * 2.399 + provider.length * 1.7) % (Math.PI * 2);
      // Integrate phase from dt. Multiplying an absolute epoch by a rate made
      // any telemetry-driven rate change jump to an unrelated point in the
      // sine wave. Codex fish are intentionally the slow cruisers.
      // Species have distinct locomotion. Fish cruise quickly across the
      // tank; jellyfish drift slowly; bottom dwellers scuttle in short,
      // deliberate passes. Previously every non-fish used the same faster
      // swimmer constants, so jellyfish matched or outran the fish.
      const angularSpeed = provider === "codex"
        ? 0.22 + energy * 0.18
        : provider === "minimax"
          ? 0.08 + energy * 0.08
          : isBottomDweller
            ? 0.13 + energy * 0.10
            : 0.12 + energy * 0.12;
      const wanderAmp = provider === "codex"
        ? 0.24 + energy * 0.06
        : isBottomDweller
          ? 0.30 + energy * 0.06
          : 0.22 + energy * 0.06;
      const wanderPhase = prev && Number.isFinite(prev.wanderPhase)
        ? prev.wanderPhase + dt * angularSpeed
        : phase;
      // Horizontal motion is the PRIMARY axis for a swimmer: a fish crosses
      // the tank left and right and barely bobs. The vertical component is
      // a slow secondary drift layered on top, so the motion reads as
      // "swimming across" rather than "bobbing in place".
      const drift = Math.sin(wanderPhase) * wanderAmp;
      const verticalDriftAmp = provider === "codex" ? 0.012 : 0.06;
      const verticalDrift = Math.sin(wanderPhase * 0.37 + 1.1) * verticalDriftAmp;
      const targetX = clamp(0.5 + drift, 0.08, 0.92);

      const depth = prev ? ease(prev.depth, targetDepth, 1 / config.smoothing, dt) : targetDepth;
      const x = prev ? ease(prev.x, targetX, 1 / config.smoothing, dt) : targetX;

      // Facing follows travel direction, and the SPRITE ART decides the
      // sign. The fish is drawn nose-LEFT (the generator's body runs
      // `0 = nose, 1 = tail root` from the left edge, and the forked tail
      // fin is the separate shape at the right), so a fish travelling
      // RIGHT must be mirrored (scaleX -1). Getting this backwards made
      // every fish swim backwards.
      const spriteFacesLeft = provider === "codex";
      let facing = prev ? prev.facing : 1;
      const dx = prev ? x - prev.x : 0;
      if (dx > 0.0004) facing = 1;
      else if (dx < -0.0004) facing = -1;
      // `facing` is the DIRECTION of travel (+1 = right). Convert it to the
      // horizontal scale that puts the sprite's nose that way.
      const scaleX = (spriteFacesLeft ? -facing : facing);

      // Vertical bob: the jellyfish pulses and the butterfly drifts, so
      // they move up and down a little as they travel. Bottom dwellers stay
      // grounded. The bob is layered on top of the eased depth.
      //
      // The bob CLOCK also has to keep running when idle, for the same
      // reason the wander does: energy scales the amplitude, never the
      // frequency.
      const bobPhase = prev ? prev.bobPhase + dt * (0.9 + energy * 1.4) : phase;
      let bob = 0;
      if (!isBottomDweller && posture !== "sleeping") {
        // The bob rides ON TOP of the slow vertical drift, and stays small:
        // a swimmer's primary motion is horizontal, so a big vertical
        // swing made the fish look like it was bobbing vertically.
        const bobAmp = (provider === "minimax" ? 0.040 : 0.018) * (0.55 + energy * 0.45);
        bob = Math.sin(bobPhase) * bobAmp + verticalDrift;
      }

      // A sleeping creature is dimmer and slightly smaller.
      const opacity = posture === "sleeping" ? 0.62 : posture === "tired" ? 0.82 : 1.0;
      const scale = posture === "sleeping" ? 0.9 : 1.0;

      const visualDepth = isBottomDweller
        ? clamp(depth + bob, 0, 0.26)
        : clamp(depth + bob, swim.floor, swim.ceiling);

      out.push({
        provider,
        index: i,
        posture,
        energy,
        // Keep swimmers inside their water territory after bobbing too. The
        // old clamp happened before the bob was added, allowing the jellyfish
        // to drift above the waterline and stick there.
        depth: visualDepth,
        x,
        frameStep: step,
        opacity,
        scale,
        facing,
        scaleX,
        wanderPhase,
        bobPhase,
        wakesLabel: "",
      });
    }
  }
  return out;
}

/**
 * Format the "wakes in Xh Ym" label for an exhausted quota.
 *
 * Takes a DURATION in seconds, not an absolute timestamp: the device cannot
 * compare a server timestamp against its own clock.
 */
export function wakesLabel(secondsRemaining: number): string {
  if (!(secondsRemaining > 0)) return "";
  const seconds = secondsRemaining;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `wakes in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `wakes in ${hours}h ${minutes % 60}m`;
  return `wakes in ${Math.ceil(hours / 24)}d`;
}

/** Distinguish longer-window exhaustion from a healthy session percentage. */
export function exhaustedQuotaLabel(weeklyRemaining: number, monthlyRemaining: number): string {
  const weeklyOut = weeklyRemaining === 0;
  const monthlyOut = monthlyRemaining === 0;
  if (weeklyOut && monthlyOut) return "W+M OUT";
  if (monthlyOut) return "MONTH OUT";
  if (weeklyOut) return "WEEK OUT";
  return "";
}

/**
 * Sprite name for a creature, given its posture.
 *
 * Returns the atlas NAME exactly as it appears in `creature-sprites.ts` --
 * the cooker bakes an atlas only when it sees that string as a literal, so
 * this must not build the name at runtime.
 */
export function spriteFor(creature: Creature): string {
  const base = PROVIDER_CREATURE[creature.provider];
  return creature.posture === "sleeping"
    ? CREATURE_SPRITES[`${base}Sleep` as CreatureSpriteKey]
    : CREATURE_SPRITES[base as CreatureSpriteKey];
}
