/**
 * Connects owned by their rows, never by the page: a sign-in or connect left
 * open in the browser waits on its own row ("Waiting for sign-in…" with a
 * Cancel), while Continue, navigation and every other row stay usable. Each
 * start or Cancel supersedes the row's earlier attempt, whose late answer is
 * then ignored; a failure stays on the row until its next start.
 */
import { useEffect, useRef, useState } from "react";

import { errorText } from "#renderer/lib/use-app-context";

/** How a row's wait ended. A cancelled one is not a failure. */
export type RowConnectOutcome =
  | { ok: true }
  | { ok: false; error: string; cancelled?: boolean };

export interface RowConnect {
  /** The wait itself, started inside the click. A rejection is a failure. */
  run(): Promise<RowConnectOutcome>;
  /** Cancel pressed: also drop the wait where it runs (the host's listener). */
  cancel?(): void;
  /** The page left while waiting; nothing when the caller's own leave handles it. */
  leave?(): void;
  /** Connected: re-read what shows it; the row waits on the read. */
  connected?(): Promise<unknown>;
}

type RowState = { waiting: true } | { waiting: false; error: string };

export const useRowConnects = () => {
  const [rows, setRows] = useState<Readonly<Record<string, RowState>>>({});
  const attempts = useRef(
    new Map<string, { token: number; row: RowConnect }>()
  );
  const serial = useRef(0);
  const put = (key: string, state: RowState | null) =>
    setRows((current) => {
      const next = { ...current };
      if (state == null) delete next[key];
      else next[key] = state;
      return next;
    });
  const current = (key: string, token: number) =>
    attempts.current.get(key)?.token === token;
  useEffect(() => {
    const pending = attempts.current;
    return () => {
      for (const { row } of pending.values()) row.leave?.();
      pending.clear();
    };
  }, []);
  const start = (key: string, row: RowConnect): void => {
    const token = ++serial.current;
    attempts.current.set(key, { token, row });
    put(key, { waiting: true });
    // Run in the click itself (a tab may open there); a throw is a failure.
    void new Promise<RowConnectOutcome>((resolve) => resolve(row.run()))
      .catch((error: unknown): RowConnectOutcome => ({
        ok: false,
        error: errorText(error),
      }))
      .then(async (outcome) => {
        // A failed re-read leaves the row to the next one; the connect stands.
        if (outcome.ok && current(key, token))
          await row.connected?.().catch(() => undefined);
        if (!current(key, token)) return;
        attempts.current.delete(key);
        put(
          key,
          outcome.ok || outcome.cancelled === true
            ? null
            : { waiting: false, error: outcome.error }
        );
      });
  };
  const cancel = (key: string): void => {
    const attempt = attempts.current.get(key);
    if (attempt == null) return;
    attempts.current.delete(key);
    put(key, null);
    attempt.row.cancel?.();
  };
  return {
    start,
    cancel,
    waiting: (key: string): boolean => rows[key]?.waiting === true,
    /** The row's last failure, the host's code or text (see `connectErrorText`). */
    error: (key: string): string | null => {
      const row = rows[key];
      return row != null && !row.waiting ? row.error : null;
    },
  };
};
