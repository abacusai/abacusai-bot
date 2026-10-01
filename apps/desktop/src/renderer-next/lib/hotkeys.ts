/**
 * `useAppHotkey` (spec 01 §7.9): every app binding goes through it, so every
 * feature cancels and guards the same way. It lives in `lib` because
 * features may not import each other (spec 02 R2-T30); the shell re-exports
 * it with the app's own bindings.
 *
 * The provider (`AppHotkeysProvider`, shell) turns the library's own
 * preventDefault/stopPropagation off, because it cancels *before* the
 * callback: this wrapper decides, so a rich-text target keeps native Mod+B
 * (bold) when `guardRichText` is set.
 */
import { useHotkey } from "@tanstack/react-hotkeys";
import { useContext } from "react";

import { ActionBindingsContext } from "./keyboard/action-bindings";

/** A contenteditable target, or one inside `[data-hotkeys="text"]`. */
const isRichTextTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (element == null || typeof element.closest !== "function") return false;
  if (element.isContentEditable) return true;
  // jsdom has no isContentEditable; the attribute decides there.
  const editable = element.closest("[contenteditable]");
  if (editable != null && editable.getAttribute("contenteditable") !== "false")
    return true;
  return element.closest('[data-hotkeys="text"]') != null;
};

export const useAppHotkey = (
  binding: string | null,
  handler: () => void,
  options: {
    guardRichText?: boolean;
    enabled?: boolean;
    actionId?: string;
  } = {}
): void => {
  const bindings = useContext(ActionBindingsContext);
  // The chat kit's pre-migration Stop chord has one action identity. Resolving
  // here keeps its enabled/focused guard and prevents a competing handler.
  const actionId =
    options.actionId ?? (binding === "Mod+." ? "stop-run" : undefined);
  const resolved =
    actionId && bindings && Object.hasOwn(bindings, actionId)
      ? bindings[actionId]!
      : binding;
  useHotkey(
    (resolved ?? "F24") as never,
    (event) => {
      if (options.guardRichText === true && isRichTextTarget(event.target))
        return;
      event.preventDefault();
      handler();
    },
    {
      // App shortcuts fire in inputs and textareas too (§7.9 table).
      ignoreInputs: false,
      enabled: resolved != null && (options.enabled ?? true),
      meta: { actionId },
    }
  );
};
