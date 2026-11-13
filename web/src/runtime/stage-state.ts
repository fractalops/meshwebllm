/** One invited coordinator owns one generation at a time. Fail closed on replays. */
export class StageState {
  private session: string | null = null;
  private step = 0;
  readonly coordinator: string;
  constructor(coordinator: string) {
    this.coordinator = coordinator;
  }
  authorize(peer: string) {
    if (peer !== this.coordinator)
      throw new Error("This stage belongs to a different coordinator.");
  }
  begin(peer: string, id: string) {
    this.authorize(peer);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid generation ID.");
    if (this.session) throw new Error("A generation is already active.");
    this.session = id;
    this.step = 0;
  }
  next(peer: string, id: string, step: number) {
    this.authorize(peer);
    if (this.session !== id || step !== this.step)
      throw new Error("Out-of-order generation step.");
    this.step++;
  }
  end(peer: string, id: string) {
    this.authorize(peer);
    if (this.session !== id) throw new Error("Unknown generation.");
    this.session = null;
    this.step = 0;
  }
  clear() {
    this.session = null;
    this.step = 0;
  }
}
