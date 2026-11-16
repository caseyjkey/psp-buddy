export type BuddyMode = "thriving" | "waiting" | "napping" | "hibernating" | "offline";

export interface BuddySnapshot {
  version: 1;
  mode: BuddyMode;
  message: string;
  sessionRemaining: number;
  sessionResetsAt: number;
  weeklyRemaining: number;
  wakesAt: number;
  sampledAt: number;
}

export const OFFLINE_STATE: BuddySnapshot = {
  version: 1,
  mode: "offline",
  message: "CONNECTING TO GILBERT",
  sessionRemaining: 0,
  sessionResetsAt: 0,
  weeklyRemaining: 0,
  wakesAt: 0,
  sampledAt: 0,
};

const MODES = new Set<BuddyMode>(["thriving", "waiting", "napping", "hibernating", "offline"]);

function percent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : 0;
}

function epoch(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function normalizeSnapshot(value: unknown): BuddySnapshot {
  if (!value || typeof value !== "object") return OFFLINE_STATE;
  const raw = value as Partial<BuddySnapshot>;
  const mode = MODES.has(raw.mode as BuddyMode) ? raw.mode as BuddyMode : "offline";
  return {
    version: 1,
    mode,
    message: typeof raw.message === "string" ? raw.message.slice(0, 48) : OFFLINE_STATE.message,
    sessionRemaining: percent(raw.sessionRemaining),
    sessionResetsAt: epoch(raw.sessionResetsAt),
    weeklyRemaining: percent(raw.weeklyRemaining),
    wakesAt: epoch(raw.wakesAt),
    sampledAt: epoch(raw.sampledAt),
  };
}

export function appearance(mode: BuddyMode): {
  label: string;
  eyes: string;
  mouth: string;
  color: string;
  backdrop: string;
} {
  if (mode === "thriving") {
    return { label: "THRIVING", eyes: "^  ^", mouth: "\\___/", color: "#34d399", backdrop: "#064e3b" };
  }
  if (mode === "napping") {
    return { label: "POWER NAP", eyes: "-  -", mouth: "___", color: "#a78bfa", backdrop: "#312e81" };
  }
  if (mode === "hibernating") {
    return { label: "IN THE CAVE", eyes: "-  -", mouth: "zzz", color: "#f59e0b", backdrop: "#3f2a16" };
  }
  if (mode === "waiting") {
    return { label: "READY", eyes: "o  o", mouth: "___", color: "#818cf8", backdrop: "#1e1b4b" };
  }
  return { label: "OFFLINE", eyes: "x  x", mouth: "---", color: "#94a3b8", backdrop: "#1f2937" };
}

function secondsUntil(snapshot: BuddySnapshot, target: number, elapsedSinceSample: number): number {
  if (target <= 0 || snapshot.sampledAt <= 0) return 0;
  return target - snapshot.sampledAt - Math.max(0, Math.floor(elapsedSinceSample));
}

export function secondsOfDay(hour: number, minute: number, second: number): number {
  return hour * 3600 + minute * 60 + second;
}

export function elapsedClockSeconds(start: number, current: number): number {
  return ((current - start) % 86_400 + 86_400) % 86_400;
}

export function wakeLabel(snapshot: BuddySnapshot, elapsedSinceSample: number): string {
  const seconds = secondsUntil(snapshot, snapshot.wakesAt, elapsedSinceSample);
  if (seconds <= 0) return "";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `wakes in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `wakes in ${hours}h`;
  return `wakes in ${Math.ceil(hours / 24)}d`;
}

export function sessionResetLabel(snapshot: BuddySnapshot, elapsedSinceSample: number): string {
  if (snapshot.sessionResetsAt <= 0 || snapshot.sampledAt <= 0) return "RESET --";
  const seconds = secondsUntil(snapshot, snapshot.sessionResetsAt, elapsedSinceSample);
  if (seconds <= 0) return "RESET SOON";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `RESET IN ${minutes}M`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `RESET IN ${hours}H ${remainder}M`;
}

export function sessionResetClockLabel(
  snapshot: BuddySnapshot,
  elapsedSinceSample: number,
  hour: number,
  minute: number,
  second: number,
): string {
  if (snapshot.sessionResetsAt <= 0 || snapshot.sampledAt <= 0) return "AT --:--";
  const secondsToday = secondsOfDay(hour, minute, second);
  const remaining = secondsUntil(snapshot, snapshot.sessionResetsAt, elapsedSinceSample);
  const target = ((secondsToday + Math.max(0, remaining)) % 86_400 + 86_400) % 86_400;
  const targetHour = Math.floor(target / 3600);
  const targetMinute = Math.floor((target % 3600) / 60);
  const two = (value: number) => value < 10 ? `0${value}` : `${value}`;
  return `AT ${two(targetHour)}:${two(targetMinute)}`;
}
