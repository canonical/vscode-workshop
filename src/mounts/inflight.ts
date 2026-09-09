/**
 * Tracks the panel's own in-flight operations that affect rendering. Pure
 * in-memory session state (nothing persisted), keyed by project/workshop.
 *
 * Only remounts mark a row pending: a pending row renders its switch
 * disabled, and the toggle is a live control that must never be disabled by
 * its own connect/disconnect operations.
 */
export class InflightTracker {
  /** `<projectId>/<workshop>` keys of running guided remounts. */
  private readonly guided = new Set<string>();
  /** Row ids being (plain-)remounted right now. */
  private readonly pendingRows = new Set<string>();

  beginGuidedRemount(projectId: string, workshop: string): void {
    this.guided.add(`${projectId}/${workshop}`);
  }

  endGuidedRemount(projectId: string, workshop: string): void {
    this.guided.delete(`${projectId}/${workshop}`);
  }

  isGuidedRemount(projectId: string, workshop: string): boolean {
    return this.guided.has(`${projectId}/${workshop}`);
  }

  beginRowPending(rowId: string): void {
    this.pendingRows.add(rowId);
  }

  endRowPending(rowId: string): void {
    this.pendingRows.delete(rowId);
  }

  pendingRowIds(): ReadonlySet<string> {
    return this.pendingRows;
  }
}
