/** A synchronous lock prevents rapid events and stale animation completions. */
export class BookActionGate {
  private revision = 0;
  private active = false;
  begin(): number | undefined {
    if (this.active) return;
    this.active = true;
    return ++this.revision;
  }
  current(ticket: number): boolean {
    return this.active && this.revision === ticket;
  }
  finish(ticket: number): boolean {
    if (!this.current(ticket)) return false;
    this.active = false;
    return true;
  }
  cancel(): void {
    this.revision++;
    this.active = false;
  }
}
