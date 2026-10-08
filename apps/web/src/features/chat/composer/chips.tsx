import { AgentMode } from "@abacus-ai/contract/agent-types";
/**
 * The composer's chips (spec 02 §8.2, canvas ComposerStates and Pickers):
 * the permission-mode chip (sessions) opening a list of name + description
 * rows, and the model chip (provider mark, model name) opening the picker
 * above it: a provider rail on the left (favourites, each provider's mark,
 * this machine), search on top, dense rows with the provider's mark, the
 * model's name and its tier. The picker is a Combobox (dropdown collision
 * rules: it flips above/below, never beside), the mode list a Popover
 * around a Command list. Groups come from the route; `value: null` is the
 * app default (03-bots §24.2).
 */
import {
  CalendarClock,
  Cpu,
  KeyRound,
  Shield,
  Star,
  FilePenLine,
  ListTodo,
  LockOpen,
  Sparkles,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  ConnectorMark,
  markForProvider,
} from "#renderer/components/connector-mark";
import { cn } from "#renderer/lib/cn";
import {
  durations,
  easings,
  motionFor,
  useMotionPreference,
} from "#renderer/lib/motion";
import { Button } from "#renderer/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "#renderer/ui/combobox";
import { Command, CommandItem, CommandList } from "#renderer/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import type { ModelChipBinding, ModelGroup } from "../kit/context";
import { MODE_DESCRIPTION_KEYS, MODE_LABEL_KEYS, MODE_ORDER } from "./modes";

const MODE_ICONS: Record<AgentMode, LucideIcon> = {
  [AgentMode.Auto]: Sparkles,
  [AgentMode.Normal]: Shield,
  [AgentMode.AcceptEdits]: FilePenLine,
  [AgentMode.PlanMode]: ListTodo,
  [AgentMode.Yolo]: LockOpen,
  [AgentMode.Unattended]: CalendarClock,
};
const MODE_CONFIRM_MS = 5000;

/** Pickers (canvas): a 340 px panel, 14 px corners, 6 px inset. */
const PANEL_CLASS =
  "w-[min(340px,calc(100vw-32px))] gap-0 rounded-[14px] p-1.5 text-[13px]";
/** A 32 px row, 8 px corners; the chosen row is tinted, the cursor row muted. */
const ROW_CLASS =
  "min-h-8 rounded-lg px-2 py-1 text-[13px]/snug data-[checked=true]:bg-foreground/[0.06]";

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
  const ModeIcon = MODE_ICONS[shown];
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
        <ModeIcon aria-hidden />
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
                {(() => {
                  const Icon = MODE_ICONS[mode];
                  return <Icon aria-hidden className="size-3.5 shrink-0" />;
                })()}
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

/** The provider group listing the chosen model (or, for App default, the resolved one). */
const providerGroupOf = (binding: ModelChipBinding): ModelGroup | null => {
  const id = binding.value ?? "";
  const providers = binding.groups.filter((g) => !COLLECTION_GROUPS.has(g.id));
  return (
    providers.find((group) => group.items.some((item) => item.id === id)) ??
    (binding.value == null
      ? (providers.find((group) =>
          group.items.some((item) => item.label === binding.label)
        ) ?? null)
      : null)
  );
};

/**
 * The provider group behind a row: its own group, or for a favourite (listed
 * under a collection) and App default (resolving to a model) the provider
 * group that lists that model.
 */
const providerGroupForItem = (
  binding: ModelChipBinding,
  group: ModelGroup,
  item: ModelGroup["items"][number]
): ModelGroup | null => {
  if (!COLLECTION_GROUPS.has(group.id)) return group;
  if (item.id === "")
    return providerGroupOf({
      ...binding,
      value: null,
      label: item.description ?? binding.label,
    });
  return providerGroupOf({ ...binding, value: item.id });
};

/** A row of the picker's list (the Combobox's item value). */
type ModelRow =
  | {
      kind: "item";
      key: string;
      group: ModelGroup;
      item: ModelGroup["items"][number];
    }
  | { kind: "connect"; key: string; group: ModelGroup }
  | { kind: "local"; key: string };

