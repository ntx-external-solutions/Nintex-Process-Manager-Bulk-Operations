/**
 * Whether a Process Manager call has been waiting long enough to say so (F7, R15).
 *
 * In R15 a tree read during cleanup hung for about 60 seconds, the tenant answered 500,
 * and the retry succeeded, while the page sat on "Deleting 2 of 2" the whole time. The
 * retry happens in the proxy (lib/pm/client.ts retries reads on a 5xx or a dropped
 * connection), inside the one request the browser made, so the browser cannot see the
 * 500 or the retry itself. What it can see is a call that has not answered: past
 * SLOW_AFTER_MS, the progress line says Process Manager is slow and that a failed read is
 * retried, and the note clears as soon as the call answers.
 *
 * No React here so it can be tested offline. The timers and the clock are injected.
 */

/** Longer than any read measured in the live rounds; short enough that a hang is named early. */
export const SLOW_AFTER_MS = 15_000;
/** How often the waiting time on screen moves. */
export const TICK_MS = 5_000;

export interface SlowStatus {
  /** Whole seconds the oldest call still in flight has been waiting. */
  seconds: number;
}

export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class SlowCalls {
  private readonly inFlight = new Map<number, number>();
  private readonly listeners = new Set<() => void>();
  private nextId = 0;
  private timer: unknown = null;
  private status: SlowStatus | null = null;

  private readonly clock: Clock;
  private readonly slowAfterMs: number;
  private readonly tickMs: number;

  constructor(clock: Clock = realClock, slowAfterMs = SLOW_AFTER_MS, tickMs = TICK_MS) {
    this.clock = clock;
    this.slowAfterMs = slowAfterMs;
    this.tickMs = tickMs;
  }

  /** Call when a request goes out; call what it returns when the request settles, either way. */
  begin(): () => void {
    const id = this.nextId++;
    this.inFlight.set(id, this.clock.now());
    if (this.timer === null) this.timer = this.clock.setInterval(() => this.update(), this.tickMs);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.inFlight.delete(id);
      if (this.inFlight.size === 0 && this.timer !== null) {
        this.clock.clearInterval(this.timer);
        this.timer = null;
      }
      this.update();
    };
  }

  /** The same object until it changes, as useSyncExternalStore needs. */
  snapshot = (): SlowStatus | null => this.status;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Re-reads the clock. The interval calls it; tests may too. */
  update(): void {
    let oldest: number | null = null;
    for (const started of this.inFlight.values()) if (oldest === null || started < oldest) oldest = started;
    const waited = oldest === null ? 0 : this.clock.now() - oldest;
    const next = oldest !== null && waited >= this.slowAfterMs ? { seconds: Math.floor(waited / 1000) } : null;
    if (next?.seconds === this.status?.seconds) return;
    this.status = next;
    for (const listener of this.listeners) listener();
  }
}

export function slowMessage(status: SlowStatus): string {
  return `Process Manager is slow to answer (${status.seconds}s so far). Still waiting, and a failed read is retried.`;
}

/** The one tracker every call through the proxy reports to (lib/ui/gateway.ts). */
export const slowCalls = new SlowCalls();
