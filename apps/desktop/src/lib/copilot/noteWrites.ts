/** Serialize app-owned note receipts. A late result never writes after a newer completed save. */
export class NoteWriteQueue {
  private pending = new Map<string, Promise<unknown>>();
  save(
    key: string,
    isCurrent: () => boolean,
    write: () => Promise<unknown>,
  ): Promise<boolean> {
    const next = (this.pending.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (!isCurrent()) return false;
        await write();
        return true;
      });
    this.pending.set(key, next);
    void next
      .finally(() => {
        if (this.pending.get(key) === next) this.pending.delete(key);
      })
      .catch(() => {});
    return next;
  }
}
export const derivedNoteWrites = new NoteWriteQueue();
