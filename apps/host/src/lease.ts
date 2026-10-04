export class HostLease {
  constructor(private readonly activeRuns: () => boolean = () => false) {}
  lastActivityAt = Date.now();
  private terminalOutputAt = 0;
  private readonly runs = new Set<string>();
  activity(): void {
    this.lastActivityAt = Date.now();
  }
  terminalOutput(): void {
    this.terminalOutputAt = Date.now();
  }
  run(id: string, active: boolean): void {
    if (active) this.runs.add(id);
    else this.runs.delete(id);
  }
  get busy(): boolean {
    return (
      this.activeRuns() ||
      this.runs.size > 0 ||
      Date.now() - this.terminalOutputAt < 60_000
    );
  }
}
