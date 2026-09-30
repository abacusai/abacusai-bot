/**
 * Where pending permissions show (spec 02 §6.2): the sessions tray (the
 * selected descriptor's card, with a chip per descriptor when several are
 * pending) and the application-owned `PermissionList` (every descriptor no
 * mounted inline widget renders; bots and the notch).
 */
import type { PermissionRequest } from "@abacus-ai/agent";
import { useSelector } from "@tanstack/react-store";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#next/lib/cn";

import { useThreadStore } from "../../store/selectors";
import { toolKey, type PermissionDescriptor } from "../../store/thread-store";
import { useChatView } from "../context";
import { PermissionCard } from "./permission-card";
import { present } from "./presenters";
import { permissionSelection, selectPermission } from "./selection";

export const inlineKeyOf = (descriptor: PermissionDescriptor): string | null =>
  descriptor.toolCallId == null ? null : toolKey(descriptor.subagentRunId, descriptor.toolCallId);

const useItems = (): PermissionDescriptor[] => {
  const { session } = useChatView();
  return useThreadStore(session, (state) => state.permissions.items);
};

/** The chip or card that answers next when the current one is answered. */
const nextAfter = (items: readonly PermissionDescriptor[], id: string): string | null => {
  const rest = items.filter((item) => item.id !== id);
  const index = items.findIndex((item) => item.id === id);
  return (rest[index] ?? rest[0])?.id ?? null;
};

export const PermissionTray = ({ autoFocus = false }: { autoFocus?: boolean }) => {
  const { t } = useTranslation();
  const { threadId } = useChatView();
  const items = useItems();
  const chosen = useSelector(permissionSelection, (state) => state[threadId] ?? null);
  if (items.length === 0) return null;
  const selected = items.find((item) => item.id === chosen) ?? items[0]!;
  return (
    <div className="flex flex-col gap-2" data-slot="permission-tray">
      {items.length > 1 ? (
        <div role="toolbar" aria-label={t("chat.permission.pending", { count: items.length })} className="flex flex-wrap gap-1.5">
          {items.map((item) => {
            const model = present(item.metadata.abacus.request as PermissionRequest);
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={item.id === selected.id}
                onClick={() => selectPermission(threadId, item.id)}
                className={cn(
                  "h-7 max-w-60 truncate rounded-full px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  item.id === selected.id
                    ? "bg-foreground text-background"
                    : "bg-[var(--chat-surface)] text-foreground hover:bg-[var(--chat-surface-2)]"
                )}
              >
                {t(`chat.permission.chip.${model.chip}`, model.chipValues)}
              </button>
            );
          })}
        </div>
      ) : null}
      <PermissionCard
        key={selected.id}
        descriptor={selected}
        autoFocus={autoFocus}
        onAnswered={() => selectPermission(threadId, nextAfter(items, selected.id))}
      />
    </div>
  );
};

/** Every descriptor that no mounted inline widget renders (agent spec §3.5.5). */
export const PermissionList = () => {
  const { inline } = useChatView();
  const items = useItems();
  const registered = useSyncExternalStore(inline.subscribe, inline.keys);
  const listed = items.filter((item) => {
    const key = inlineKeyOf(item);
    return key == null || !registered.has(key);
  });
  if (listed.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-slot="permission-list">
      {listed.map((item) => (
        <PermissionCard key={item.id} descriptor={item} />
      ))}
    </div>
  );
};
