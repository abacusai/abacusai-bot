import {
  findHotkeyConflicts,
  formatForDisplay,
  normalizeHotkey,
  parseHotkey,
  validateHotkey,
} from "@tanstack/hotkeys";
import { useHotkeyRecorder } from "@tanstack/react-hotkeys";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AreaPage,
  GroupCard,
  SettingRow,
} from "#next/components/form-kit/page";
import {
  APP_ACTIONS,
  bindingIds,
  resolveKeymap,
  SYSTEM_BINDINGS,
  TERMINAL_RESERVED,
} from "#next/lib/keyboard/actions";
import { type HotkeyPlatform } from "#next/lib/platform";
import { showError } from "#next/lib/toast";
import { Button } from "#next/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "#next/ui/dialog";
declare module "@tanstack/hotkeys" {
  interface HotkeyMeta {
    actionId?: string;
  }
}
export const bindingConflict = (
  id: string,
  candidate: string,
  overrides: Record<string, string | null>,
  platform: HotkeyPlatform
): { id: string; rebindable: boolean } | null => {
  const normalize = (value: string) => normalizeHotkey(value, platform);
  const chord = normalize(candidate);
  const action = APP_ACTIONS.find((action) => action.id === id.split("@")[0]);
  const contexts: Array<"window" | "terminal"> = id.endsWith("@terminal")
    ? ["terminal"]
    : action?.terminalDefault?.[platform] !== undefined
      ? ["window"]
      : ["window", "terminal"];
  if (
    SYSTEM_BINDINGS.some((x) => normalize(x) === chord) ||
    (contexts.includes("terminal") &&
      platform !== "mac" &&
      TERMINAL_RESERVED.some((x) => normalize(x) === chord))
  )
    return { id: "system", rebindable: false };
  for (const context of contexts) {
    const resolved = resolveKeymap(overrides, platform)[context];
    for (const action of APP_ACTIONS) {
      const otherId =
        context === "terminal" &&
        action.terminalDefault?.[platform] !== undefined
          ? `${action.id}@terminal`
          : action.id;
      if (otherId === id) continue;
      const binding = resolved[action.id];
      if (binding && normalize(binding) === chord)
        return { id: otherId, rebindable: action.rebindable };
    }
  }
  return null;
};
export const KeymapEditor = ({
  keymap,
  platform,
  onUpdate: update,
}: {
  keymap: Record<string, string | null>;
  platform: HotkeyPlatform;
  onUpdate(patch: { keymap: Record<string, string | null> }): Promise<unknown>;
}) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    candidate: string;
    id: string;
    rebindable: boolean;
    description?: string;
  } | null>(null);
  const resolved = resolveKeymap(keymap, platform);
  const save = async (id: string, candidate: string, remove?: string) => {
    const map = {
      ...keymap,
      [id]: candidate,
      ...(remove ? { [remove]: null } : {}),
    };
    try {
      await update({ keymap: map });
    } catch {
      showError(t("phase5.saveFailed"));
      return;
    }
    setEditing(null);
    setConflict(null);
  };
  const recorder = useHotkeyRecorder({
    recordBy: "key",
    platform,
    onRecord: (binding) => {
      if (!editing) return;
      const candidate = normalizeHotkey(binding, platform);
      const validation = validateHotkey(candidate);
      const parsed = parseHotkey(candidate);
      if (
        !validation.valid ||
        (!parsed.modifiers.some((m) =>
          ["Control", "Meta", "Alt", "Mod"].includes(m)
        ) &&
          !/^F\d+$/.test(parsed.key ?? ""))
      ) {
        setError(t("phase5.shortcutNeedsModifier"));
        return;
      }
      const conflict = bindingConflict(
        editing,
        candidate,
        keymap ?? {},
        platform
      );
      if (conflict) {
        if (conflict.id === "system") {
          setError(t("phase5.systemShortcut"));
          return;
        }
        setConflict({ ...conflict, candidate });
        return;
      }
      const live = findHotkeyConflicts(candidate, {
        platform,
        exclude: (r) => {
          const id = r.options.meta?.actionId;
          if (id === editing.split("@")[0]) return true;
          if (!editing.endsWith("@terminal") || !id) return false;
          const terminal = resolved.terminal[id];
          return (
            APP_ACTIONS.some((action) => action.id === id) &&
            (!terminal || normalizeHotkey(terminal, platform) !== candidate)
          );
        },
      });
      if (live.length) {
        const first =
          live.find(
            (conflict) =>
              conflict.type !== "hotkey" ||
              !APP_ACTIONS.find(
                (action) =>
                  action.id === conflict.registration.options.meta?.actionId
              )?.rebindable
          ) ?? live[0]!;
        const id = first.registration.options.meta?.actionId;
        const action = APP_ACTIONS.find((a) => a.id === id);
        setConflict({
          candidate,
          id: id ?? "unknown",
          rebindable: first.type === "hotkey" && !!action?.rebindable,
          description: first.registration.options.meta?.description,
        });
        return;
      }
      void save(editing, candidate);
    },
    onCancel: () => {
      setEditing(null);
      setError(null);
    },
  });
  return (
    <AreaPage title={t("settings.pages.keyboard")}>
      <GroupCard>
        {bindingIds(platform).map((id) => {
          const action = APP_ACTIONS.find((a) => a.id === id.split("@")[0])!;
          const terminal = id.endsWith("@terminal");
          const binding = resolved[terminal ? "terminal" : "window"][action.id];
          return (
            <SettingRow
              key={id}
              id={`key-${id}`}
              title={
                t(action.labelKey) +
                (terminal ? ` · ${t("phase5.inTerminal")}` : "")
              }
              detail={
                !action.rebindable
                  ? t(
                      action.id === "send"
                        ? "phase5.enterSends"
                        : "phase5.comingNotch"
                    )
                  : undefined
              }
            >
              <kbd className="text-muted-foreground text-xs">
                {binding
                  ? formatForDisplay(binding as never, { platform })
                  : t("phase5.notSet")}
              </kbd>
              {action.rebindable && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setEditing(id);
                      setError(null);
                      recorder.startRecording();
                    }}
                  >
                    {t("phase5.change")}
                  </Button>
                  {binding !== null && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void update({
                          keymap: { ...keymap, [id]: null },
                        }).catch(() => showError(t("phase5.saveFailed")))
                      }
                    >
                      {t("phase5.unbind")}
                    </Button>
                  )}
                  {Object.hasOwn(keymap ?? {}, id) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const map = { ...keymap };
                        delete map[id];
                        void update({ keymap: map }).catch(() =>
                          showError(t("phase5.saveFailed"))
                        );
                      }}
                    >
                      {t("phase5.reset")}
                    </Button>
                  )}
                </>
              )}
            </SettingRow>
          );
        })}
      </GroupCard>
      <Button
        variant="secondary"
        onClick={() =>
          void update({ keymap: {} }).catch(() =>
            showError(t("phase5.saveFailed"))
          )
        }
      >
        {t("phase5.resetShortcuts")}
      </Button>
      {editing && (
        <>
          <p role="status">{t("phase5.recordShortcut")}</p>
          <Button
            variant="secondary"
            onClick={() => {
              recorder.cancelRecording();
              setEditing(null);
              setError(null);
            }}
          >
            {t("phase5.cancel")}
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <Dialog
        open={!!conflict}
        onOpenChange={(open) => {
          if (!open) {
            setConflict(null);
            setEditing(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("phase5.shortcutConflict")}</DialogTitle>
            <DialogDescription>
              {t("phase5.usedBy", {
                action:
                  conflict?.description ??
                  t(
                    APP_ACTIONS.find((a) => a.id === conflict?.id.split("@")[0])
                      ?.labelKey ?? "phase5.anotherPart"
                  ),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setConflict(null);
                setEditing(null);
              }}
            >
              {t("phase5.cancel")}
            </Button>
            {conflict?.rebindable && (
              <Button
                onClick={() =>
                  editing && void save(editing, conflict.candidate, conflict.id)
                }
              >
                {t("phase5.useAnyway")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AreaPage>
  );
};
