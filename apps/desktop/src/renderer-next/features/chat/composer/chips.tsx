/**
 * The composer's chips (spec 02 §8.2): the permission-mode chip (sessions)
 * with the canvas's five modes, and the model chip with its picker shell
 * (groups come from the route; `value: null` is the app default, 03-bots
 * §24.2).
 */
import { Check, ChevronDown, Cpu, Shield } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#next/lib/cn";
import {
  durations,
  easings,
  motionFor,
  useMotionPreference,
} from "#next/lib/motion";
import { Button } from "#next/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#next/ui/dropdown-menu";
import { Input } from "#next/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "#next/ui/popover";
import { AgentMode } from "#shared/agent-types";

import type { ModelChipBinding } from "../kit/context";
import { MODE_DESCRIPTION_KEYS, MODE_LABEL_KEYS, MODE_ORDER } from "./modes";

const MODE_CONFIRM_MS = 5000;

export interface ModeChipProps {
  /** The live mode (`store.agent.mode`), or null before the runtime exists. */
  value: AgentMode | null;
  /** The draft's choice before the runtime exists. */
  draft: AgentMode | undefined;
  live: boolean;
  onDraft(mode: AgentMode): void;
  setMode?: (mode: AgentMode) => Promise<void>;
  onOpenChange?: (open: boolean) => void;
  onRevert?: () => void;
  /** Opens with the menu shown (gallery "permission mode open"). */
  defaultOpen?: boolean;
  availableModes?: AgentMode[];
}

export const ModeChip = ({
  value,
  draft,
  live,
  onDraft,
  setMode,
  onOpenChange,
  onRevert,
  defaultOpen = false,
  availableModes,
}: ModeChipProps) => {
  const { t } = useTranslation();
  const [optimistic, setOptimistic] = useState<AgentMode | null>(null);
  // Confirmed once the agent's state shows it (a STATE_DELTA /mode).
  const pending =
    optimistic != null && optimistic !== value ? optimistic : null;
  const shown = pending ?? (live ? value : draft) ?? value ?? AgentMode.Normal;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(
    () => () => {
      if (timer.current != null) clearTimeout(timer.current);
    },
    []
  );
  const choose = (mode: AgentMode) => {
    if (!live || setMode == null) {
      onDraft(mode);
      return;
    }
    setOptimistic(mode);
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (valueRef.current !== mode) onRevert?.();
      setOptimistic(null);
    }, MODE_CONFIRM_MS);
    void setMode(mode).catch(() => {
      setOptimistic(null);
      onRevert?.();
    });
  };
  return (
    <DropdownMenu
      defaultOpen={defaultOpen}
      {...(onOpenChange != null ? { onOpenChange } : {})}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-haspopup="menu"
            className={cn(
              "h-[30px] rounded-full px-2.5 text-[13px]",
              shown === AgentMode.Yolo && "text-[var(--chat-status-attention)]"
            )}
          />
        }
      >
        <Shield aria-hidden />
        {t(MODE_LABEL_KEYS[shown] ?? "chat.mode.DEFAULT")}
        {pending != null ? (
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-[var(--chat-status-running)]"
          />
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[340px]" align="start" side="top">
        {MODE_ORDER.filter(
          (mode) => availableModes == null || availableModes.includes(mode)
        ).map((mode) => (
          <DropdownMenuItem
            key={mode}
            onClick={() => choose(mode)}
            className="flex flex-col items-start gap-0.5 py-2"
          >
            <span
              className={cn(
                "font-medium",
                mode === AgentMode.Yolo && "text-[var(--chat-status-attention)]"
              )}
            >
              {t(MODE_LABEL_KEYS[mode]!)}
            </span>
            <span className="text-muted-foreground">
              {t(MODE_DESCRIPTION_KEYS[mode]!)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const ModelChip = ({
  binding,
  compact = false,
  onOpenChange,
  onUseLocalModel,
}: {
  onUseLocalModel?(): void;
  onOpenChange?(open: boolean): void;
  binding: ModelChipBinding;
  compact?: boolean;
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pref = useMotionPreference();
  const q = query.trim().toLowerCase();
  const groups = binding.groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          q === "" ||
          item.label.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q)
      ),
    }))
    .filter(
      (group) => group.items.length > 0 || (q === "" && group.connect != null)
    );
  const label = binding.label;
  const trigger = (
    <Button
      variant="ghost"
      size={compact ? "icon" : "sm"}
      data-slot="chat-model-picker"
      aria-haspopup="listbox"
      aria-label={
        compact ? t("chat.composer.model", { name: label }) : undefined
      }
      className={cn(
        "h-[30px] rounded-full text-[13px]",
        !compact && "px-2.5",
        open && "bg-secondary"
      )}
    />
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger render={trigger}>
        {compact ? (
          <Cpu aria-hidden />
        ) : binding.layoutId != null ? (
          <motion.span
            layoutId={binding.layoutId}
            transition={motionFor(
              pref,
              { duration: durations.layout / 1000, ease: easings.standard },
              { duration: 0 }
            )}
          >
            {label}
          </motion.span>
        ) : (
          label
        )}
        {compact ? null : <ChevronDown aria-hidden className="opacity-60" />}
      </PopoverTrigger>
      <PopoverContent className="w-[340px] p-1.5" side="top" align="end">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("chat.composer.searchModels")}
          aria-label={t("chat.composer.searchModels")}
          className="mb-1 h-8"
        />
        <div
          role="listbox"
          aria-label={t("chat.composer.models")}
          className="flex max-h-80 flex-col overflow-y-auto"
        >
          {onUseLocalModel != null && q === "" ? (
            <button
              type="button"
              role="option"
              aria-selected={false}
              className="hover:bg-secondary flex h-8 items-center rounded-md px-2.5 text-start text-[13px]"
              onClick={() => {
                onUseLocalModel();
                setOpen(false);
              }}
            >
              {t("localModels.useLocal")}
            </button>
          ) : null}
          {groups.map((group) => (
            <div
              key={group.id}
              role="group"
              aria-label={group.label}
              className="flex flex-col"
            >
              <div className="text-muted-foreground px-2.5 pt-1.5 pb-1 text-xs">
                {group.label}
              </div>
              {group.items.map((item) => {
                const selected = (binding.value ?? "") === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className="hover:bg-secondary focus-visible:bg-secondary flex h-8 items-center gap-2 rounded-md px-2.5 text-start text-[13px] outline-none"
                    onClick={() => {
                      binding.onChange(item.id === "" ? null : item.id);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {item.label}
                    </span>
                    {item.description != null ? (
                      <span className="text-muted-foreground">
                        {item.description}
                      </span>
                    ) : null}
                    {selected ? (
                      <Check aria-hidden className="size-3.5" />
                    ) : null}
                  </button>
                );
              })}
              {group.connect != null && q === "" ? (
                <button
                  type="button"
                  className="hover:bg-secondary flex h-8 items-center rounded-md px-2.5 text-start text-[13px]"
                  onClick={() => {
                    group.connect!.onSelect();
                    setOpen(false);
                  }}
                >
                  {group.connect.label}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};
