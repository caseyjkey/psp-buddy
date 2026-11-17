import { describe, expect, test } from "bun:test";
import {
  agentRate,
  buildCreatures,
  DEPTH_BAND,
  exhaustedQuotaLabel,
  frameStepFor,
  populationFor,
  swimRangeFor,
  wakesLabel,
  type Provider,
  type ProviderTelemetry,
} from "./aquarium.ts";

function codex(tokensPerSecond: number): Record<Provider, ProviderTelemetry> {
  return {
    codex: {
      tokensPerSecond,
      tokensPerSecondPerAgent: tokensPerSecond,
      agentRates: [tokensPerSecond],
      quotaRemaining: 1,
      quotaResetsAt: 0,
      quotaResetsInSec: -1,
      weeklyRemaining: -1,
      monthlyRemaining: -1,
      online: true,
      sampledAt: 1,
      agentCount: 1,
    },
  } as Record<Provider, ProviderTelemetry>;
}

function codexWithAgents(
  tokensPerSecond: number,
  agentCount: number,
): Record<Provider, ProviderTelemetry> {
  return {
    codex: {
      tokensPerSecond,
      tokensPerSecondPerAgent: tokensPerSecond / Math.max(1, agentCount),
      agentRates: Array(agentCount).fill(tokensPerSecond / Math.max(1, agentCount)),
      quotaRemaining: 1,
      quotaResetsAt: 0,
      quotaResetsInSec: -1,
      weeklyRemaining: -1,
      monthlyRemaining: -1,
      online: true,
      sampledAt: 1,
      agentCount,
    },
  } as Record<Provider, ProviderTelemetry>;
}

