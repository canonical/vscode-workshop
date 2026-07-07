import * as vscode from 'vscode';

/**
 * Polls `fn()` on a fixed interval and fires {@link onDidUpdate} when the
 * result changes (compared by JSON-serialised deep equality). Fires
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
  private lastJson: string | undefined;
  private inFlight = false;

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
   * manual refresh commands.
   */
  async poll(): Promise<void> {
    await this.tick();
  }

  private start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const result = await this.fn();
      const json = JSON.stringify(result);
      if (json !== this.lastJson) {
        this.lastJson = json;
        this.updateEmitter.fire(result);
      }
    } catch (err) {
      this.lastJson = undefined; // reset so recovery always fires onDidUpdate
      this.errorEmitter.fire(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.stop();
    this.updateEmitter.dispose();
    this.errorEmitter.dispose();
  }
}
