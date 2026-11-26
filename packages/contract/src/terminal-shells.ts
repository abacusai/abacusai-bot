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
  | "wsl"
  | "gitbash";

export interface TerminalShell {
  id: TerminalShellId;
  /** i18n key under `terminalShells`. */
  labelKey: string;
  /** Platforms the entry is offered on; `"all"` means every one. */
  platforms: readonly string[] | "all";
  /** Listed only on a machine that has it (an optional install), not greyed out. */
  whenPresent?: boolean;
}

/**
 * Windows only, apart from `system`.
 *
 * macOS and Linux have one answer to "which shell": the one the user set as
 * their login shell, which `$SHELL` names and which their dotfiles are written
 * for. Offering to open bash instead of their zsh is a menu nobody wanted in
 * front of a choice they already made. Windows is the case with a real
 * question behind it: cmd, PowerShell, and the POSIX shell this app ships.
 * So that is where the menu appears.
 */
export const TERMINAL_SHELLS: readonly TerminalShell[] = [
  { id: "system", labelKey: "system", platforms: "all" },
  { id: "cmd", labelKey: "cmd", platforms: ["win32"] },
  { id: "powershell", labelKey: "powershell", platforms: ["win32"] },
  { id: "pwsh", labelKey: "pwsh", platforms: ["win32"] },
  { id: "busybox", labelKey: "busybox", platforms: ["win32"] },
  { id: "wsl", labelKey: "wsl", platforms: ["win32"], whenPresent: true },
  {
    id: "gitbash",
    labelKey: "gitbash",
    platforms: ["win32"],
    whenPresent: true,
  },
];

export const DEFAULT_TERMINAL_SHELL: TerminalShellId = "system";

export const isTerminalShellId = (value: unknown): value is TerminalShellId =>
  TERMINAL_SHELLS.some((shell) => shell.id === value);

export const terminalShellsForPlatform = (platform: string): TerminalShell[] =>
  TERMINAL_SHELLS.filter(
    (shell) => shell.platforms === "all" || shell.platforms.includes(platform)
  );

/**
 * Whether a menu offers the shell: only one this machine can start. On
 * Windows "Default shell" is left out: it is the Command Prompt again under
 * another name, and PowerShell is the default there.
 */
export const terminalShellListed = (
  id: TerminalShellId,
  statuses: readonly TerminalShellStatus[] | undefined,
  platform: string
): boolean =>
  !(platform === "win32" && id === "system") &&
  statuses?.find((status) => status.id === id)?.available === true &&
  // BusyBox sh is the agent's own shell, unknown to people and its prompt
  // reads `\w $`: offered only when nothing else starts.
  (id !== "busybox" ||
    !statuses?.some(
      (status) =>
        status.available && status.id !== "busybox" && status.id !== "system"
    ));

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

/** A live terminal, as a question about ending it names it. */
export interface TerminalInUse {
  conversationKey: string;
  /** The window names it by its tab. */
  terminalId: string;
  /** What runs in place of the shell's prompt, if anything and if known. */
  program: string | null;
  /** The chat it belongs to; empty for a new chat. */
  chat: string;
}

/**
 * A start's error for a screen whose shell ended while it was away (its
 * workspace deleted and restored): not a failure, the tab starts a new one.
 */
export const TERMINAL_GENERATION_STALE = "generation-stale";
