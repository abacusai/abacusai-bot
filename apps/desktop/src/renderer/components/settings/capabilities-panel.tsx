import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Puzzle, Search, Wrench } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import {
  SELECTABLE_EXEC_BACKENDS,
  type BackendId,
  type BackendStatus,
} from "#shared/exec-backends";
import { TERMINAL_SHELLS, type TerminalShellId } from "#shared/terminal-shells";
import { TOOLSETS_FOR_DISPLAY, type Toolset } from "#shared/toolsets";

import {
  useSetTerminalShell,
  useTerminalShellState,
} from "../../hooks/use-terminal-shells";
import { settingsQueryKeys } from "../../lib/settings-query-keys";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageToolbar,
} from "../layout/focused-page";
import {
  Alert,
  AlertDescription,
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Switch,
} from "../ui";
import { Badge } from "../ui/badge";

/**
 * The toolset list and the detail pane for whichever one is selected.
 *
 * Switches update immediately while the authoritative map is written in main;
 * failures roll the cache back and a successful response replaces the map.
 */
const useToolsetSettings = () => {
  const queryClient = useQueryClient();
  const statesQuery = useQuery({
    queryKey: settingsQueryKeys.capabilities.toolsets,
    queryFn: async () => (await window.api?.agent?.getToolsetStates?.()) ?? {},
    staleTime: 10_000,
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      (await window.api?.agent?.setToolsetEnabled?.(id, enabled)) ?? {},
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({
        queryKey: settingsQueryKeys.capabilities.toolsets,
      });
      const previous = queryClient.getQueryData<Record<string, boolean>>(
        settingsQueryKeys.capabilities.toolsets
      );
      queryClient.setQueryData<Record<string, boolean>>(
        settingsQueryKeys.capabilities.toolsets,
        (current = {}) => ({ ...current, [id]: enabled })
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      queryClient.setQueryData(
        settingsQueryKeys.capabilities.toolsets,
        context?.previous ?? {}
      );
    },
    onSuccess: (states) =>
      queryClient.setQueryData(settingsQueryKeys.capabilities.toolsets, states),
  });

  return { states: statesQuery.data ?? {}, toggle };
};

