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
  AlertCircle,
  CalendarClock,
  KeyRound,
  Shield,
  Star,
  FilePenLine,
  ListTodo,
  Lock,
  LockOpen,
  Sparkles,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";

import {
  ConnectorMark,
  markForProvider,
} from "#renderer/components/connector-mark";
import { ModelSetupPopover } from "#renderer/components/model-setup/setup-list";
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
  ComboboxTrigger,
} from "#renderer/ui/combobox";
import { Command, CommandItem, CommandList } from "#renderer/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";
import { toast } from "#renderer/ui/toast";
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
          <CommandList className="flex max-h-none flex-col gap-0.5">
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

/** The provider group listing a model. Ids only: a closed chip reads no labels. */
const providerGroupOf = (
  groups: readonly ModelGroup[],
  id: string | null | undefined
): ModelGroup | null =>
  id == null
    ? null
    : (groups.find(
        (group) =>
          !COLLECTION_GROUPS.has(group.id) &&
          group.items.some((item) => item.id === id)
      ) ?? null);

/**
 * The provider group behind a row: its own group, or for a favourite (listed
 * under a collection) and App default (resolving to a model) the provider
 * group that lists that model.
 */
const providerGroupForItem = (
  binding: ModelChipBinding,
  group: ModelGroup,
  item: ModelGroup["items"][number]
): ModelGroup | null =>
  COLLECTION_GROUPS.has(group.id)
    ? providerGroupOf(binding.groups, item.resolves ?? item.id)
    : group;

/** A row of the picker's list (the Combobox's item value). */
type ModelRow =
  | {
      kind: "item";
      key: string;
      group: ModelGroup;
      item: ModelGroup["items"][number];
    }
  | { kind: "connect"; key: string; group: ModelGroup };

/** The rail's views: the favourites (with App default) or a provider. */
type Rail = "favorites" | { provider: string };

const isFavorites = (group: ModelGroup): boolean =>
  group.id === "favorites" || group.id === "favourites";

const matches = (row: ModelRow, query: string): boolean => {
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
  query: string
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
    } else {
      const group = binding.groups.find((g) => g.id === rail.provider);
      if (group != null) sections.push({ group, rows: itemRows(group) });
    }
  }
  const rows = sections.flatMap((section) => section.rows);
  return { rows, sections };
};

export interface ModelChipHandle {
  requestModel(): void;
  openMenu(): void;
}

