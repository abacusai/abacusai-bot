import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot as BotIcon,
  Brain,
  PencilLine,
  Pin,
  Trash2,
  User,
} from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type {
  BotMemoryView,
  MemorySnapshot,
  MemoryTargetId,
} from "#shared/contracts";

import { settingsQueryKeys } from "../../lib/settings-query-keys";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageLead,
} from "../layout/focused-page";
import { Button, Textarea } from "../ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";

/**
 * What the agent remembers, and the only way to unremember it. Entries are
 * shown in full and every one is deletable. Deletes land on disk at once, but
 * a running session keeps the snapshot it started with (see memory-store.ts),
 * which the note under the title says.
 */
// Reading order: what the user asked for first, then what the agent worked out.
const TARGETS: Array<{ id: MemoryTargetId; icon: JSX.Element }> = [
  {
    id: "remember",
    icon: <Pin size={14} className="text-muted-foreground" />,
  },
  { id: "user", icon: <User size={14} className="text-muted-foreground" /> },
  {
    id: "memory",
    icon: <Brain size={14} className="text-muted-foreground" />,
  },
];

/**
 * Standing instructions: the user's note to the agent, appended last to every
 * system prompt. A draft is local until saved, so a half-typed thought is not
 * the prompt.
 */
const CustomInstructions = (): JSX.Element => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const stored = useQuery({
    queryKey: settingsQueryKeys.memory.instructions,
    queryFn: (): Promise<string> => window.api.agent.getCustomInstructions(),
    staleTime: 0,
    refetchOnMount: "always",
  });

  const saved = stored.data ?? "";

  // Seed the box once the read lands, and re-seed if it changes underneath,
  // but never over something being typed, which is what the null draft means.
  useEffect(() => {
    if (stored.data != null) setDraft((current) => current ?? stored.data);
  }, [stored.data]);

  const save = useMutation({
    mutationFn: (text: string): Promise<string> =>
      window.api.agent.setCustomInstructions(text),
    onSuccess: (next) => {
      setFailed(false);
      setDraft(next);
      queryClient.setQueryData(settingsQueryKeys.memory.instructions, next);
    },
    onError: () => setFailed(true),
  });

  const value = draft ?? saved;
  const dirty = value.trim() !== saved.trim();

  return (
    <section className="mb-6" data-id="memory-section-instructions">
      <div className="mb-2 flex items-center gap-2">
        <PencilLine size={14} className="text-muted-foreground" />
        <h2 className="text-foreground text-xs font-medium">
          {t("memory.instructions.title")}
        </h2>
      </div>
      <p className="text-muted-foreground mb-2 max-w-prose text-xs">
        {t("memory.instructions.description")}
      </p>
      <Textarea
        value={value}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t("memory.instructions.placeholder")}
        rows={5}
        data-id="memory-instructions-input"
        aria-label={t("memory.instructions.title")}
      />
      <div className="mt-2 flex items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => save.mutate(value)}
          disabled={!dirty || save.isPending}
          data-id="memory-instructions-save"
          className="h-6 px-2 text-xs"
        >
          {t("memory.instructions.save")}
        </Button>
        {failed ? (
          <span
            className="text-destructive text-xs"
            data-id="memory-instructions-error"
          >
            {t("memory.instructions.saveFailed")}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">
            {dirty
              ? t("memory.instructions.unsaved")
              : t("memory.instructions.applies")}
          </span>
        )}
      </div>
    </section>
  );
};

/**
 * Each bot's own memory: the curated core is shown in full and deletable;
 * daily notes appear only as a count, being a working record, not facts.
 */
