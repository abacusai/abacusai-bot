/**
 * What the user agreed to let a command do beyond the policy: read a hidden
 * credential store, write outside the workspace. Owned by the session that
 * showed the card and handed to the shell backend that runs the command, so
 * an approval never crosses sessions. Hosts are kept by the runtime, whose
 * proxy asks live; these are the things the OS refuses outright.
 */
import { isWithin } from "./secrets.js";

/** One thing the sandbox refused, as the card can show and the user can allow. */
export type Denial =
  | { kind: "read"; path: string }
  | { kind: "write"; path: string }
  | { kind: "host"; host: string; port: number };

/** The user's answer to a card listing denials. */
export type DenialDecision = {
  /** Allowed for one more run of the command. */
  once: Denial[];
  /** Allowed for the rest of the session. */
  session: Denial[];
};

/** Asked after a confined command failed; null when nothing may be allowed. */
export type DenialAsker = (
  command: string,
  denials: Denial[]
) => Promise<DenialDecision | null>;

class PathGrants {
  private readonly once = new Map<string, string[]>();
  private readonly session: string[] = [];

  get sessionPaths(): readonly string[] {
    return this.session;
  }

  isApprovedForSession(target: string): boolean {
    return this.session.some((allowed) => isWithin(target, allowed));
  }

  approveOnce(command: string, paths: readonly string[]): void {
    if (paths.length === 0) return;
    const merged = new Set([...(this.once.get(command) ?? []), ...paths]);
    this.once.set(command, [...merged]);
  }

  approveForSession(paths: readonly string[]): void {
    for (const target of paths) {
      if (!this.session.includes(target)) this.session.push(target);
    }
  }

  /** The one-shot grant, taken so it cannot be reused, plus the session's. */
  consume(command: string): string[] {
    const granted = this.once.get(command) ?? [];
    this.once.delete(command);

    return [...new Set([...granted, ...this.session])];
  }
}

export class SandboxApprovals {
  /** Hidden credential stores the user let a command read. */
  readonly reads = new PathGrants();
  /** Directories outside the workspace the user let a command write. */
  readonly writes = new PathGrants();
  /** Installed by the session; absent where nobody can answer a card. */
  askDenials: DenialAsker | null = null;

  /** Record a card's answer under the command it was shown for. */
  apply(command: string, decision: DenialDecision): void {
    for (const denial of decision.once) {
      if (denial.kind === "read")
        this.reads.approveOnce(command, [denial.path]);
      if (denial.kind === "write")
        this.writes.approveOnce(command, [denial.path]);
    }
    for (const denial of decision.session) {
      if (denial.kind === "read") this.reads.approveForSession([denial.path]);
      if (denial.kind === "write") this.writes.approveForSession([denial.path]);
    }
  }
}
