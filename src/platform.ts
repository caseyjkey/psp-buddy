import { getOps } from "@pocketjs/framework/host";

export interface SystemSnapshot {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  epoch: number;
  battery: number;
  batteryMinutes: number;
  charging: boolean;
  powerOnline: boolean;
}

const FALLBACK: SystemSnapshot = {
  year: 0,
  month: 0,
  day: 0,
  hour: 0,
  minute: 0,
  second: 0,
  epoch: 0,
  battery: -1,
  batteryMinutes: -1,
  charging: false,
  powerOnline: false,
};

export function systemSnapshot(): SystemSnapshot {
  const raw = getOps().systemSnapshot?.();
  if (!raw) return FALLBACK;
  try {
    return { ...FALLBACK, ...(JSON.parse(raw) as Partial<SystemSnapshot>) };
  } catch {
    return FALLBACK;
  }
}

export function readState<T>(): T | undefined {
  const raw = getOps().persistRead?.();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function writeState(value: unknown): boolean {
  return getOps().persistWrite?.(JSON.stringify(value)) ?? false;
}

export function readBuddySnapshot(): unknown {
  const raw = getOps().buddySnapshot?.();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Keep both the PSP display and automatic suspend timer alive for this frame. */
export function keepAwakeTick(): void {
  getOps().keepAwakeTick?.();
}
