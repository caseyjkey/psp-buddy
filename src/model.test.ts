import { describe, expect, test } from "bun:test";
import {
  appearance,
  elapsedClockSeconds,
  normalizeSnapshot,
  sessionResetClockLabel,
  sessionResetLabel,
  wakeLabel,
} from "./model.ts";

describe("Token Monitor buddy state", () => {
  test("normalizes and bounds bridge payloads", () => {
    expect(normalizeSnapshot({
      mode: "thriving",
      message: "TOKENS!",
      sessionRemaining: 103,
      sessionResetsAt: 4_700.9,
      weeklyRemaining: 46.4,
      wakesAt: -1,
      sampledAt: 123.9,
    })).toEqual({
      version: 1,
      mode: "thriving",
      message: "TOKENS!",
      sessionRemaining: 100,
      sessionResetsAt: 4_700,
      weeklyRemaining: 46,
      wakesAt: 0,
      sampledAt: 123,
    });
  });

  test("falls back safely for malformed bridge data", () => {
    const state = normalizeSnapshot({ mode: "unknown", message: 12 });
    expect(state.mode).toBe("offline");
    expect(state.message).toBe("CONNECTING TO GILBERT");
  });

  test("maps subscription states to distinct scenes", () => {
    expect(appearance("napping").label).toBe("POWER NAP");
    expect(appearance("hibernating").label).toBe("IN THE CAVE");
    expect(appearance("thriving").label).toBe("THRIVING");
  });

  test("formats reset countdowns", () => {
    const base = normalizeSnapshot({ mode: "napping", sampledAt: 1_000, wakesAt: 4_700 });
    expect(wakeLabel(base, 0)).toBe("wakes in 2h");
  });

  test("formats the rolling 5-hour reset from the bridge sample time", () => {
    const base = normalizeSnapshot({ mode: "thriving", sampledAt: 1_000, sessionResetsAt: 17_920 });
    expect(sessionResetLabel(base, 0)).toBe("RESET IN 4H 42M");
    expect(sessionResetClockLabel(base, 0, 6, 0, 0)).toBe("AT 10:42");
    expect(sessionResetLabel(base, 16_920)).toBe("RESET SOON");
  });

  test("tracks elapsed PSP wall-clock time across midnight without using its epoch", () => {
    expect(elapsedClockSeconds(23 * 3600 + 59 * 60 + 50, 10)).toBe(20);
    const base = normalizeSnapshot({ mode: "thriving", sampledAt: 1_000, sessionResetsAt: 4_700 });
    expect(sessionResetLabel(base, 100)).toBe("RESET IN 1H 0M");
    expect(sessionResetClockLabel(base, 100, 23, 59, 50)).toBe("AT 00:59");
  });
});
