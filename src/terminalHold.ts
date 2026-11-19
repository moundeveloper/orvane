// Output for a terminal pane nobody can see: held, then written in one go
// when the pane is seen again. Drawing text nobody sees costs the window time
// on every chunk. A large backlog is written early so held output stays
// bounded; nothing is ever dropped.
export const HOLD_LIMIT = 256 * 1024;
export class OutputHold {
  private held = "";
  private shown = true;
  constructor(
    private write: (data: string) => void,
    private limit = HOLD_LIMIT,
  ) {}
  output(data: string) {
    if (this.shown) this.write(data);
    else if ((this.held += data).length > this.limit) this.release();
  }
  /** On screen again (true) or gone off screen (false). */
  visible(shown: boolean) {
    this.shown = shown;
    if (shown) this.release();
  }
  /** Write whatever is held now (before exit messages, clear, find, remount). */
  release() {
    const data = this.held;
    this.held = "";
    if (data) this.write(data);
  }
  /** A full replay replaces everything held. */
  discard() {
    this.held = "";
  }
}
