/**
 * Per-workshop operation queue. The daemon accepts ONE change per workshop
 * at a time and rejects overlap with a change-conflict, so every daemon
 * mutation this feature issues — toggle connects/disconnects, Connect to
 * SDK, plain remounts, and the guided stop→remount→start as one unit —
 * runs through a per-workshop promise chain in click order. A rejected
 * operation propagates to its caller but never breaks the chain; external
 * conflicts (CLI refresh, another window) still surface through the normal
 * failure path.
 */
export class WorkshopOperationQueue {
  /** Chain tail per `<projectId>/<workshop>`; stored settled-safe. */
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(projectId: string, workshop: string, op: () => Promise<T>): Promise<T> {
    const key = `${projectId}/${workshop}`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    // The stored tail never rejects, so chaining with .then is safe.
    const result = previous.then(op);
    this.chains.set(key, result.then(
      () => undefined,
      () => undefined,
    ));
    return result;
  }
}
