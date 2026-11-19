/**
 * The one place a quit the user asks for meets running work. Each way the
 * user quits (closing the window on Windows/Linux, Quit in the menu or its
 * shortcut, the app's own Restart) calls `request()`: with work running the
 * user chooses Wait (the app quits by itself once the work is done), Quit
 * anyway, or neither; idle, the app quits at once.
 *
 * Quits the user did not ask for here (an OS shutdown or logout, a signal, an
 * update's install, a crash) never come through `request()` and are never
 * held: they reach `before-quit`, which calls `quitStarted()`.
 *
 * The main window asks in its own dialog and answers `shown`; a window that
 * does not (hung, crashed, an older renderer) gets the native dialog instead.
 */
import type {
  QuitGuardAnswer,
  QuitGuardState,
  QuitGuardWork,
} from "@abacus-ai/contract/contract/system";

type Choice = Exclude<QuitGuardAnswer, "shown">;

export interface QuitGuardDeps {
  /** The running work a quit would stop; empty when there is none. */
  work(): QuitGuardWork[];
  /** Tell the main window the new state. */
  publish(state: QuitGuardState): void;
  /** Bring the main window up (it may be hidden or minimized). */
  reveal(): void;
  /** The native dialog, for a window that did not show its own. */
  askNatively(work: QuitGuardWork[]): Promise<Choice>;
  /** The quit itself (`app.quit()`). */
  quit(): void;
  /** A quit the user called off: anything it was for is off too. */
  onCancelled?(): void;
  log(line: string): void;
  /** How long the window has to answer `shown`. */
  shownTimeoutMs?: number;
  /** How often an open question or a wait looks at the work again. */
  pollMs?: number;
}

export interface QuitGuard {
  /** The user asked to quit: quit now, or ask first when work runs. */
  request(): void;
  /** True when `request()` now would ask. */
  wouldAsk(): boolean;
  /** A quit is underway (`before-quit`): drop any question or wait. */
  quitStarted(): void;
  /** The OS is going down: from now on every request quits at once. */
  release(reason: string): void;
  state(): QuitGuardState;
  answer(answer: QuitGuardAnswer): void;
}

const sameWork = (a: QuitGuardWork[], b: QuitGuardWork[]): boolean =>
  a.length === b.length &&
  a.every(
    (item, i) =>
      item.sessionId === b[i]?.sessionId && item.label === b[i]?.label
  );

export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  const shownTimeoutMs = deps.shownTimeoutMs ?? 1_500;
  const pollMs = deps.pollMs ?? 1_000;
  let released = false;
  let current: QuitGuardState = { phase: "idle" };
  /** Bumped per question, so a late answer to an old one is dropped. */
  let question = 0;
  let shownTimer: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let waitStartedAt = 0;

  const set = (next: QuitGuardState): void => {
    current = next;
    deps.publish(next);
  };

  const stopTimers = (): void => {
    if (shownTimer != null) clearTimeout(shownTimer);
    if (poll != null) clearInterval(poll);
    shownTimer = null;
    poll = null;
  };

  const settle = (reason: string): void => {
    stopTimers();
    question++;
    deps.log(`[quit-guard] ${reason}`);
    if (current.phase !== "idle") set({ phase: "idle" });
  };

  const release = (reason: string): void => {
    if (released) return;
    released = true;
    settle(`released: ${reason}`);
  };

  /** The work ended under an open question or a wait: quit as asked. */
  const watch = (): void => {
    if (poll != null) clearInterval(poll);
    poll = setInterval(() => {
      if (current.phase === "idle") return;
      const work = deps.work();
      if (work.length === 0) {
        const seconds = Math.round((Date.now() - waitStartedAt) / 1000);
        settle(
          current.phase === "waiting"
            ? `the work finished after a ${seconds}s wait; quitting`
            : "the work finished while the question was open; quitting"
        );
        deps.quit();
        return;
      }
      if (!sameWork(work, current.work)) set({ phase: current.phase, work });
    }, pollMs);
    poll.unref?.();
  };

  const ask = (work: QuitGuardWork[]): void => {
    const asked = ++question;
    deps.log(`[quit-guard] asking: ${work.length} running`);
    set({ phase: "asking", work });
    deps.reveal();
    watch();
    if (shownTimer != null) clearTimeout(shownTimer);
    shownTimer = setTimeout(() => {
      shownTimer = null;
      if (asked !== question || current.phase !== "asking") return;
      deps.log(
        "[quit-guard] the window did not show the question; asking natively"
      );
      void deps.askNatively(current.work).then(
        (choice) => {
          if (asked === question && current.phase === "asking") answer(choice);
        },
        (error: unknown) =>
          deps.log(`[quit-guard] native dialog failed: ${String(error)}`)
      );
    }, shownTimeoutMs);
  };

  const answer = (choice: QuitGuardAnswer): void => {
    if (released) return;
    if (choice === "shown") {
      if (current.phase === "asking" && shownTimer != null) {
        clearTimeout(shownTimer);
        shownTimer = null;
      }
      return;
    }
    // Only an open question takes Wait or Quit anyway; cancel ends either.
    if (
      current.phase === "idle" ||
      (choice !== "cancel" && current.phase !== "asking")
    )
      return;
    question++;
    deps.log(`[quit-guard] answer: ${choice}`);
    if (choice === "quit") {
      settle("quitting anyway");
      deps.quit();
      return;
    }
    if (choice === "wait") {
      waitStartedAt = Date.now();
      set({ phase: "waiting", work: current.work });
      watch();
      return;
    }
    stopTimers();
    set({ phase: "idle" });
    deps.onCancelled?.();
  };

  return {
    request() {
      if (current.phase === "asking") {
        deps.reveal();
        return;
      }
      const work = released ? [] : deps.work();
      if (work.length === 0) {
        deps.quit();
        return;
      }
      // A quit during a wait asks again: the user may now want Quit anyway.
      ask(work);
    },
    wouldAsk: () => !released && deps.work().length > 0,
    quitStarted() {
      if (current.phase !== "idle") settle("a quit started");
    },
    release,
    state: () => current,
    answer,
  };
}