describe("aquarium motion", () => {
  test("keeps atlas animation visibly alive at every energy level", () => {
    expect(frameStepFor(0)).toBe(5);
    expect(frameStepFor(0.5)).toBe(4);
    expect(frameStepFor(1)).toBe(2);
  });

  test("integrates fish wander without epoch/rate jumps", () => {
    const initial = buildCreatures(codex(0), [], 1)[0];
    const busy = buildCreatures(codex(120), [initial], 1)[0];
    const idle = buildCreatures(codex(0), [busy], 1)[0];

    expect(busy.wanderPhase - initial.wanderPhase).toBeCloseTo(0.40, 6);
    expect(idle.wanderPhase - busy.wanderPhase).toBeCloseTo(0.22, 6);
    expect(Math.abs(busy.x - initial.x)).toBeLessThan(0.08);
    expect(Math.abs(idle.x - busy.x)).toBeLessThan(0.08);
  });

  test("each creature moves at its own share of the model's token rate", () => {
    // Two agents on one model, 60 tok/s between them: each creature is
    // working at 30 tok/s, so each moves at half the provider's energy.
    const one = buildCreatures(codexWithAgents(60, 1), [], 1)[0];
    const two = buildCreatures(codexWithAgents(60, 2), [], 1)[0];

    expect(agentRate(codexWithAgents(60, 2).codex)).toBe(30);
    expect(two.energy).toBeCloseTo(one.energy / 2, 6);
  });

  test("different agent rates produce different creature speeds", () => {
    const telemetry = codexWithAgents(60, 2);
    telemetry.codex.agentRates = [10, 50];
    const creatures = buildCreatures(telemetry, [], 1);
    expect(creatures[0].energy).toBeLessThan(creatures[1].energy);
    expect(creatures[0].frameStep).toBeGreaterThan(creatures[1].frameStep);
  });

  test("zero active agents means zero creatures", () => {
    expect(populationFor(codexWithAgents(0, 0).codex)).toBe(0);
  });

  test("the wake label counts a DURATION, not an absolute timestamp", () => {
    // The PSP's Date.now() has no usable epoch, so the label is driven by
    // a server-measured number of seconds remaining.
    expect(wakesLabel(90)).toBe("wakes in 2m");
    expect(wakesLabel(3600)).toBe("wakes in 1h 0m");
    expect(wakesLabel(3600 * 30)).toBe("wakes in 30h 0m");
    expect(wakesLabel(0)).toBe("");
    expect(wakesLabel(-1)).toBe("");
  });

  test("names exhausted weekly/monthly quota instead of implying session is healthy", () => {
    expect(exhaustedQuotaLabel(0, -1)).toBe("WEEK OUT");
    expect(exhaustedQuotaLabel(35, 0)).toBe("MONTH OUT");
    expect(exhaustedQuotaLabel(0, 0)).toBe("W+M OUT");
    expect(exhaustedQuotaLabel(35, -1)).toBe("");
  });

  test("a swimmer's vertical range is personal, not the shared band edge", () => {
    const band = DEPTH_BAND.minimax;
    const a = swimRangeFor(band, 0, "minimax");
    const b = swimRangeFor(band, 1, "minimax");

    // Both stay inside the band...
    expect(a.floor).toBeGreaterThanOrEqual(band.low);
    expect(a.ceiling).toBeLessThanOrEqual(band.high);
    expect(b.floor).toBeGreaterThanOrEqual(band.low);
    expect(b.ceiling).toBeLessThanOrEqual(band.high);
    // ...but they are not the same range, so a group does not share one
    // invisible floor and ceiling.
    expect(Math.abs(a.floor - b.floor)).toBeGreaterThan(0);
  });

  test("a fish travelling right is mirrored, because the art faces left", () => {
    // The atlas is drawn nose-left (the forked tail fin is the separate
    // shape on the right), so travelling right needs scaleX -1 and
    // travelling left needs scaleX +1.
    //
    // The wander pulls the creature back toward its own target, so the
    // travel direction is set by the previous position, not by nudging
    // the current one.
    const start = buildCreatures(codex(120), [], 0)[0];
    const target = buildCreatures(codex(120), [start], 1)[0];
    const travelledRight = buildCreatures(codex(120), [{ ...start, x: target.x - 0.05 }], 0.5)[0];
    const travelledLeft = buildCreatures(codex(120), [{ ...start, x: target.x + 0.05 }], 0.5)[0];

    expect(travelledRight.facing).toBe(1);
    expect(travelledRight.scaleX).toBe(-1);
    expect(travelledLeft.facing).toBe(-1);
    expect(travelledLeft.scaleX).toBe(1);
  });

  test("fish cruise faster than jellyfish and crabs stay on the floor", () => {
    const fishTelemetry = { codex: { ...codex(60).codex, agentCount: 1, agentRates: [60] } } as Record<Provider, ProviderTelemetry>;
    const jellyTelemetry = { minimax: { ...codex(60).codex, agentCount: 1, agentRates: [60] } } as Record<Provider, ProviderTelemetry>;
    const fishStart = buildCreatures(fishTelemetry, [], 0)[0];
    const fish = buildCreatures(fishTelemetry, [fishStart], 1)[0];
    const jellyStart = buildCreatures(jellyTelemetry, [], 0)[0];
    const jelly = buildCreatures(jellyTelemetry, [jellyStart], 1)[0];
    const crab = buildCreatures({
      "opencode-go": { ...codex(60).codex, agentCount: 1, agentRates: [60] },
    } as Record<Provider, ProviderTelemetry>, [], 1)[0];

    expect(fish.wanderPhase - fishStart.wanderPhase).toBeCloseTo(0.31, 6);
    expect(jelly.wanderPhase - jellyStart.wanderPhase).toBeCloseTo(0.12, 6);
    expect(fish.wanderPhase - fishStart.wanderPhase)
      .toBeGreaterThan(jelly.wanderPhase - jellyStart.wanderPhase);
    expect(crab.depth).toBe(0);
  });

  test("bottom dwellers scuttle across the floor and keep their legs animated while idle", () => {
    const telemetry = {
      muse: { ...codex(0).codex, agentCount: 1, agentRates: [0] },
      "opencode-go": { ...codex(0).codex, agentCount: 1, agentRates: [0] },
    } as Record<Provider, ProviderTelemetry>;
    const first = buildCreatures(telemetry, [], 0);
    const next = buildCreatures(telemetry, first, 1);

    expect(first).toHaveLength(2);
    expect(next.every((c) => c.depth === 0)).toBe(true);
    expect(next.every((c) => c.frameStep === 2)).toBe(true);
    expect(next.every((c, i) => Math.abs(c.x - first[i].x) > 0.01)).toBe(true);
  });
});