export const ToolsPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const { states, toggle } = useToolsetSettings();

  // Matches the label and the tool names: someone searching "web_fetch" should
  // not have to know it lives under "Web Search".
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return TOOLSETS_FOR_DISPLAY;

    return TOOLSETS_FOR_DISPLAY.filter((toolset) => {
      const label = t(
        `capabilities.toolsets.${toolset.labelKey}.label`
      ).toLowerCase();
      return (
        label.includes(needle) ||
        toolset.tools.some((tool) => tool.name.toLowerCase().includes(needle))
      );
    });
  }, [query, t]);

  return (
    <FocusedPage data-id="capabilities-tools">
      <FocusedPageToolbar>
        <InputGroup className="min-w-48 flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("capabilities.tools.searchPlaceholder")}
            data-id="capabilities-tools-search"
          />
        </InputGroup>
      </FocusedPageToolbar>
      <FocusedPageBody>
        {matches.length > 0 ? (
          <ItemGroup className="gap-2">
            {matches.map((toolset) => (
              <Item key={toolset.id} variant="outline">
                <ItemMedia variant="icon">
                  <Wrench />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <Link
                    to="/settings/tools/$toolsetId"
                    params={{ toolsetId: toolset.id }}
                    className="min-w-0 rounded-sm outline-none focus-visible:ring-2"
                  >
                    <ItemTitle>
                      {t(`capabilities.toolsets.${toolset.labelKey}.label`)}
                    </ItemTitle>
                    <ItemDescription>
                      {t(
                        `capabilities.toolsets.${toolset.labelKey}.description`
                      )}
                    </ItemDescription>
                  </Link>
                </ItemContent>
                <ItemActions>
                  <Switch
                    checked={states[toolset.id] === true}
                    disabled={
                      toggle.isPending && toggle.variables?.id === toolset.id
                    }
                    onCheckedChange={(enabled) =>
                      toggle.mutate({ id: toolset.id, enabled })
                    }
                    aria-label={t(
                      `capabilities.toolsets.${toolset.labelKey}.label`
                    )}
                  />
                  <Button
                    render={
                      <Link
                        to="/settings/tools/$toolsetId"
                        params={{ toolsetId: toolset.id }}
                      />
                    }
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t(
                      `capabilities.toolsets.${toolset.labelKey}.label`
                    )}
                  >
                    <ChevronRight />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <p
            className="text-muted-foreground py-10 text-center text-sm"
            data-id="capabilities-tools-no-matches"
          >
            {t("capabilities.tools.noMatches")}
          </p>
        )}
      </FocusedPageBody>
    </FocusedPage>
  );
};

export const ToolsetPanel = ({
  toolset,
}: {
  toolset: Toolset;
}): JSX.Element => {
  const { t } = useTranslation();
  const { states, toggle } = useToolsetSettings();
  const enabled = states[toolset.id] === true;

  return (
    <FocusedPage data-id={`capabilities-toolset-${toolset.id}`}>
      <FocusedPageToolbar>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-4">
          <span className="truncate text-xs font-medium">
            {t(`capabilities.toolsets.${toolset.labelKey}.label`)}
          </span>
          <Switch
            checked={enabled}
            disabled={toggle.isPending && toggle.variables?.id === toolset.id}
            onCheckedChange={(nextEnabled) =>
              toggle.mutate({ id: toolset.id, enabled: nextEnabled })
            }
            aria-label={t(`capabilities.toolsets.${toolset.labelKey}.label`)}
          />
        </div>
      </FocusedPageToolbar>
      <FocusedPageBody>
        <ToolsetDetail toolset={toolset} enabled={enabled} />
      </FocusedPageBody>
    </FocusedPage>
  );
};

const ToolsetDetail = ({
  toolset,
  enabled,
}: {
  toolset: Toolset;
  enabled: boolean;
}): JSX.Element => {
  const { t } = useTranslation();
  const planned = toolset.status === "planned";

  return (
    <div
      className="mx-auto max-w-2xl space-y-4"
      data-id={`capabilities-toolset-detail-${toolset.id}`}
    >
      <div>
        <h2 className="text-foreground text-sm font-semibold">
          {t(`capabilities.toolsets.${toolset.labelKey}.label`)}
        </h2>
        <p className="text-secondary-foreground mt-1 text-xs">
          {t(`capabilities.toolsets.${toolset.labelKey}.description`)}
        </p>
      </div>

      {planned ? (
        // Not "needs setup": that sends people looking for a key to enter, and
        // there is none, only work not done yet.
        <p
          className="border-border bg-sidebar text-muted-foreground rounded-md border px-3 py-2 text-xs"
          data-id={`capabilities-toolset-planned-${toolset.id}`}
        >
          {t("capabilities.tools.plannedDetail")}
        </p>
      ) : (
        <p
          className="text-muted-foreground text-xs"
          data-id={`capabilities-toolset-state-${toolset.id}`}
        >
          {enabled
            ? t("capabilities.tools.enabledDetail")
            : t("capabilities.tools.disabledDetail")}
        </p>
      )}

      {toolset.tools.length > 0 ? (
        <div className="border-border overflow-hidden rounded-lg border">
          {toolset.tools.map((tool, index) => (
            <div
              key={tool.name}
              data-id={`capabilities-tool-${tool.name}`}
              className={`flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-4 ${
                index > 0 ? "border-input border-t" : ""
              }`}
            >
              <code className="text-foreground shrink-0 font-mono text-xs sm:w-44">
                {tool.name}
              </code>
              <span className="text-secondary-foreground text-xs">
                {t(`capabilities.toolDescriptions.${tool.descriptionKey}`)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p
          className="text-muted-foreground text-xs"
          data-id={`capabilities-toolset-no-tools-${toolset.id}`}
        >
          {t("capabilities.tools.noModelTools")}
        </p>
      )}

      {/* Terminal & Processes has a target as well as a switch. */}
      {toolset.id === "terminal" && !planned && <SandboxToggle />}
      {toolset.id === "terminal" && !planned && <ExecBackendPicker />}
      {toolset.id === "terminal" && !planned && <TerminalShellPicker />}

      {/* X search has a choice of engine behind it. */}
      {toolset.id === "x_search" && !planned && <XaiSearchToggle />}

      {toolset.delivery === "builtin" && !planned && (
        <p
          className="text-muted-foreground text-xs"
          data-id="capabilities-tools-restart-note"
        >
          <Wrench className="mr-1.5" />
          {t("capabilities.tools.restartNote")}
        </p>
      )}

      <McpToolsNote />
    </div>
  );
};

/**
 * Whether the OS confines what a command can write. Windows has no backend yet,
 * so the caveat is shown rather than the toggle hidden: a user who turns it on
 * there should know it does nothing.
 */
const SandboxToggle = (): JSX.Element => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const enabledQuery = useQuery({
    queryKey: settingsQueryKeys.capabilities.sandbox,
    queryFn: async () =>
      (await window.api?.agent?.getSandboxEnabled?.()) ?? false,
    staleTime: 10_000,
  });

  const flip = useMutation({
    mutationFn: async (next: boolean) =>
      (await window.api?.agent?.setSandboxEnabled?.(next)) ?? false,
    onSuccess: (state) =>
      queryClient.setQueryData(settingsQueryKeys.capabilities.sandbox, state),
  });

  const enabled = enabledQuery.data ?? false;
  const unsupported = navigator.userAgent.includes("Windows");

  return (
    <div className="space-y-2" data-id="sandbox-toggle">
      <h3 className="text-secondary-foreground text-xs font-semibold tracking-wide uppercase">
        {t("sandbox.title")}
      </h3>

      <div className="border-border flex items-start gap-3 rounded-lg border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-xs">{t("sandbox.label")}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t("sandbox.description")}
          </p>
          {enabled && unsupported && (
            <p
              className="mt-1 text-xs text-amber-500"
              data-id="sandbox-unsupported"
            >
              {t("sandbox.unsupported")}
            </p>
          )}
        </div>

        <Switch
          checked={enabled}
          onCheckedChange={() => flip.mutate(!enabled)}
          disabled={flip.isPending}
          aria-label={t("sandbox.label")}
          data-id="sandbox-enabled-toggle"
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    </div>
  );
};

/**
 * Where an X search goes: off (default), the agent scopes web search to x.com;
 * on, the query is sent to xAI's Live Search. A switch rather than implied by
 * an xAI key, because "let me run Grok" should not also decide that every X
 * search leaves for a vendor the user never picked as a search engine.
 */
const XaiSearchToggle = (): JSX.Element => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const enabledQuery = useQuery({
    queryKey: settingsQueryKeys.capabilities.xaiSearch,
    queryFn: async () =>
      (await window.api?.agent?.getXaiSearchEnabled?.()) ?? false,
    staleTime: 10_000,
  });

  const flip = useMutation({
    mutationFn: async (next: boolean) =>
      (await window.api?.agent?.setXaiSearchEnabled?.(next)) ?? false,
    onSuccess: (state) =>
      queryClient.setQueryData(settingsQueryKeys.capabilities.xaiSearch, state),
  });

  const enabled = enabledQuery.data ?? false;

  return (
    <div className="space-y-2" data-id="xai-search-toggle">
      <h3 className="text-secondary-foreground text-xs font-semibold tracking-wide uppercase">
        {t("xaiSearch.title")}
      </h3>

      <div className="border-border flex items-start gap-3 rounded-lg border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-xs">{t("xaiSearch.label")}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t("xaiSearch.description")}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("xaiSearch.envNote")}
          </p>
        </div>

        <Switch
          checked={enabled}
          onCheckedChange={() => flip.mutate(!enabled)}
          disabled={flip.isPending}
          aria-label={t("xaiSearch.label")}
          data-id="xai-search-enabled-toggle"
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    </div>
  );
};

