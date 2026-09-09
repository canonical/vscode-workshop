import * as vscode from 'vscode';

import { deepEqual } from './util/deepEqual';

/**
 * Polls `fn()` on a fixed interval and fires {@link onDidUpdate} when the
 * result changes (compared structurally with {@link deepEqual}). Fires
 * {@link onDidError} when `fn()` rejects.
 *
 * Polling only runs while at least one activation handle is outstanding.
 * Call {@link activate} to obtain a handle and dispose it when the consumer
 * no longer needs updates. The timer (plus an immediate first tick) starts
 * when the first handle is created and stops when the last is disposed.
 */
export class WorkshopPoller<T> implements vscode.Disposable {
  private readonly updateEmitter = new vscode.EventEmitter<T>();
  private readonly errorEmitter = new vscode.EventEmitter<Error>();

  /** Fired whenever `fn()` returns a result that differs from the last. */
  readonly onDidUpdate: vscode.Event<T> = this.updateEmitter.event;

  /** Fired whenever `fn()` rejects. */
  readonly onDidError: vscode.Event<Error> = this.errorEmitter.event;

  private readonly handles = new Set<vscode.Disposable>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastParsed: T | undefined;
  /**
   * Whether {@link lastParsed} reflects the latest tick. Cleared on a failed
   * tick (while the value itself is kept for consumers to keep showing) so
   * that the first successful tick after an error always fires
   * {@link onDidUpdate}, even if the data didn't change meanwhile.
   */
  private lastGood = false;
  private inFlight: Promise<void> | undefined;
  private queued: Promise<void> | undefined;

  /**
   * The most recently fetched value, or `undefined` before the first
   * successful poll. Kept across failed ticks: consumers showing this value
   * should keep it on screen through daemon blips rather than regressing to
   * an empty/loading state.
   */
  get lastValue(): T | undefined {
    return this.lastParsed;
  }

  constructor(
    private readonly fn: () => Promise<T>,
    private readonly intervalMs: number = 5_000,
  ) {}

  /**
   * Register interest in the polled data. The interval starts immediately on
   * the first call (with an initial tick) and stops when all handles are
   * disposed.
   *
   * The returned `Disposable` can be pushed into `context.subscriptions` or
   * disposed manually.
   */
  activate(): vscode.Disposable {
    const handle = new vscode.Disposable(() => {
      this.handles.delete(handle);
      if (this.handles.size === 0) {
        this.stop();
      }
    });
    this.handles.add(handle);
    if (this.handles.size === 1) {
      this.start();
    }
    return handle;
  }

  /**
   * Trigger an immediate poll outside of the regular interval. Useful for
   * manual refresh commands and post-action refreshes.
   *
   * A poll issued while a tick is already running is *not* dropped: it waits
   * for the running tick and then runs one fresh tick, so data mutated after
   * the running tick sampled it is still picked up. Any number of polls
   * issued during the same in-flight tick coalesce into that single
   * follow-up.
   */
  poll(): Promise<void> {
    if (this.inFlight === undefined) {
      return this.runTick();
    }
    this.queued ??= this.inFlight.then(() => {
      // Cleared as the follow-up *starts*: a poll arriving while the
      // follow-up runs must queue a new tick, not join the running one.
      this.queued = undefined;
      return this.runTick();
    });
    return this.queued;
  }

  private start(): void {
    void this.runTick();
    this.timer = setInterval(() => {
      // Interval ticks are pure freshness: skip when a tick is already
      // running or a follow-up is queued — the fresh data is coming anyway.
      if (this.inFlight === undefined && this.queued === undefined) {
        void this.runTick();
      }
    }, this.intervalMs);
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one tick, tracking it in {@link inFlight}. Never rejects. */
  private runTick(): Promise<void> {
    const tick = this.tick().finally(() => {
      if (this.inFlight === tick) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = tick;
    return tick;
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.fn();
      if (!this.lastGood || !deepEqual(result, this.lastParsed)) {
        this.lastParsed = result;
        this.lastGood = true;
        this.updateEmitter.fire(result);
      }
    } catch (err) {
      // Keep lastParsed — consumers keep showing the last good data — but
      // clear lastGood so recovery always fires onDidUpdate.
      this.lastGood = false;
      this.errorEmitter.fire(err instanceof Error ? err : new Error(String(err)));
    }
  }

  dispose(): void {
    this.stop();
    this.updateEmitter.dispose();
    this.errorEmitter.dispose();
  }
}
