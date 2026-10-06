import { AgentMode } from "@abacus-ai/contract/agent-types";
/**
 * The composer's chips (spec 02 §8.2, canvas ComposerStates and Pickers):
 * the permission-mode chip (sessions) opening a 340 px list of name +
 * description rows, and the model chip (name, provider in muted text)
 * opening a 340 px searchable panel above it: "Favourites", the provider
 * groups with their "Connect …" rows, "On this machine". Both are a Popover
 * around a Command list (keyboard navigable, Escape closes). Groups come
 * from the route; `value: null` is the app default (03-bots §24.2).
 */
import { ChevronDown, Cpu, Shield } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import {
  durations,
  easings,
  motionFor,
  useMotionPreference,
} from "#renderer/lib/motion";
import { Button } from "#renderer/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#renderer/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";

import type { ModelChipBinding } from "../kit/context";
import { MODE_DESCRIPTION_KEYS, MODE_LABEL_KEYS, MODE_ORDER } from "./modes";

const MODE_CONFIRM_MS = 5000;

/** Pickers (canvas): a 340 px panel, 14 px corners, 6 px inset. */
const PANEL_CLASS =
  "w-[min(340px,calc(100vw-32px))] gap-0 rounded-[14px] p-1.5 text-[13px]";
/** A 32 px row, 8 px corners; the chosen row is tinted, the cursor row muted. */
const ROW_CLASS =
  "min-h-8 rounded-lg px-2.5 py-1.5 text-[13px] data-[checked=true]:bg-foreground/[0.06]";

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
  const [open, setOpen] = useState(defaultOpen);
  const list = useRef<HTMLDivElement>(null);
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
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            data-slot="chat-mode-picker"
            aria-haspopup="listbox"
            className={cn(
              "h-[30px] rounded-full px-2.5 text-[13px]",
              open && "bg-secondary",
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
      </PopoverTrigger>
      <PopoverContent
        className={PANEL_CLASS}
        align="start"
        side="top"
        sideOffset={8}
        initialFocus={list}
      >
        <Command
          ref={list}
          shouldFilter={false}
          label={t("chat.composer.modes")}
          className="bg-transparent p-0"
        >
          <CommandList className="max-h-none">
            {MODE_ORDER.filter(
              (mode) => availableModes == null || availableModes.includes(mode)
            ).map((mode) => (
              <CommandItem
                key={mode}
                value={mode}
                data-checked={mode === shown}
                onSelect={() => {
                  choose(mode);
                  change(false);
                }}
                className={cn(ROW_CLASS, "py-2")}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className={cn(
                      "font-medium",
                      mode === AgentMode.Yolo &&
                        "text-[var(--chat-status-attention)]"
                    )}
                  >
                    {t(MODE_LABEL_KEYS[mode]!)}
                  </span>
                  <span className="text-muted-foreground">
                    {t(MODE_DESCRIPTION_KEYS[mode]!)}
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

/** Groups whose label names a collection, not the model's provider. */
const COLLECTION_GROUPS = new Set(["default", "favorites", "favourites"]);

/** The provider of the chosen model: the label of the group listing it. */
const providerOf = (binding: ModelChipBinding): string | null => {
  const id = binding.value ?? "";
  for (const group of binding.groups) {
    if (COLLECTION_GROUPS.has(group.id)) continue;
    if (group.items.some((item) => item.id === id)) return group.label;
  }
  return null;
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [offset, setOffset] = useState(12);
  const pref = useMotionPreference();
  const label = binding.label;
  const provider = compact ? null : providerOf(binding);
  const trigger = (
    <Button
      variant="ghost"
      size={compact ? "icon" : "sm"}
      ref={triggerRef}
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
        if (next && triggerRef.current) {
          // The panel sits above the whole surface, not just the chip.
          const button = triggerRef.current;
          const composer = button.closest('[data-slot="composer"]');
          setOffset(
            composer
              ? Math.max(
                  12,
                  button.getBoundingClientRect().top -
                    composer.getBoundingClientRect().top +
                    12
                )
              : 12
          );
        }
        setOpen(next);
        onOpenChange?.(next);
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
        {provider != null ? (
          <span className="text-muted-foreground font-normal">{provider}</span>
        ) : null}
        {compact ? null : <ChevronDown aria-hidden className="opacity-60" />}
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          PANEL_CLASS,
          "max-h-[min(420px,var(--available-height))]"
        )}
        side="top"
        sideOffset={offset}
        align="end"
        initialFocus={search}
      >
        <ModelOptions
          binding={binding}
          search={search}
          onUseLocalModel={onUseLocalModel}
          close={() => {
            setOpen(false);
            onOpenChange?.(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
};

/** The portal mounts this only while the picker is shown, including its exit. */
const ModelOptions = ({
  binding,
  search,
  onUseLocalModel,
  close,
}: {
  binding: ModelChipBinding;
  search: React.RefObject<HTMLInputElement | null>;
  onUseLocalModel?: (() => void) | undefined;
  close(): void;
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const q = query.trim();
  return (
    <Command label={t("chat.composer.models")} className="bg-transparent p-0">
      <CommandInput
        ref={search}
        value={query}
        onValueChange={setQuery}
        placeholder={t("chat.composer.searchModels")}
        aria-label={t("chat.composer.searchModels")}
      />
      <CommandList className="max-h-[min(360px,calc(var(--available-height)-56px))]">
        <CommandEmpty>{t("chat.composer.noModels")}</CommandEmpty>
        {binding.groups.map((group) => (
          <CommandGroup key={group.id} heading={group.label} className="px-0">
            {group.items.map((item) => {
              const selected = (binding.value ?? "") === item.id;
              return (
                <CommandItem
                  key={item.id}
                  // cmdk keys its cursor by value: a favourite listed again
                  // under its provider needs a value of its own.
                  value={`${group.id}:${item.id === "" ? "default" : item.id}`}
                  keywords={[item.label]}
                  data-checked={selected}
                  onSelect={() => {
                    binding.onChange(item.id === "" ? null : item.id);
                    close();
                  }}
                  className={ROW_CLASS}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.description != null ? (
                    <span className="text-muted-foreground">
                      {item.description}
                    </span>
                  ) : null}
                </CommandItem>
              );
            })}
            {group.connect != null && q === "" ? (
              <CommandItem
                value={`${group.id}:connect`}
                onSelect={() => {
                  group.connect!.onSelect();
                  close();
                }}
                className={ROW_CLASS}
              >
                {group.connect.label}
              </CommandItem>
            ) : null}
          </CommandGroup>
        ))}
        {onUseLocalModel != null && q === "" ? (
          <CommandGroup
            heading={t("chat.composer.onThisMachine")}
            className="px-0"
          >
            <CommandItem
              value="local:download"
              onSelect={() => {
                onUseLocalModel();
                close();
              }}
              className={ROW_CLASS}
            >
              {t("localModels.useLocal")}
            </CommandItem>
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  );
};
