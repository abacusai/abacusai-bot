import { ShieldOff, X } from "lucide-react";
import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { SandboxStatus } from "#shared/contracts";

const DISMISSED_KEY = "sandbox-notice-dismissed";

const readDismissed = (): boolean => {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * Shown while this session's shell commands run with no kernel sandbox: the
 * machine has no backend, the backend could not start, or the toggle is off.
 * Commands still run, so the user should know what that means. Dismissable
 * for the machine, since the reason rarely changes between sessions.
 */
export const SandboxNotice = ({
  sandbox,
}: {
  sandbox: SandboxStatus | null | undefined;
}): JSX.Element | null => {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(readDismissed);

  if (sandbox == null || sandbox.active || dismissed) return null;

  return (
    <div
      data-id="sandbox-notice"
      role="status"
      className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300"
    >
      <ShieldOff className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {t("sandboxNotice.body")}
        {sandbox.reason != null && sandbox.reason.length > 0 && (
          <span className="opacity-80"> ({sandbox.reason})</span>
        )}
      </span>
      <button
        type="button"
        data-id="sandbox-notice-dismiss"
        aria-label={t("sandboxNotice.dismiss")}
        className="shrink-0 rounded p-0.5 hover:bg-amber-500/20"
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED_KEY, "1");
          } catch {
            // Best effort; the notice comes back next launch.
          }
          setDismissed(true);
        }}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
};