export const ModelChip = ({
  binding,
  ref,
  compact = false,
  onOpenChange,
}: {
  ref?: Ref<ModelChipHandle>;
  onOpenChange?(open: boolean): void;
  binding: ModelChipBinding;
  compact?: boolean;
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const chip = useRef<HTMLButtonElement>(null);
  const ring = useRef<HTMLSpanElement>(null);
  const animations = useRef<Animation[]>([]);
  const descriptionId = useId();
  const [query, setQuery] = useState("");
  const [connected, setConnected] = useState(false);
  const [railChoice, setRailChoice] = useState<Rail | null>(null);
  const pref = useMotionPreference();
  useImperativeHandle(ref, () => ({
    openMenu() {
      setOpen(true);
      onOpenChange?.(true);
    },
    requestModel() {
      setAttempt((value) => value + 1);
      chip.current?.focus({ preventScroll: true });
      animations.current.forEach((animation) => animation.cancel());
      const easing = `cubic-bezier(${easings.notch.join(",")})`;
      animations.current = [
        ...(pref === "full" && chip.current
          ? [
              chip.current.animate(
                [0, -4, 4, -4, 4, -2, 0].map((x) => ({
                  transform: `translateX(${x}px)`,
                })),
                { duration: 400, easing }
              ),
            ]
          : []),
        ...(ring.current
          ? [
              ring.current.animate(
                [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }],
                { duration: 400, easing }
              ),
            ]
          : []),
      ];
      toast.add({
        id: "composer-model-required",
        title: t("chat.modelSetup.sendHint"),
      });
    },
  }));
  useEffect(
    () => () => {
      animations.current.forEach((animation) => animation.cancel());
    },
    []
  );
  const label = binding.label;
  // The catalogue's rows are read only while the picker is open: a closed
  // chip touches ids, never the (lazily materialised) labels.
  const chosenProvider = providerGroupOf(
    binding.groups,
    binding.value ?? binding.resolved
  );
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
    ? rowsFor(binding, rail, q)
    : { rows: [], sections: [] };
  const selected =
    rows.find(
      (row) =>
        row.kind === "item" &&
        row.item.locked == null &&
        row.item.id === (binding.value ?? "")
    ) ?? null;
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (!next) {
      setQuery("");
      setRailChoice(null);
      setConnected(false);
    }
  };
  const pick = (row: ModelRow | null) => {
    if (row == null) return;
    // A model the plan does not include is never chosen: it opens the upgrade.
    if (row.kind === "item" && row.item.locked != null)
      row.item.locked.onSelect();
    else if (row.kind === "item")
      binding.onChange(row.item.id === "" ? null : row.item.id);
    else row.group.connect!.onSelect();
    change(false);
  };
  const chooseRail = (next: Rail) => {
    setQuery("");
    setRailChoice(next);
  };
  // A group's mark; none (nothing resolved yet) is the app's own.
  const markOf = (group: ModelGroup | null): string =>
    group == null ? "abacus" : (markForProvider(group.id) ?? group.id);
  // A pin no provider lists is still what the chat runs: named, and marked.
  const chipMark = binding.unavailable ? (
    <AlertCircle
      aria-hidden
      className="size-4 text-[var(--chat-status-attention)]"
    />
  ) : (
    <ConnectorMark
      id={markOf(chosenProvider)}
      size={16}
      className="rounded-[5px]"
    />
  );
  const provider = compact
    ? null
    : binding.unavailable
      ? t("phase5.unavailable")
      : (chosenProvider?.label ?? null);
  const current =
    typeof rail === "string"
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
  const setup = binding.setup;
  if (setup != null && setup.status !== "ready")
    return (
      <ModelSetupPopover
        setup={setup}
        open={open}
        onOpenChange={change}
        connected={() => setConnected(true)}
      >
        <Button
          variant="ghost"
          size={compact ? "icon" : "sm"}
          ref={chip}
          data-slot="chat-model-picker"
          aria-invalid={attempt > 0 || undefined}
          aria-describedby={attempt > 0 ? descriptionId : undefined}
          aria-label={t("chat.modelSetup.unset")}
          className={cn(
            "relative h-[30px] rounded-full text-[13px] aria-invalid:border-[var(--chat-status-attention)] aria-invalid:ring-[var(--chat-status-attention)]/20",
            !compact && "px-2.5",
            open && "bg-secondary"
          )}
        >
          <span
            ref={ring}
            aria-hidden
            data-slot="chat-model-attention-ring"
            className="pointer-events-none absolute -inset-0.5 rounded-full border-2 border-[var(--chat-status-attention)] opacity-0"
          />
          <span
            id={descriptionId}
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {attempt > 0 ? (
              <span key={attempt}>{t("chat.modelSetup.sendHint")}</span>
            ) : null}
          </span>
          {compact ? (
            <AlertCircle
              aria-hidden
              className="size-3.5 text-[var(--chat-status-attention)]"
            />
          ) : (
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-[var(--chat-status-attention)]"
            />
          )}
          <span className={compact ? "sr-only" : undefined}>
            {t("chat.modelSetup.choose")}
          </span>
        </Button>
      </ModelSetupPopover>
    );
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
        row.kind === "item" ? row.item.label : row.group.connect!.label
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
            aria-label={t("chat.composer.model", {
              name: binding.unavailable
                ? `${label} (${t("phase5.unavailable")})`
                : label,
            })}
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
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <ComboboxInput
            showTrigger={false}
            placeholder={t("chat.composer.searchModels")}
            aria-label={t("chat.composer.models")}
            className="m-0! h-8! shrink-0"
          />
          {connected ? (
            <p role="status" className="text-muted-foreground px-2 py-1">
              {t("chat.modelSetup.connected")}
            </p>
          ) : null}
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
                <ComboboxGroup
                  key={group.id}
                  items={groupRows}
                  className="flex flex-col gap-0.5"
                >
                  <ComboboxLabel className="px-2 py-1 text-xs">
                    {group.label}
                  </ComboboxLabel>
                  {groupRows.map((row) => (
                    <ComboboxItem
                      key={row.key}
                      value={row}
                      data-checked={
                        row.kind === "item" &&
                        row.item.locked == null &&
                        row.item.id === (binding.value ?? "")
                      }
                      data-locked={
                        row.kind === "item" && row.item.locked != null
                          ? true
                          : undefined
                      }
                      className={ROW_CLASS}
                    >
                      {row.kind === "item" && row.item.locked != null ? (
                        <>
                          <ConnectorMark
                            id={markOf(
                              providerGroupForItem(binding, group, row.item)
                            )}
                            size={16}
                            className="rounded-[5px] opacity-50 grayscale"
                          />
                          <span className="text-muted-foreground min-w-0 flex-1 truncate">
                            {row.item.label}
                          </span>
                          <span className="text-muted-foreground flex shrink-0 items-center gap-1 pe-4 text-xs">
                            <Lock aria-hidden className="size-3" />
                            {row.item.locked.label}
                            <span className="text-primary font-medium">
                              {t("creditsCard.cta")}
                            </span>
                          </span>
                        </>
                      ) : row.kind === "item" ? (
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
                      ) : (
                        <>
                          <KeyRound
                            aria-hidden
                            className="text-muted-foreground size-3.5"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {row.group.connect!.label}
                          </span>
                        </>
                      )}
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
              <ComboboxEmpty>{t("chat.composer.noModels")}</ComboboxEmpty>
            </ComboboxList>
          )}
          {binding.onUpgrade != null ? (
            <button
              type="button"
              data-slot="chat-model-upgrade"
              className="hover:bg-foreground/[0.06] focus-visible:ring-ring/40 mt-1 flex shrink-0 items-center gap-2 rounded-lg border-t px-2 py-1.5 text-start outline-none focus-visible:ring-2"
              onClick={() => {
                setOpen(false);
                binding.onUpgrade?.();
              }}
            >
              <Sparkles
                aria-hidden
                className="text-primary size-3.5 shrink-0"
              />
              {/* A teaser: the plan's models and price are the dialog's. */}
              <span className="text-xs font-medium">
                {t("chat.composer.upgradeModels")}
              </span>
            </button>
          ) : null}
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
