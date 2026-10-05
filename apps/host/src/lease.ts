/** Activity and busy state the pod's idle reaper reads from /healthz. */
export class HostLease {
  constructor(private readonly activeRuns: () => boolean) {}
  lastActivityAt = Date.now();
  private terminalOutputAt = 0;
  activity(): void {
    this.lastActivityAt = Date.now();
  }
  terminalOutput(): void {
    this.terminalOutputAt = Date.now();
  }
  get busy(): boolean {
    return this.activeRuns() || Date.now() - this.terminalOutputAt < 60_000;
  }
}