const BotMemories = (): JSX.Element | null => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmingClear, setConfirmingClear] = useState<string | null>(null);

  const bots = useQuery({
    queryKey: settingsQueryKeys.memory.bots,
    queryFn: (): Promise<BotMemoryView[]> => window.api.agent.listBotMemories(),
    staleTime: 0,
    refetchOnMount: "always",
  });

  const applyViews = (views: BotMemoryView[]): void => {
    queryClient.setQueryData(settingsQueryKeys.memory.bots, views);
  };

  const forget = useMutation({
    mutationFn: (request: { botId: string; index: number; entry: string }) =>
      window.api.agent.forgetBotMemory(request),
    onSuccess: applyViews,
    // A refused delete re-reads the list: the store's answer beats the click.
    onError: () => void bots.refetch(),
  });

  const clear = useMutation({
    mutationFn: (botId: string) => window.api.agent.clearBotMemory(botId),
    onSuccess: (views) => {
      applyViews(views);
      setConfirmingClear(null);
    },
    onError: () => setConfirmingClear(null),
  });

  const views = bots.data ?? [];

  if (bots.isLoading || views.length === 0) return null;

  return (
    <div className="mt-8 flex flex-col gap-6" data-id="memory-bots">
      <h2 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
        {t("memory.sections.bots")}
      </h2>
      {views.map((view) => (
        <section key={view.botId} data-id={`memory-bot-${view.botId}`}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <BotIcon size={14} className="text-muted-foreground" />
              <h3 className="text-foreground text-xs font-medium">
                {view.name}
              </h3>
              <span className="text-muted-foreground text-xs tabular-nums">
                {view.entries.length}
              </span>
            </div>
            {view.entries.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingClear(view.botId)}
                data-id={`memory-bot-clear-${view.botId}`}
                className="text-muted-foreground"
              >
                {t("memory.clear")}
              </Button>
            )}
          </div>
          {view.noteDays > 0 && (
            <p className="text-muted-foreground mb-2 max-w-prose text-xs">
              {t("memory.bots.notes", { count: view.noteDays })}
            </p>
          )}
          {view.entries.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {t("memory.bots.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {view.entries.map((entry, index) => (
                <li
                  key={`${view.botId}:${index}:${entry.slice(0, 40)}`}
                  data-id={`memory-bot-entry-${view.botId}-${index}`}
                  className="group/entry border-border bg-muted/50 flex items-start justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <span className="text-foreground text-xs break-words whitespace-pre-wrap">
                    {entry}
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      forget.mutate({ botId: view.botId, index, entry })
                    }
                    data-id={`memory-bot-forget-${view.botId}-${index}`}
                    title={t("memory.forget")}
                    className="text-muted-foreground hover:text-destructive h-6 shrink-0 px-1.5 opacity-0 transition-opacity group-hover/entry:opacity-100"
                  >
                    <Trash2 size={13} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <AlertDialog
        open={confirmingClear != null}
        onOpenChange={(open) => {
          if (!open) setConfirmingClear(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("memory.clear")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("memory.clearConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-id="memory-bot-clear-cancel">
              {t("memory.clearNo")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={confirmingClear == null || clear.isPending}
              data-id="memory-bot-clear-confirm"
              onClick={() => {
                if (confirmingClear != null) clear.mutate(confirmingClear);
              }}
            >
              {t("memory.clearYes")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export const MemoryPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmingClear, setConfirmingClear] = useState<MemoryTargetId | null>(
    null
  );
  // A delete that did not happen. Cleared by the next successful delete, not
  // by a refetch, so it can sit above a list changed underneath it.
  const [writeFailed, setWriteFailed] = useState(false);

  const memories = useQuery({
    queryKey: settingsQueryKeys.memory.snapshot,
    // No empty-snapshot fallback: "nothing remembered" and "could not read"
    // would look identical and mean opposite things.
    queryFn: (): Promise<MemorySnapshot> => window.api.agent.listMemories(),
    // Another process writes these files mid-session.
    staleTime: 0,
    refetchOnMount: "always",
  });

  // Both mutations return the store's new state, so the list re-renders from
  // what is actually on disk rather than from what the click assumed.
  const applySnapshot = (snapshot: MemorySnapshot): void => {
    queryClient.setQueryData(settingsQueryKeys.memory.snapshot, snapshot);
  };

  const forget = useMutation({
    mutationFn: (request: {
      target: MemoryTargetId;
      index: number;
      entry: string;
    }) => window.api.agent.forgetMemory(request),
    onSuccess: (snapshot) => {
      setWriteFailed(false);
      applySnapshot(snapshot);
    },
    // The store refuses to write while another session holds it; nothing was
    // deleted, so say so.
    onError: () => setWriteFailed(true),
  });

  const forgetAll = useMutation({
    mutationFn: (target: MemoryTargetId) =>
      window.api.agent.forgetAllMemories(target),
    onSuccess: (snapshot) => {
      setWriteFailed(false);
      applySnapshot(snapshot);
      setConfirmingClear(null);
    },
    onError: () => {
      setWriteFailed(true);
      setConfirmingClear(null);
    },
  });

  const snapshot = memories.data ?? { memory: [], user: [], remember: [] };
  // A snapshot from an older main may lack a store's key entirely.
  const entriesFor = (id: MemoryTargetId): string[] => snapshot[id] ?? [];
  const total = TARGETS.reduce(
    (sum, target) => sum + entriesFor(target.id).length,
    0
  );

  return (
    <FocusedPage data-id="memory-panel">
      <FocusedPageBody>
        <FocusedPageLead description={t("memory.subtitle")} />
        {/* Outside the branches below: the box is the user's to write whether
            or not the agent has remembered anything yet. */}
        <CustomInstructions />

        {/* Sessions and bots remember separately (a bot's memory is its own
            and lives with the bot), so the page says which is which. */}
        <h2
          className="text-muted-foreground mb-4 text-[11px] font-semibold tracking-wide uppercase"
          data-id="memory-sessions-heading"
        >
          {t("memory.sections.sessions")}
        </h2>

        {memories.isLoading ? (
          <p className="text-muted-foreground text-xs">{t("memory.loading")}</p>
        ) : memories.isError ? (
          <p
            className="text-destructive max-w-prose text-xs"
            data-id="memory-error"
          >
            {t("memory.readFailed")}
          </p>
        ) : total === 0 ? (
          <p
            className="text-muted-foreground max-w-prose text-xs"
            data-id="memory-empty"
          >
            {t("memory.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {writeFailed && (
              <p
                className="text-destructive max-w-prose text-xs"
                data-id="memory-write-error"
              >
                {t("memory.writeFailed")}
              </p>
            )}
            {TARGETS.map(({ id, icon }) => {
              const entries = entriesFor(id);

              return (
                <section key={id} data-id={`memory-section-${id}`}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      {icon}
                      <h2 className="text-foreground text-xs font-medium">
                        {t(`memory.stores.${id}.title`)}
                      </h2>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {entries.length}
                      </span>
                    </div>
                    {entries.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmingClear(id)}
                        data-id={`memory-clear-${id}`}
                        className="text-muted-foreground"
                      >
                        {t("memory.clear")}
                      </Button>
                    )}
                  </div>

                  <p className="text-muted-foreground mb-2 max-w-prose text-xs">
                    {t(`memory.stores.${id}.help`)}
                  </p>

                  {entries.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {t("memory.storeEmpty")}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {entries.map((entry, index) => (
                        <li
                          key={`${id}:${index}:${entry.slice(0, 40)}`}
                          data-id={`memory-entry-${id}-${index}`}
                          className="group/entry border-border bg-muted/50 flex items-start justify-between gap-3 rounded-md border px-3 py-2"
                        >
                          {/* Whole entries, wrapped: a memory you cannot read in
                              full is one you cannot decide about. */}
                          <span className="text-foreground text-xs break-words whitespace-pre-wrap">
                            {entry}
                          </span>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              forget.mutate({ target: id, index, entry })
                            }
                            data-id={`memory-forget-${id}-${index}`}
                            title={t("memory.forget")}
                            className="text-muted-foreground hover:text-destructive h-6 shrink-0 px-1.5 opacity-0 transition-opacity group-hover/entry:opacity-100"
                          >
                            <Trash2 size={13} />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}

        <BotMemories />
      </FocusedPageBody>
      <AlertDialog
        open={confirmingClear != null}
        onOpenChange={(open) => {
          if (!open) setConfirmingClear(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("memory.clear")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("memory.clearConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-id={`memory-clear-cancel-${confirmingClear ?? "none"}`}
            >
              {t("memory.clearNo")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={confirmingClear == null || forgetAll.isPending}
              data-id={`memory-clear-confirm-${confirmingClear ?? "none"}`}
              onClick={() => {
                if (confirmingClear != null) forgetAll.mutate(confirmingClear);
              }}
            >
              {t("memory.clearYes")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FocusedPage>
  );
};
