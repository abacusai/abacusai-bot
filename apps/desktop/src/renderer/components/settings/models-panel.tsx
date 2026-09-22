import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  LogIn,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import {
  isPlausibleApiKey,
  PROVIDER_KEY_FIELDS,
  type ProviderKeyField,
} from "#shared/settings";

import {
  useModelProvidersQuery,
  type ModelProviderState,
} from "../../hooks/use-model-providers";
import { signInToAbacus } from "../../lib/abacus-sign-in";
import { settingsQueryKeys } from "../../lib/settings-query-keys";
import { ProviderMark } from "../chat/provider-mark";
import { Dialog as ConfirmDialog } from "../common/dialog";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageToolbar,
} from "../layout/focused-page";
import { LocalModelsSection } from "../local-models/local-models-section";
import {
  Button,
  Input,
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
  Spinner,
} from "../ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

// Model provider keys. They go to `~/.abacusai-bot/config.json` and into the
// agent's environment at spawn; a key already exported in the shell wins and
// shows as configured with nothing to type.
export const ModelsSettingsPanel = ({
  onKeysChanged,
  provider,
  onProviderChange,
}: {
  onKeysChanged?: () => void;
  provider?: string | null;
  onProviderChange?: (provider: string | null) => void;
}): JSX.Element | null => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<ProviderKeyField | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Which attempt owns the spinner: a restarted hop's abandoned promise still
  // runs its `finally` and would clear the new attempt's spinner.
  const attempt = useRef(0);

  // Give up on the hop in flight: it ends in a browser we cannot see into, so
  // the wait must have a way out short of the twenty-minute budget.
  const cancelConnect = (): void => {
    void window.api?.agent?.cancelOpenRouterAuth?.();
    void window.api?.agent?.cancelAbacusAuth?.();
    attempt.current += 1;
    setConnecting(null);
  };

  // Closing the panel abandons the hop rather than leaving its loopback server
  // bound for the rest of the budget.
  useEffect(
    () => () => {
      void window.api?.agent?.cancelOpenRouterAuth?.();
      void window.api?.agent?.cancelAbacusAuth?.();
    },
    []
  );

  // Two questions, neither needing a secret: can this provider run, and is
  // its key one we put on disk (so Remove has something to remove).
  const providersQuery = useModelProvidersQuery();
  const configured = providersQuery.data?.configured ?? {};
  const stored = providersQuery.data?.stored ?? new Set<string>();
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({
      queryKey: settingsQueryKeys.models.all,
    });
  };

  // Re-read whenever a key is stored anywhere: onboarding's sign-in lands after
  // this panel resolved "no key".
  useEffect(() => {
    return window.api.agent.onEvent((event) => {
      if (event.type === "credentials-changed") {
        void queryClient.invalidateQueries({
          queryKey: settingsQueryKeys.models.all,
        });
      }
    });
  }, [queryClient]);

  // Sign in in the browser instead of pasting a key; the key comes back
  // without being shown. The field's `connect` discriminator picks the flow.
  const connectProvider = async (
    flow: "openrouter" | "abacus"
  ): Promise<void> => {
    attempt.current += 1;
    const mine = attempt.current;
    setConnecting(flow);
    setConnectError(null);
    try {
      const result =
        flow === "abacus"
          ? await signInToAbacus()
          : await window.api.agent.startOpenRouterAuth();
      if (result.ok === true) {
        const providerId = flow === "abacus" ? "abacus" : "openrouter";
        queryClient.setQueryData<ModelProviderState>(
          settingsQueryKeys.models.providers,
          (current = { configured: {}, stored: new Set() }) => ({
            configured: { ...current.configured, [providerId]: true },
            stored: new Set(current.stored).add(providerId),
          })
        );
        await refresh();
        onKeysChanged?.();
        onProviderChange?.(null);
        return;
      }
      // A cancelled sign-in is a decision, not a failure.
      if (result.cancelled !== true) setConnectError(result.error);
    } finally {
      // Only stand down if this attempt still owns the spinner.
      if (attempt.current === mine) setConnecting(null);
    }
  };

  const dirty = Object.values(drafts).some((value) => value.trim().length > 0);

  // Write every edited field, then re-read the world. Nothing here proves a
  // key works; it only refuses a paste that could not be one (an `export`
  // line, a URL, half a key) instead of storing it.
  const saveAll = async (): Promise<boolean> => {
    const edited = Object.entries(drafts).filter(
      ([, value]) => value.trim().length > 0
    );

    if (edited.length === 0) return true;

    const rejected = new Set(
      edited
        .filter(([, key]) => !isPlausibleApiKey(key))
        .map(([provider]) => provider)
    );

    setInvalid(rejected);
    if (rejected.size > 0) return false;

    const previous = queryClient.getQueryData<ModelProviderState>(
      settingsQueryKeys.models.providers
    );
    queryClient.setQueryData<ModelProviderState>(
      settingsQueryKeys.models.providers,
      (current = { configured: {}, stored: new Set() }) => {
        const configured = { ...current.configured };
        const stored = new Set(current.stored);
        for (const [provider] of edited) {
          configured[provider] = true;
          stored.add(provider);
        }
        return { configured, stored };
      }
    );
    try {
      for (const [provider, key] of edited) {
        await window.api.agent.saveApiKey(provider, key);
      }
    } catch (error) {
      queryClient.setQueryData(settingsQueryKeys.models.providers, previous);
      throw error;
    }

    setDrafts({});
    // A new key can change which models exist at all (OpenRouter's free tier),
    // so the catalog is refetched rather than left to go stale.
    await window.api.agent.listModels(true);
    await refresh();
    onKeysChanged?.();

    return true;
  };

  // Forget a stored key: `saveApiKey` deletes the entry on an empty string.
  // Removing the Abacus key takes the connector gateway with it, as sign-out
  // does; that MCP entry authenticates with the key being dropped.
  const removeKey = async (field: ProviderKeyField): Promise<void> => {
    const previous = queryClient.getQueryData<ModelProviderState>(
      settingsQueryKeys.models.providers
    );
    queryClient.setQueryData<ModelProviderState>(
      settingsQueryKeys.models.providers,
      (current = { configured: {}, stored: new Set() }) => {
        const configured = { ...current.configured, [field.provider]: false };
        const stored = new Set(current.stored);
        stored.delete(field.provider);
        return { configured, stored };
      }
    );
    try {
      await window.api.agent.saveApiKey(field.provider, "");
    } catch (error) {
      queryClient.setQueryData(settingsQueryKeys.models.providers, previous);
      throw error;
    }
    await window.api.agent.listModels(true);
    await refresh();
    onKeysChanged?.();
  };

  const cancel = (): void => {
    setDrafts({});
    setInvalid(new Set());
    setConnectError(null);
  };

  // One provider, one card: name, pitch, and the configured check, the
  // browser connect button, or a key field, plus the signup link.
  const providerCard = (
    field: ProviderKeyField,
    detailed = false
  ): JSX.Element =>
    !detailed ? (
      <Item
        key={field.provider}
        render={
          <button
            type="button"
            onClick={() => onProviderChange?.(field.provider)}
          />
        }
        variant="outline"
        // Top-aligned: the grid stretches a card to its row, and a centred
        // body under a top-pinned icon puts the icon a line above its name.
        className="items-start"
        data-id={`api-key-card-${field.provider}`}
      >
        <ItemMedia variant="icon">
          <ProviderMark provider={field.provider} className="size-5" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{field.label}</ItemTitle>
          <ItemDescription>{field.hint}</ItemDescription>
        </ItemContent>
        <ItemActions>
          {configured[field.provider] && (
            <span className="text-primary flex items-center gap-1 text-xs">
              <Check className="size-3.5" />
              {t("apiKeys.configured")}
            </span>
          )}
          {configured[field.provider] ? (
            <Settings2 className="text-muted-foreground size-4" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4" />
          )}
        </ItemActions>
      </Item>
    ) : (
      <div
        key={field.provider}
        data-id={`api-key-card-${field.provider}`}
        className="border-border bg-muted/20 flex flex-col gap-1.5 rounded-xl border p-3"
      >
        <div className="flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <ProviderMark
              provider={field.provider}
              className="size-5 shrink-0"
            />
            <div className="text-foreground truncate text-xs font-medium">
              {field.label}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            data-id={`api-key-signup-${field.provider}`}
            onClick={() => window.api.openExternal(field.signupUrl)}
            aria-label={t("apiKeys.getKey")}
            className="-my-1 shrink-0"
          >
            <ExternalLink size={11} />
          </Button>
        </div>

        <div
          className="text-muted-foreground line-clamp-2 min-h-6.5 text-[0.625rem]"
          title={field.hint}
        >
          {field.hint}
        </div>

        {configured[field.provider] ? (
          <div className="flex items-center gap-1.5">
            {/* "Configured" is a claim the app can only stand behind where it
              actually used the key: the two browser sign-ins mint it and fetch
              a catalog with it. A pasted key has been stored and nothing more,
              and saying so beats a checkmark that turns into an auth error on
              the first token of the first turn. */}
            <div
              data-id={`api-key-state-${field.provider}`}
              title={
                field.connect != null ? undefined : t("apiKeys.notVerifiedHint")
              }
              className="border-border bg-muted/40 text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs"
            >
              {field.connect != null ? (
                <>
                  <Check size={11} className="text-primary" />
                  <span className="truncate">{t("apiKeys.configured")}</span>
                </>
              ) : (
                <>
                  <CircleAlert size={11} className="text-muted-foreground" />
                  <span className="truncate">{t("apiKeys.notVerified")}</span>
                </>
              )}
            </div>
            {/* Only a key we wrote can be taken back: an exported environment
              variable belongs to the shell that set it. */}
            {stored.has(field.provider) && (
              <Button
                variant="ghost"
                size="icon"
                data-id={`api-key-remove-${field.provider}`}
                onClick={() => setRemoving(field)}
                aria-label={t("apiKeys.remove")}
                title={t("apiKeys.remove")}
                className="shrink-0"
              >
                <Trash2 size={11} />
              </Button>
            )}
          </div>
        ) : field.connect != null ? (
          <div className="flex shrink-0 items-center gap-1">
            {/* Live while its own hop is out. The sign-in can strand a user in
                the browser — a signup funnel that drops the authorize step is
                the common one — and the moment they most need to try again is
                exactly when this used to be disabled. Pressing it restarts the
                hop; the main process is single-flight and stands the old one
                down. Only the other providers' buttons go quiet. */}
            <Button
              size="sm"
              data-id={`api-key-connect-${field.provider}`}
              disabled={connecting != null && connecting !== field.connect}
              onClick={() => void connectProvider(field.connect!)}
            >
              {connecting === field.connect ? (
                <Spinner fontSize={11} className="text-white" />
              ) : (
                <LogIn size={11} />
              )}
              {field.connect === "abacus"
                ? t("apiKeys.connectAbacus")
                : t("apiKeys.connectOpenRouter")}
            </Button>

            {/* Only while a hop is out: a permanent cancel would be a control
                for a state the user is not in. */}
            {connecting === field.connect && (
              <Button
                variant="ghost"
                size="sm"
                data-id={`api-key-connect-cancel-${field.provider}`}
                onClick={cancelConnect}
                className="text-muted-foreground hover:text-secondary-foreground"
              >
                {t("common.cancel")}
              </Button>
            )}
          </div>
        ) : (
          <>
            <Input
              type="password"
              data-id={`api-key-input-${field.provider}`}
              value={drafts[field.provider] ?? ""}
              onChange={(e) => {
                setInvalid((prev) => {
                  if (!prev.has(field.provider)) return prev;
                  const next = new Set(prev);
                  next.delete(field.provider);
                  return next;
                });
                setDrafts((prev) => ({
                  ...prev,
                  [field.provider]: e.target.value,
                }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveAll();
              }}
              placeholder={field.envVar}
              className="font-mono"
            />
            {invalid.has(field.provider) && (
              <div
                className="text-[0.625rem] text-red-500"
                data-id={`api-key-invalid-${field.provider}`}
              >
                {t("apiKeys.invalidKey")}
              </div>
            )}
          </>
        )}
      </div>
    );

  if (providersQuery.data == null) return null;

  // The filter matches what a user would actually type: the provider's name,
  // its id, the env var they saw in a README, or a model family from the hint.
  const query = filter.trim().toLowerCase();
  const matches = (field: ProviderKeyField): boolean =>
    query.length === 0 ||
    [field.label, field.provider, field.envVar, field.hint].some((text) =>
      text.toLowerCase().includes(query)
    );

  const featured = PROVIDER_KEY_FIELDS.filter(
    (field) => field.featured === true && matches(field)
  );
  const rest = PROVIDER_KEY_FIELDS.filter(
    (field) => field.featured !== true && matches(field)
  );
  const selectedProvider = PROVIDER_KEY_FIELDS.find(
    (field) => field.provider === provider
  );

  return (
    <FocusedPage data-id="models-settings-page">
      <FocusedPageToolbar>
        <InputGroup className="min-w-48 flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            data-id="api-keys-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("apiKeys.filterPlaceholder")}
          />
        </InputGroup>
      </FocusedPageToolbar>
      <FocusedPageBody>
        {featured.length > 0 && (
          <ItemGroup className="grid grid-cols-1 gap-2 @2xl:grid-cols-2">
            {featured.map((field) => providerCard(field))}
          </ItemGroup>
        )}

        {rest.length > 0 && (
          <>
            <div className="text-muted-foreground mt-4 mb-2 text-[0.625rem] font-medium tracking-wide uppercase">
              {t("apiKeys.moreProviders")}
            </div>
            <ItemGroup className="grid grid-cols-1 gap-2 @2xl:grid-cols-2">
              {rest.map((field) => providerCard(field))}
            </ItemGroup>
          </>
        )}

        {featured.length === 0 && rest.length === 0 && (
          <div className="text-muted-foreground py-6 text-center text-xs">
            {t("apiKeys.noMatches")}
          </div>
        )}

        {filter.trim().length === 0 && <LocalModelsSection />}

        <Dialog
          open={provider != null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              cancel();
              onProviderChange?.(null);
            }
          }}
        >
          {provider != null && (
            <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
              <DialogHeader>
                <DialogTitle>{selectedProvider?.label}</DialogTitle>
                <DialogDescription>{selectedProvider?.hint}</DialogDescription>
              </DialogHeader>
              {selectedProvider != null
                ? providerCard(selectedProvider, true)
                : null}
              {connectError != null && (
                <div className="text-destructive text-xs">{connectError}</div>
              )}
              <DialogFooter>
                <Button
                  variant="secondary"
                  onClick={() => {
                    cancel();
                    onProviderChange?.(null);
                  }}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  onClick={() =>
                    void saveAll().then((saved) => {
                      if (saved) onProviderChange?.(null);
                    })
                  }
                  disabled={!dirty}
                >
                  {t("apiKeys.saveChanges")}
                </Button>
              </DialogFooter>
            </DialogContent>
          )}
        </Dialog>

        {/* Removing a key is a decision worth confirming, and the confirmation is
          also where the one caveat belongs: a session already running holds the
          key it was started with, so revoking here does not reach back into it. */}
        <ConfirmDialog
          isOpen={removing != null}
          onClose={() => setRemoving(null)}
          title={t("apiKeys.removeTitle", { provider: removing?.label ?? "" })}
          description={t("apiKeys.removeDescription")}
          data-id="api-key-remove-dialog"
          buttons={[
            {
              label: t("common.cancel"),
              variant: "secondary",
              onClick: () => setRemoving(null),
            },
            {
              label: t("apiKeys.remove"),
              variant: "destructive",
              onClick: async () => {
                const field = removing;
                setRemoving(null);
                if (field != null) await removeKey(field);
                return true;
              },
            },
          ]}
        />
      </FocusedPageBody>
    </FocusedPage>
  );
};
