/** Full preparation identity, including editable inputs. Stale work cannot lock or overwrite the editor. */
export class PreparationRequests {
  private revision = 0;
  private identity = "";
  busy = false;
  update(identity: string) {
    if (identity !== this.identity) {
      this.identity = identity;
      this.revision++;
      this.busy = false;
    }
  }
  begin(identity: string) {
    this.update(identity);
    this.busy = true;
    return ++this.revision;
  }
  accepts(revision: number) {
    return revision === this.revision;
  }
  finish(revision: number) {
    if (this.accepts(revision)) this.busy = false;
  }
  invalidate() {
    this.revision++;
    this.busy = false;
  }
}
