/**
 * Shells the terminal panel can open. The agent's `bash` tool already runs
 * under busybox-w32 on Windows (packages/agent/src/posix-shell.ts); this
 * offers the same shell to the person at the keyboard, next to the two
 * Windows ships with, so a POSIX one-liner from the chat can be pasted into
 * the panel and behave.
 *
 * The roster is platform-filtered rather than probed here: what exists on the
 * machine is main's answer (services/workspace/terminal-shells.ts), because
 * only main can look at the disk.
 */

export type TerminalShellId =
  | "system"
  | "cmd"
  | "powershell"
  | "pwsh"
  | "busybox"
  | "bash"
  | "zsh"
  | "fish"
  | "sh";

export interface TerminalShell {
  id: TerminalShellId;
  /** i18n key under `terminalShells`. */
  labelKey: string;
  /** Platforms the entry is offered on; `"all"` means every one. */
  platforms: readonly NodeJS.Platform[] | "all";
}

/**
 * `system` leads: it is what the panel opened before there was a choice, and
 * it stays the fallback when a stored id names something no longer installed.
 */
export const TERMINAL_SHELLS: readonly TerminalShell[] = [
  { id: "system", labelKey: "system", platforms: "all" },
  { id: "cmd", labelKey: "cmd", platforms: ["win32"] },
  { id: "powershell", labelKey: "powershell", platforms: ["win32"] },
  { id: "pwsh", labelKey: "pwsh", platforms: ["win32"] },
  { id: "busybox", labelKey: "busybox", platforms: ["win32"] },
  { id: "bash", labelKey: "bash", platforms: ["darwin", "linux"] },
  { id: "zsh", labelKey: "zsh", platforms: ["darwin", "linux"] },
  { id: "fish", labelKey: "fish", platforms: ["darwin", "linux"] },
  { id: "sh", labelKey: "sh", platforms: ["darwin", "linux"] },
];

export const DEFAULT_TERMINAL_SHELL: TerminalShellId = "system";

export const isTerminalShellId = (value: unknown): value is TerminalShellId =>
  TERMINAL_SHELLS.some((shell) => shell.id === value);

export const terminalShellsForPlatform = (
  platform: NodeJS.Platform
): TerminalShell[] =>
  TERMINAL_SHELLS.filter(
    (shell) => shell.platforms === "all" || shell.platforms.includes(platform)
  );

export interface TerminalShellStatus {
  id: TerminalShellId;
  /** False when nothing on this machine answers to it; the row is then unpickable. */
  available: boolean;
  /**
   * What would be spawned, when it is already known. Absent for busybox until
   * it is materialised, which only a spawn does.
   */
  path?: string;
}

/** Chosen vs. what a new terminal actually gets, plus why the rest are out. */
export interface TerminalShellState {
  selected: TerminalShellId;
  /** Differs from `selected` when the stored shell stopped being usable. */
  effective: TerminalShellId;
  statuses: TerminalShellStatus[];
}