/** The rail's views: the favourites (with App default), a provider, this machine. */
type Rail = "favorites" | "local" | { provider: string };

const isFavorites = (group: ModelGroup): boolean =>
  group.id === "favorites" || group.id === "favourites";

const matches = (row: ModelRow, query: string): boolean => {
  if (row.kind === "local") return false;
  if (row.kind === "connect") return false;
  const q = query.toLowerCase();
  return (
    row.item.label.toLowerCase().includes(q) ||
    row.item.id.toLowerCase().includes(q) ||
    (row.item.description ?? "").toLowerCase().includes(q) ||
    row.group.label.toLowerCase().includes(q)
  );
};

/** The picker's rows for a view: a rail's groups, or every group under a search. */
const rowsFor = (
  binding: ModelChipBinding,
  rail: Rail,
  query: string,
  local: boolean
): {
  rows: ModelRow[];
  sections: Array<{ group: ModelGroup; rows: ModelRow[] }>;
} => {
  const itemRows = (group: ModelGroup): ModelRow[] => [
    ...group.items.map((item): ModelRow => ({
      kind: "item",
      key: `${group.id}:${item.id === "" ? "default" : item.id}`,
      group,
      item,
    })),
    ...(group.connect != null
      ? [{ kind: "connect", key: `${group.id}:connect`, group } as ModelRow]
      : []),
  ];
  const sections: Array<{ group: ModelGroup; rows: ModelRow[] }> = [];
  if (query !== "") {
    for (const group of binding.groups) {
      const rows = itemRows(group).filter((row) => matches(row, query));
      if (rows.length > 0) sections.push({ group, rows });
    }
  } else {
    // App default leads every view: one row, so the null choice is always
    // one arrow away whichever provider the rail shows.
    for (const group of binding.groups)
      if (group.id === "default")
        sections.push({ group, rows: itemRows(group) });
    if (rail === "favorites") {
      for (const group of binding.groups)
        if (isFavorites(group)) sections.push({ group, rows: itemRows(group) });
    } else if (rail !== "local") {
      const group = binding.groups.find((g) => g.id === rail.provider);
      if (group != null) sections.push({ group, rows: itemRows(group) });
    }
  }
  const rows = sections.flatMap((section) => section.rows);
  if (local && query === "") rows.push({ kind: "local", key: "local" });
  return { rows, sections };
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
  const [railChoice, setRailChoice] = useState<Rail | null>(null);
  const pref = useMotionPreference();
  const label = binding.label;
  // The catalogue's rows are read only while the picker is open: a closed
  // chip touches ids, never the (lazily materialised) labels.
  const chosenProvider = open
    ? providerGroupOf(binding)
    : binding.value == null
      ? null
      : (binding.groups.find(
          (g) =>
            !COLLECTION_GROUPS.has(g.id) &&
            g.items.some((item) => item.id === binding.value)
        ) ?? null);
  const providers = binding.groups.filter((g) => !COLLECTION_GROUPS.has(g.id));
  // The rail opens on the chosen model's provider (App default's resolved
  // one); otherwise on the favourites when there are any, else the first
  // provider, so the list is never empty.
  const rail: Rail =
    railChoice ??
    (chosenProvider != null
      ? { provider: chosenProvider.id }
      : binding.groups.some(isFavorites) || providers.length === 0
        ? "favorites"
        : { provider: providers[0]!.id });
  const q = query.trim();
  const { rows, sections } = open
    ? rowsFor(binding, rail, q, onUseLocalModel != null)
    : { rows: [], sections: [] };
  const selected =
    rows.find(
      (row) => row.kind === "item" && row.item.id === (binding.value ?? "")
    ) ?? null;
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (!next) {
      setQuery("");
      setRailChoice(null);
    }
  };
  const pick = (row: ModelRow | null) => {
    if (row == null) return;
    if (row.kind === "item")
      binding.onChange(row.item.id === "" ? null : row.item.id);
    else if (row.kind === "connect") row.group.connect!.onSelect();
    else onUseLocalModel?.();
    change(false);
  };
  const chooseRail = (next: Rail) => {
    setQuery("");
    setRailChoice(next);
  };
  // A group's mark; none (App default while closed) is the app's own.
  const markOf = (group: ModelGroup | null): string =>
    group == null ? "abacus" : (markForProvider(group.id) ?? group.id);
  const chipMark = (
    <ConnectorMark
      id={markOf(chosenProvider)}
      size={16}
      className="rounded-[5px]"
    />
  );
  const provider = compact ? null : (chosenProvider?.label ?? null);
  const current =
    rail === "local"
      ? null
      : typeof rail === "string"
        ? null
        : (binding.groups.find((g) => g.id === rail.provider) ?? null);
  // A provider with nothing to run and a connect action: the not-connected card.
  const notConnected =
    q === "" &&
    current != null &&
    current.items.length === 0 &&
    current.connect != null
      ? current
      : null;
  return (
    <Combobox<ModelRow>
      open={open}
      onOpenChange={change}
      items={rows}
      filter={null}
      value={selected}
      onValueChange={pick}
      itemToStringValue={(row) => row.key}
      itemToStringLabel={(row) =>
        row.kind === "item"
          ? row.item.label
          : row.kind === "connect"
            ? row.group.connect!.label
            : t("localModels.useLocal")
      }
      isItemEqualToValue={(a, b) => a.key === b.key}
      inputValue={query}
      onInputValueChange={setQuery}
      modal={false}
    >
      <ComboboxTrigger
        render={
          <Button
            variant="ghost"
            size={compact ? "icon" : "sm"}
            data-slot="chat-model-picker"
            // A combobox takes no name from its content: name it always.
            aria-label={t("chat.composer.model", { name: label })}
            className={cn(
              "h-[30px] rounded-full text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
              !compact && "ps-2 pe-2.5",
              open && "bg-secondary"
            )}
          />
        }
      >
        {chipMark}
        {compact ? null : binding.layoutId != null ? (
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
        {provider != null && !compact ? (
          <span className="text-muted-foreground font-normal">{provider}</span>
        ) : null}
      </ComboboxTrigger>
      <ComboboxContent
        side="top"
        align="end"
        sideOffset={8}
        data-slot="chat-model-panel"
        className="flex h-[min(320px,var(--available-height))] w-[min(360px,var(--available-width))] min-w-0 flex-row gap-1 rounded-[20px] p-1 text-[13px]"
      >
        <div
          role="tablist"
          aria-label={t("chat.composer.providers")}
          aria-orientation="vertical"
          data-slot="chat-model-rail"
          className="no-scrollbar bg-foreground/[0.04] flex w-11 shrink-0 flex-col items-center gap-1.5 overflow-y-auto rounded-2xl p-1"
        >
          <RailButton
            label={t("chat.composer.favorites")}
            selected={rail === "favorites"}
            onClick={() => chooseRail("favorites")}
          >
            <Star
              aria-hidden
              className={cn("size-3.5", rail === "favorites" && "fill-current")}
            />
          </RailButton>
          {providers.map((group) => (
            <RailButton
              key={group.id}
              label={group.label}
              selected={typeof rail !== "string" && rail.provider === group.id}
              onClick={() => chooseRail({ provider: group.id })}
            >
              <ConnectorMark id={markOf(group)} size={16} />
            </RailButton>
          ))}
          {onUseLocalModel != null ? (
            <RailButton
              label={t("chat.composer.onThisMachine")}
              selected={rail === "local"}
              onClick={() => chooseRail("local")}
            >
              <Cpu aria-hidden className="size-3.5" />
            </RailButton>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <ComboboxInput
            showTrigger={false}
            placeholder={t("chat.composer.searchModels")}
            aria-label={t("chat.composer.models")}
            className="m-0! h-8! shrink-0"
          />
          {notConnected != null ? (
            <div
              data-slot="chat-model-not-connected"
              className="flex min-h-0 flex-1 flex-col items-start justify-center gap-2 px-2 pb-2"
            >
              <span className="font-medium">
                {t("chat.composer.providerNotConnected", {
                  provider: notConnected.label,
                })}
              </span>
              <span className="text-muted-foreground">
                {t("chat.composer.providerConnectHint")}
              </span>
              <Button
                size="sm"
                className="mt-1 h-8 rounded-lg"
                onClick={() =>
                  pick({ kind: "connect", key: "", group: notConnected })
                }
              >
                {notConnected.connect!.label}
              </Button>
            </div>
          ) : (
            <ComboboxList
              aria-label={t("chat.composer.models")}
              className="scroll-fade-y min-h-0 flex-1 p-0 pt-1"
            >
              {sections.map(({ group, rows: groupRows }) => (
                <ComboboxGroup key={group.id} items={groupRows}>
                  <ComboboxLabel className="px-2 py-1 text-xs">
                    {group.label}
                  </ComboboxLabel>
                  {groupRows.map((row) => (
                    <ComboboxItem
                      key={row.key}
                      value={row}
                      data-checked={
                        row.kind === "item" &&
                        row.item.id === (binding.value ?? "")
                      }
                      className={ROW_CLASS}
                    >
                      {row.kind === "item" ? (
                        <>
                          <ConnectorMark
                            id={markOf(
                              providerGroupForItem(binding, group, row.item)
                            )}
                            size={16}
                            className="rounded-[5px]"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {row.item.label}
                          </span>
                          {row.item.description != null ? (
                            <span className="text-muted-foreground truncate pe-4">
                              {row.item.description}
                            </span>
                          ) : null}
                        </>
                      ) : row.kind === "connect" ? (
                        <>
                          <KeyRound
                            aria-hidden
                            className="text-muted-foreground size-3.5"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {row.group.connect!.label}
                          </span>
                        </>
                      ) : null}
                    </ComboboxItem>
                  ))}
                </ComboboxGroup>
              ))}
              {rail === "favorites" &&
              q === "" &&
              !binding.groups.some(isFavorites) ? (
                <p className="text-muted-foreground px-2 py-3 text-center">
                  {t("chat.composer.noFavorites")}
                </p>
              ) : null}
              {onUseLocalModel != null && q === "" ? (
                <ComboboxGroup
                  items={rows.filter((row) => row.kind === "local")}
                >
                  {rail === "local" ? (
                    <ComboboxLabel className="px-2 py-1 text-xs">
                      {t("chat.composer.onThisMachine")}
                    </ComboboxLabel>
                  ) : (
                    <ComboboxSeparator className="mx-1 my-1" />
                  )}
                  <ComboboxItem
                    value={rows.find((row) => row.kind === "local")!}
                    className={ROW_CLASS}
                  >
                    <Cpu
                      aria-hidden
                      className="text-muted-foreground size-3.5"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {t("localModels.useLocal")}
                    </span>
                  </ComboboxItem>
                </ComboboxGroup>
              ) : null}
              <ComboboxEmpty>{t("chat.composer.noModels")}</ComboboxEmpty>
            </ComboboxList>
          )}
          <Button
            variant="ghost"
            className="mt-1 h-8 shrink-0 justify-start rounded-lg border-t px-2 text-xs"
            disabled={binding.onConfigureProviders == null}
            onClick={() => {
              setOpen(false);
              binding.onConfigureProviders?.();
            }}
          >
            <Settings2 aria-hidden className="size-3.5" />
            {t("bots.model.configureProviders")}
          </Button>
        </div>
      </ComboboxContent>
    </Combobox>
  );
};

/** A rail entry: a 36×30 pill, the chosen one tinted, named by its tooltip. */
const RailButton = ({
  label,
  selected,
  onClick,
  children,
}: {
  label: string;
  selected: boolean;
  onClick(): void;
  children: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <button
          type="button"
          role="tab"
          aria-selected={selected}
          aria-label={label}
          data-slot="chat-model-rail-item"
          className={cn(
            "focus-visible:ring-ring/40 flex h-[30px] w-9 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2",
            selected
              ? "bg-foreground/[0.1] text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]"
          )}
          onClick={onClick}
        />
      }
    >
      {children}
    </TooltipTrigger>
    <TooltipContent side="right">{label}</TooltipContent>
  </Tooltip>
);