/**
 * Where shell commands run. Every backend is listed, unpickable ones with the
 * specific reason: hiding them hides that the option exists, and a generic
 * "needs setup" sends someone looking for a credential that would not help.
 */

const ExecBackendPicker = (): JSX.Element => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const stateQuery = useQuery({
    queryKey: settingsQueryKeys.capabilities.execBackend,
    queryFn: async () =>
      (await window.api?.agent?.getExecBackendState?.()) ?? null,
    staleTime: 10_000,
  });

  const choose = useMutation({
    mutationFn: async (backend: BackendId) =>
      (await window.api?.agent?.setExecBackend?.(backend)) ?? null,
    onSuccess: (state) => {
      if (state != null)
        queryClient.setQueryData(
          settingsQueryKeys.capabilities.execBackend,
          state
        );
    },
  });

  const state = stateQuery.data;

  if (state == null) return <></>;

  const blockerText = (status: BackendStatus): string | null => {
    if (status.blocker == null) return null;
    if (status.blocker.kind === "unimplemented")
      return t("execBackends.unimplemented");
    if (status.blocker.kind === "unsupported-platform")
      return t("execBackends.unsupportedPlatform");
    if (status.blocker.kind === "missing-binary") {
      return t("execBackends.missingBinary", {
        command: status.blocker.command,
      });
    }
    return t("execBackends.missingEnv", {
      vars: status.blocker.vars.join(", "),
    });
  };

  return (
    <div className="space-y-2" data-id="exec-backend-picker">
      <h3 className="text-secondary-foreground text-xs font-semibold tracking-wide uppercase">
        {t("execBackends.title")}
      </h3>

      {/* Only shown when they diverge — otherwise it is noise on every render. */}
      {state.effective !== state.selected && (
        <Alert data-id="exec-backend-fallback">
          <AlertDescription>
            {t("execBackends.fellBack", {
              selected: t(`execBackends.${state.selected}.label`),
              effective: t(`execBackends.${state.effective}.label`),
            })}
          </AlertDescription>
        </Alert>
      )}

      <ItemGroup className="gap-2">
        {SELECTABLE_EXEC_BACKENDS.map((backend) => {
          const status = state.statuses.find(
            (entry) => entry.id === backend.id
          );
          const ready = status?.ready === true;
          const active = state.effective === backend.id;
          const blocker = status != null ? blockerText(status) : null;

          return (
            <Item
              key={backend.id}
              render={
                <button type="button" disabled={!ready || choose.isPending} />
              }
              variant={active ? "muted" : "outline"}
              onClick={() => choose.mutate(backend.id)}
              data-id={`exec-backend-${backend.id}`}
              className="items-start disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ItemContent>
                <ItemTitle>
                  {t(`execBackends.${backend.labelKey}.label`)}
                  {active && (
                    <Badge variant="secondary">{t("execBackends.inUse")}</Badge>
                  )}
                </ItemTitle>
                <ItemDescription>
                  {t(`execBackends.${backend.labelKey}.description`)}
                </ItemDescription>
                {blocker != null && (
                  <ItemDescription
                    className="text-amber-600 dark:text-amber-400"
                    data-id={`exec-backend-blocker-${backend.id}`}
                  >
                    {blocker}
                  </ItemDescription>
                )}
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
    </div>
  );
};

/**
 * Which shell the terminal panel opens. The same preference the panel's `+`
 * menu writes: whichever place it is picked, the next terminal that opens by
 * itself uses it.
 */
const TerminalShellPicker = (): JSX.Element => {
  const { t } = useTranslation();
  const state = useTerminalShellState();
  const choose = useSetTerminalShell();

  if (state == null) return <></>;

  const labelKey = (id: TerminalShellId): string =>
    TERMINAL_SHELLS.find((shell) => shell.id === id)?.labelKey ?? id;

  return (
    <div className="space-y-2" data-id="terminal-shell-picker">
      <h3 className="text-secondary-foreground text-xs font-semibold tracking-wide uppercase">
        {t("terminalShells.title")}
      </h3>

      {/* Only when they diverge: a stored shell that no longer exists is
          otherwise a silent substitution. */}
      {state.effective !== state.selected && (
        <Alert data-id="terminal-shell-fallback">
          <AlertDescription>
            {t("terminalShells.fellBack", {
              selected: t(`terminalShells.${labelKey(state.selected)}.label`),
              effective: t(`terminalShells.${labelKey(state.effective)}.label`),
            })}
          </AlertDescription>
        </Alert>
      )}

      <ItemGroup className="gap-2">
        {state.statuses.map((status) => {
          const active = state.effective === status.id;

          return (
            <Item
              key={status.id}
              render={<button type="button" disabled={!status.available} />}
              variant={active ? "muted" : "outline"}
              onClick={() => choose(status.id)}
              data-id={`terminal-shell-${status.id}`}
              className="items-start disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ItemContent>
                <ItemTitle>
                  {t(`terminalShells.${labelKey(status.id)}.label`)}
                  {active && (
                    <Badge variant="secondary">
                      {t("terminalShells.inUse")}
                    </Badge>
                  )}
                </ItemTitle>
                <ItemDescription>
                  {t(`terminalShells.${labelKey(status.id)}.description`)}
                </ItemDescription>
                {!status.available && (
                  <ItemDescription
                    className="text-amber-600 dark:text-amber-400"
                    data-id={`terminal-shell-missing-${status.id}`}
                  >
                    {t("terminalShells.notInstalled")}
                  </ItemDescription>
                )}
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
    </div>
  );
};

/** Tools that come from user-configured MCP servers aren't in the static catalog. */
const McpToolsNote = (): JSX.Element => {
  const { t } = useTranslation();
  return (
    <p
      className="text-muted-foreground flex items-center gap-2 text-xs"
      data-id="capabilities-tools-mcp-note"
    >
      <Puzzle />
      {t("capabilities.tools.mcpNote")}
    </p>
  );
};
