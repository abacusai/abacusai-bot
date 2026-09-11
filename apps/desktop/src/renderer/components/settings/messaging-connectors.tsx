import { useForm } from "@tanstack/react-form";
import { ExternalLink, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import {
  SHARED_BOT_PLATFORM_OF,
  type MessagingFieldInfo,
  type MessagingPairedUser,
  type MessagingPlatformId,
  type MessagingPlatformInfo,
  type MessagingPlatformState,
  type MessagingSnapshot,
} from "#shared/messaging";

import {
  Button,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Switch,
} from "../ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { NativeSelect } from "../ui/native-select";

/**
 * The messaging platforms' connect-and-manage UI, shared by the Connectors
 * panel and the onboarding connectors step. Pairing sits at the top of the
 * dialog: approving a sender grants them an agent with tool access here.
 * Not react-query: the onboarding step renders outside any QueryClientProvider.
 */

type StatusTone = "good" | "muted" | "warn" | "bad";

const TONE_CLASS: Record<StatusTone, string> = {
  good: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  muted: "bg-muted text-muted-foreground",
  warn: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  bad: "bg-red-500/15 text-red-600 dark:text-red-300",
};

const DOT_CLASS: Record<StatusTone, string> = {
  good: "bg-emerald-500",
  muted: "bg-text-muted/40",
  warn: "bg-amber-500",
  bad: "bg-red-500",
};

const stateTone = (
  state: MessagingPlatformState | "needs_link"
): StatusTone => {
  if (state === "connected") return "good";
  if (state === "error") return "bad";
  if (state === "disabled") return "muted";
  return "warn";
};

/**
 * A platform's live state as a pill. "needs_link" is not a gateway state: it
 * is Discord signed in but its Abacus AI bot not linked yet.
 */
export const MessagingStateBadge = ({
  state,
}: {
  state: MessagingPlatformState | "needs_link";
}): JSX.Element => {
  const { t } = useTranslation();
  const tone = stateTone(state);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${TONE_CLASS[tone]}`}
    >
      <span className={`size-1.5 rounded-full ${DOT_CLASS[tone]}`} />
      {t(`messaging.states.${state}`)}
    </span>
  );
};

export type MessagingApi = {
  snapshot: MessagingSnapshot | null;
  updatePlatform: (request: {
    platformId: MessagingPlatformId;
    enabled?: boolean;
    values?: Record<string, string>;
  }) => Promise<void>;
  decidePairing: (request: {
    platformId: MessagingPlatformId;
    userId: string;
    decision: "approve" | "revoke";
  }) => Promise<void>;
  updateSettings: (patch: {
    gatewayEnabled?: boolean;
    autoApproveTools?: boolean;
    respondToInbound?: boolean;
    workspaceId?: string | null;
    botId?: string | null;
  }) => Promise<void>;
  /** Bring a platform up in one click, switching the gateway on if needed. */
  connectPlatform: (platformId: MessagingPlatformId) => Promise<void>;
};

/**
 * The gateway's state and the calls that change it. Reads once on mount, then
 * follows `messaging-updated`; every mutation applies the snapshot the main
 * process answers with, so the UI never invents a state.
 */
export const useMessaging = (): MessagingApi => {
  const [snapshot, setSnapshot] = useState<MessagingSnapshot | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.api?.agent?.getMessagingSnapshot?.();
    if (next != null) setSnapshot(next);
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.api?.agent?.onEvent?.((event) => {
      if (event.type === "messaging-updated") void refresh();
    });
    return () => unsubscribe?.();
  }, [refresh]);

  const updatePlatform = useCallback<MessagingApi["updatePlatform"]>(
    async (request) => {
      const next = await window.api?.agent?.updateMessagingPlatform?.(request);
      if (next != null) setSnapshot(next);
    },
    []
  );

  const decidePairing = useCallback<MessagingApi["decidePairing"]>(
    async (request) => {
      const next = await window.api?.agent?.decideMessagingPairing?.(request);
      if (next != null) setSnapshot(next);
    },
    []
  );

  const updateSettings = useCallback<MessagingApi["updateSettings"]>(
    async (patch) => {
      const next = await window.api?.agent?.updateMessagingSettings?.(patch);
      if (next != null) setSnapshot(next);
    },
    []
  );

  const connectPlatform = useCallback<MessagingApi["connectPlatform"]>(
    async (platformId) => {
      // The gateway kill switch overrides every platform flag; a Connect that
      // left it off would leave the card stuck on "Disabled".
      const current = await window.api?.agent?.getMessagingSnapshot?.();
      if (current != null && !current.gatewayEnabled) {
        await window.api?.agent?.updateMessagingSettings?.({
          gatewayEnabled: true,
        });
      }
      const next = await window.api?.agent?.updateMessagingPlatform?.({
        platformId,
        enabled: true,
      });
      if (next != null) setSnapshot(next);
    },
    []
  );

  return {
    snapshot,
    updatePlatform,
    decidePairing,
    updateSettings,
    connectPlatform,
  };
};

/**
 * Connect-and-manage dialog for one platform: status, WhatsApp's QR, the
 * pairing queue, and credentials.
 */
export const MessagingConnectorDialog = ({
  platformId,
  messaging,
  onClose,
}: {
  platformId: MessagingPlatformId;
  messaging: MessagingApi;
  onClose: () => void;
}): JSX.Element | null => {
  const { t } = useTranslation();
  const snapshot = messaging.snapshot;
  const platform =
    snapshot?.platforms.find((entry) => entry.id === platformId) ?? null;
  const sharedBotId = SHARED_BOT_PLATFORM_OF[platformId];
  const sharedBot =
    snapshot?.platforms.find((entry) => entry.id === sharedBotId) ?? null;

  if (snapshot == null || platform == null) return null;

  // Closing the dialog any way at all while a web login is pending means
  // Cancel: an enabled platform with no login re-pops its window on every sync.
  const linkPending = sharedLinkPending(snapshot, platform.id);

  const close = (): void => {
    // A signed-in Discord with no bot linked is a setup abandoned halfway and
    // backs out like any other unfinished connect.
    const unfinished =
      linkPending ||
      (platform.state !== "connected" &&
        platform.state !== "linking" &&
        platform.state !== "syncing");
    if (CANCELLABLE_CONNECT.has(platform.id) && unfinished) {
      void messaging.updatePlatform({
        platformId: platform.id,
        enabled: false,
      });
      if (sharedBot != null)
        void messaging.updatePlatform({
          platformId: sharedBot.id,
          enabled: false,
        });
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t(`messaging.platforms.${platform.nameKey}`)}
          </DialogTitle>
        </DialogHeader>
        <PlatformDetail
          platform={platform}
          sharedBot={sharedBot}
          messaging={messaging}
          pending={snapshot.pending.filter(
            (row) => row.platform === platform.id
          )}
          onSave={async (values) => {
            await messaging.updatePlatform({ platformId: platform.id, values });
            // connectPlatform also switches the gateway kill switch on.
            await messaging.connectPlatform(platform.id);
          }}
          onClear={(key) =>
            void messaging.updatePlatform({
              platformId: platform.id,
              values: { [key]: "" },
            })
          }
          onDecide={(userId, decision) =>
            void messaging.decidePairing({
              platformId: platform.id,
              userId,
              decision,
            })
          }
          onCancelConnect={() => {
            // Disabling stops the bridge or closes the login window, same as
            // Remove. The shared lane is part of this setup and goes with it.
            void messaging.updatePlatform({
              platformId: platform.id,
              enabled: false,
            });
            if (sharedBot != null)
              void messaging.updatePlatform({
                platformId: sharedBot.id,
                enabled: false,
              });
            onClose();
          }}
          onDone={onClose}
        />
      </DialogContent>
    </Dialog>
  );
};

// Platforms whose connect is a wait (a QR, a login window) rather than a form,
// so there is something to cancel halfway.
const CANCELLABLE_CONNECT = new Set<MessagingPlatformId>([
  "whatsapp",
  "telegram",
  "discord",
  "abacus_discord",
  "abacus_telegram",
]);

/**
 * Platforms whose setup is unfinished until the shared Abacus AI bot lane is
 * linked too: signing in lets the agent act as you, linking lets you reach it
 * from a phone. Telegram's automatic assistant-bot handshake (botSetupPending)
 * is a separate lane from this shared bot.
 */
const SHARED_LINK_REQUIRED = new Set<MessagingPlatformId>([
  "discord",
  "telegram",
]);

// Whether `platformId` still owes its shared-bot link, which keeps the pill
// off "Connected" and the dialog on Cancel.
export const sharedLinkPending = (
  snapshot: MessagingSnapshot | null,
  platformId: MessagingPlatformId
): boolean => {
  if (!SHARED_LINK_REQUIRED.has(platformId)) return false;
  const sharedId = SHARED_BOT_PLATFORM_OF[platformId];
  if (sharedId == null) return false;
  const shared = snapshot?.platforms.find((entry) => entry.id === sharedId);
  // No lane offered: requiring a step nobody can complete would strand the
  // card on "finish linking" forever.
  if (shared == null) return false;
  const status = shared.sharedLink?.status;
  if (status === "unavailable") return false;
  return status !== "linked";
};

const PlatformDetail = ({
  platform,
  sharedBot,
  messaging,
  pending,
  onSave,
  onClear,
  onDecide,
  onCancelConnect,
  onDone,
}: {
  platform: MessagingPlatformInfo;
  /** The shared Abacus bot lane shown inside this card (Discord), if any. */
  sharedBot: MessagingPlatformInfo | null;
  messaging: MessagingApi;
  pending: MessagingPairedUser[];
  onSave: (values: Record<string, string>) => Promise<void>;
  onClear: (key: string) => void;
  onDecide: (userId: string, decision: "approve" | "revoke") => void;
  /** Back out of a connect that is still waiting. See CANCELLABLE_CONNECT. */
  onCancelConnect: () => void;
  /** Dismiss a connect that succeeded, leaving the platform connected. */
  onDone: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const form = useForm({
    defaultValues: Object.fromEntries(
      platform.fields.map((field) => [field.key, ""])
    ) as Record<string, string>,
    onSubmit: async ({ value }) => {
      const values = Object.fromEntries(
        Object.entries(value).filter(([, fieldValue]) => fieldValue.length > 0)
      );
      await onSave(values);
      form.reset();
    },
  });

  // `linkRequired` turns the lane from an extra into a step; headings, the
  // pill and the closing button read from it. See SHARED_LINK_REQUIRED.
  const linkRequired =
    SHARED_LINK_REQUIRED.has(platform.id) &&
    sharedBot != null &&
    sharedBot.sharedLink?.status !== "unavailable";
  const linkDone = sharedBot?.sharedLink?.status === "linked";
  const setupIncomplete = linkRequired && !linkDone;
  const appName = t(`messaging.platforms.${platform.nameKey}`);

  const requiredFields = platform.fields.filter((field) => field.required);
  const optionalFields = platform.fields.filter(
    (field) => !field.required && field.advanced !== true
  );
  const advancedFields = platform.fields.filter(
    (field) => !field.required && field.advanced === true
  );

  return (
    <div className="space-y-6" data-id={`messaging-detail-${platform.id}`}>
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <MessagingStateBadge
              state={
                setupIncomplete && platform.state === "connected"
                  ? "needs_link"
                  : platform.state
              }
            />
            {!platform.configured && (
              <span
                className={`rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${TONE_CLASS.muted}`}
              >
                {t("messaging.needsSetup")}
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            {t(`messaging.descriptions.${platform.nameKey}`)}
          </p>
          {linkRequired && (
            <p
              className="text-secondary-foreground mt-2 text-xs"
              data-id={`messaging-two-steps-${platform.id}`}
            >
              {t("messaging.twoStepSetup", { app: appName })}
            </p>
          )}
        </div>
        {/* No enable switch here. Clicking Connect on the card IS the intent
            — the dialog's job is the QR or the token, and disconnecting is
            the card's Remove button. A toggle in between only added a state
            to explain. */}
      </header>

      {platform.errorMessage != null && (
        <p
          data-id={`messaging-error-${platform.id}`}
          className={
            // Waiting on a login is an instruction, not a failure — don't
            // paint "scan the QR" red.
            platform.state === "needs_login" ||
            platform.state === "rate_limited"
              ? "rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
              : "rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300"
          }
        >
          {platform.errorMessage}
        </p>
      )}

      {(platform.id === "telegram" ||
        platform.id === "discord" ||
        platform.id === "whatsapp") &&
        platform.enabled && (
          <WebLogin
            platformId={platform.id}
            step={
              linkRequired ? t("messaging.stepSignIn", { app: appName }) : null
            }
            connected={
              platform.state === "connected" ||
              platform.state === "linking" ||
              platform.state === "syncing"
            }
          />
        )}

      {/* The shared Abacus AI bot: the same one ChatLLM's personal agents pair
          with. A section of this card, not a card of its own — it is another
          way to reach the agent from Discord, not another Discord. */}
      {sharedBot != null && (
        <SharedLinkSection
          platform={sharedBot}
          messaging={messaging}
          required={linkRequired}
        />
      )}

      {/* The stretch between "Telegram is connected" and "the assistant's
          bot can reach you": say it is still being set up — and nothing
          more. No manual finish-linking step: the automatic handshake is
          the only path a user sees, because a manual button shown next to
          an automation that is about to succeed reads as required, and on
          desktops without the Telegram app its t.me link swallowed the
          click. Setup that truly stalls is retried by reconnecting. */}
      {platform.id === "telegram" &&
        platform.enabled &&
        platform.botSetupPending === true && (
          <section
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-center"
            data-id="messaging-telegram-bot-setup"
          >
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t("messaging.telegramBotSetupPending")}
            </p>
          </section>
        )}

      {/* Linked, still syncing: WhatsApp Web hands over the account and its
          chats over the first minutes. Said plainly, with what to do, so a
          "send me hi" that cannot work yet reads as WhatsApp still syncing
          and not as this app being broken. */}
      {platform.id === "whatsapp" && platform.state === "syncing" && (
        <section
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-center"
          data-id="messaging-whatsapp-syncing"
        >
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {t("messaging.whatsappSyncing")}
          </p>
        </section>
      )}

      {/* One row, two answers, and the dialog always has one of them.
          Deliberately outside the login sections rather than inside them: a
          connect still waiting on a scan is exactly when somebody decides they
          would rather not, and a connect that has just landed is when they
          want to get on with it.

          Before this the connected state had no button at all — the QR
          disappeared, the green line appeared, and the only way out was the
          close cross or a click outside, neither of which looks like the end
          of a flow you were walked through. */}
      {CANCELLABLE_CONNECT.has(platform.id) && platform.enabled && (
        <div className="flex items-center justify-end gap-3">
          {/* Signed in but not linked yet: say which step is outstanding,
              rather than offering a Done that would close a setup that does
              not work yet. */}
          {setupIncomplete && platform.state === "connected" && (
            <p
              className="text-muted-foreground text-xs"
              data-id={`messaging-finish-link-${platform.id}`}
            >
              {t("messaging.finishLinkFirst")}
            </p>
          )}
          {!setupIncomplete &&
          (platform.state === "connected" ||
            platform.state === "linking" ||
            platform.state === "syncing") ? (
            <Button
              size="sm"
              data-id={`messaging-done-connect-${platform.id}`}
              onClick={onDone}
            >
              {t("messaging.doneConnect")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              data-id={`messaging-cancel-connect-${platform.id}`}
              onClick={onCancelConnect}
            >
              {t("messaging.cancelConnect")}
            </Button>
          )}
        </div>
      )}

      {pending.length > 0 && (
        <section data-id="messaging-pending-section">
          <h3 className="text-secondary-foreground text-xs font-semibold tracking-wide uppercase">
            {t("messaging.pendingRequests", { count: pending.length })}
          </h3>
          <div className="mt-2 overflow-hidden rounded-lg border border-amber-500/30">
            {pending.map((user, index) => (
              <div
                key={user.userId}
                className={`flex items-start gap-3 bg-amber-500/5 px-3 py-2 ${index > 0 ? "border-t border-amber-500/20" : ""}`}
                data-id={`messaging-pending-${user.userId}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate text-xs font-medium">
                    {user.userName ?? user.userId}
                  </p>
                  {user.firstMessage != null && (
                    <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                      {user.firstMessage}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="xs"
                    data-id={`messaging-approve-${user.userId}`}
                    onClick={() => onDecide(user.userId, "approve")}
                  >
                    {t("messaging.approve")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    data-id={`messaging-reject-${user.userId}`}
                    onClick={() => onDecide(user.userId, "revoke")}
                  >
                    {t("messaging.reject")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* No "Approved" list here by design (it once sat between the pending
          queue and the credentials): most rows were businesses the auto-
          approve path had recorded — ICICI, CRED, Zomato — and a wall of
          bank names read as noise, not as a security surface. Revoking is
          decidePairing("revoke"); resurface it in a settings view if a real
          management need appears. */}

      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <section>
          <h3 className="text-secondary-foreground text-xs font-semibold tracking-wide uppercase">
            {t("messaging.getCredentials")}
          </h3>
          <p className="text-muted-foreground mt-1 text-xs">
            {t(`messaging.setup.${platform.nameKey}`)}
          </p>
          <Button
            type="button"
            variant="link"
            size="sm"
            data-id={`messaging-docs-${platform.id}`}
            onClick={() => window.api.openExternal(platform.docsUrl)}
            className="mt-2"
          >
            {t("messaging.openSetupGuide")}
            <ExternalLink size={11} />
          </Button>
        </section>

        <form.Subscribe selector={(state) => state.values}>
          {(values) => (
            <>
              {requiredFields.length > 0 && (
                <FieldSection
                  title={t("messaging.required")}
                  fields={requiredFields}
                  draft={values}
                  onEdit={(key, value) => form.setFieldValue(key, value)}
                  onClear={onClear}
                />
              )}

              {optionalFields.length > 0 && (
                <FieldSection
                  title={t("messaging.recommended")}
                  fields={optionalFields}
                  draft={values}
                  onEdit={(key, value) => form.setFieldValue(key, value)}
                  onClear={onClear}
                />
              )}

              {advancedFields.length > 0 && (
                <section>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    data-id="messaging-advanced-toggle"
                    onClick={() => setShowAdvanced((value) => !value)}
                  >
                    {t("messaging.advanced", { count: advancedFields.length })}
                  </Button>
                  {showAdvanced && (
                    <div className="mt-2">
                      <FieldSection
                        title={null}
                        fields={advancedFields}
                        draft={values}
                        onEdit={(key, value) => form.setFieldValue(key, value)}
                        onClear={onClear}
                      />
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </form.Subscribe>

        {platform.fields.length > 0 && (
          <form.Subscribe
            selector={(state) => [state.isDirty, state.isSubmitting] as const}
          >
            {([dirty, isSubmitting]) => (
              <div className="border-border flex items-center justify-end gap-3 border-t pt-4">
                {dirty && (
                  <span className="text-muted-foreground text-xs">
                    {t("messaging.unsavedChanges")}
                  </span>
                )}
                <Button
                  type="submit"
                  size="sm"
                  data-id="messaging-save"
                  disabled={!dirty || isSubmitting}
                >
                  {isSubmitting
                    ? t("messaging.saving")
                    : t("messaging.saveChanges")}
                </Button>
              </div>
            )}
          </form.Subscribe>
        )}
      </form>
    </div>
  );
};

/**
 * A web-app login: the platform's own page in a real window, so there is no QR
 * to render here, just a status line and a button to reopen that window.
 */
const WebLogin = ({
  platformId,
  connected,
  step,
}: {
  platformId: "telegram" | "discord" | "whatsapp";
  connected: boolean;
  /** Heading when this login is one step of a longer setup; null when it is
      the whole of it. */
  step?: string | null;
}): JSX.Element => {
  const { t } = useTranslation();

  // Opening this dialog is the one moment the login window shows itself
  // unasked; connectors never self-reveal, or a restart would re-pop them.
  useEffect(() => {
    if (!connected) void window.api?.agent?.showMessagingLogin?.(platformId);
    // Once, on mount: a login poll flipping `connected` must not re-show it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section
      className="border-border rounded-lg border p-4 text-center"
      data-id={`messaging-${platformId}-login`}
    >
      {step != null && (
        <h3 className="text-secondary-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          {step}
        </h3>
      )}
      <p className="text-secondary-foreground text-xs">
        {connected
          ? t(`messaging.${platformId}Connected`)
          : t(`messaging.${platformId}Scan`)}
      </p>
      {!connected && (
        <Button
          size="sm"
          className="mt-3"
          data-id={`messaging-${platformId}-login-button`}
          onClick={() =>
            void window.api?.agent?.showMessagingLogin?.(platformId)
          }
        >
          {t(`messaging.${platformId}OpenLogin`)}
        </Button>
      )}
    </section>
  );
};

/**
 * Pairing with a shared Abacus-owned bot: the server mints a one-time code, the
 * user sends the bot `/link <code>`, and the card flips once it lands.
 */
const SharedLinkSection = ({
  platform,
  messaging,
  required = false,
}: {
  platform: MessagingPlatformInfo;
  messaging: MessagingApi;
  /** This lane is a step of the card's setup, not an extra route out of it.
      See SHARED_LINK_REQUIRED. */
  required?: boolean;
}): JSX.Element => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = platform.sharedLink ?? { status: "unlinked" as const };
  const command = link.code != null ? `/link ${link.code}` : null;

  const pair = async (): Promise<void> => {
    setBusy(true);
    try {
      // The lane runs only while linking or linked: Link switches it on.
      if (!platform.enabled) await messaging.connectPlatform(platform.id);
      await window.api?.agent?.pairSharedChannel?.(platform.id);
    } finally {
      setBusy(false);
    }
  };
  const unlink = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.api?.agent?.unlinkSharedChannel?.(platform.id);
      await messaging.updatePlatform({
        platformId: platform.id,
        enabled: false,
      });
    } finally {
      setBusy(false);
    }
  };
  // A required step does not wait behind a button: mint the code on appear.
  const started = useRef(false);
  useEffect(() => {
    if (!required || link.status !== "unlinked" || started.current) return;
    started.current = true;
    void pair();
    // Deliberately keyed on the status alone: pair() is redefined every render
    // and re-running this on that would re-mint codes in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [required, link.status]);

  const copy = async (): Promise<void> => {
    if (command == null) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section
      className="border-border space-y-3 rounded-lg border p-4"
      data-id="messaging-shared-link"
    >
      <h3 className="text-secondary-foreground text-xs font-semibold tracking-wide uppercase">
        {required
          ? t("messaging.sharedLink.stepLink")
          : t("messaging.sharedLink.title")}
      </h3>
      {link.status === "linked" && (
        <>
          <p className="text-secondary-foreground text-xs">
            {link.displayName != null && link.displayName.length > 0
              ? t("messaging.sharedLink.linkedAs", {
                  name: link.displayName,
                  app: t(`messaging.platforms.${platform.nameKey}`),
                })
              : t("messaging.sharedLink.linked", {
                  app: t(`messaging.platforms.${platform.nameKey}`),
                })}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            data-id="messaging-shared-unlink"
            onClick={() => void unlink()}
          >
            {t("messaging.sharedLink.unlink")}
          </Button>
        </>
      )}
      {link.status === "pending" && platform.id === "abacus_telegram" && (
        <>
          <p className="text-secondary-foreground text-xs">
            {t("messaging.sharedLink.telegramStep")}
          </p>
          {link.qrDataUrl != null && (
            <img
              src={link.qrDataUrl}
              alt=""
              width={180}
              height={180}
              className="rounded-md bg-white p-1"
              data-id="messaging-shared-qr"
            />
          )}
          {/* No "open link" button: the deep link opens Telegram on this
              machine, and the pairing has to be tapped on the phone that
              carries the account. The QR above is the only way across. */}
          <p className="text-muted-foreground text-xs">
            {t("messaging.sharedLink.waitingTelegram")}
          </p>
        </>
      )}
      {link.status === "pending" && platform.id !== "abacus_telegram" && (
        <>
          <p className="text-secondary-foreground text-xs">
            {t("messaging.sharedLink.step1")}
          </p>
          {link.deepLink != null && (
            <Button
              size="sm"
              data-id="messaging-shared-install"
              onClick={() =>
                void window.api?.agent?.openSharedChannelLink?.(platform.id)
              }
            >
              <ExternalLink className="mr-1 size-3.5" />
              {t("messaging.sharedLink.addToDiscord")}
            </Button>
          )}
          <p className="text-secondary-foreground text-xs">
            {t("messaging.sharedLink.step2Copy")}
          </p>
          {command != null && (
            <div className="flex items-center gap-2">
              <code
                className="bg-muted rounded px-2 py-1 text-xs"
                data-id="messaging-shared-code"
              >
                {command}
              </code>
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                {copied
                  ? t("messaging.sharedLink.copied")
                  : t("messaging.sharedLink.copy")}
              </Button>
            </div>
          )}
          <p className="text-secondary-foreground text-xs">
            {t("messaging.sharedLink.step3Dm")}
          </p>
          {link.botProfileUrl != null && (
            <Button
              variant="outline"
              size="sm"
              data-id="messaging-shared-open-dm"
              onClick={() => {
                // The paste is the whole of step 3: put the command on the
                // clipboard again on the way out, in case step 2 was skipped.
                if (command != null)
                  void navigator.clipboard.writeText(command);
                void window.api?.agent?.openSharedChannelLink?.(
                  platform.id,
                  "dm"
                );
              }}
            >
              <ExternalLink className="mr-1 size-3.5" />
              {t("messaging.sharedLink.openDm")}
            </Button>
          )}
          <p className="text-muted-foreground text-xs">
            {t("messaging.sharedLink.waiting")}
          </p>
        </>
      )}
      {(link.status === "unlinked" || link.status === "unavailable") && (
        <>
          <p className="text-secondary-foreground text-xs">
            {link.error ??
              (required
                ? t("messaging.sharedLink.requiredIntro")
                : t("messaging.sharedLink.intro"))}
          </p>
          {/* No "Link Abacus AI bot" button when this is a step: the pairing
              starts itself above, and a button offering to begin something
              already under way is what made the step look optional. It comes
              back only as a retry, once an auto-start has been and failed. */}
          {required && link.status === "unlinked" ? (
            busy || !started.current ? (
              <p className="text-muted-foreground text-xs">
                {t("messaging.sharedLink.preparing")}
              </p>
            ) : (
              <Button
                variant="outline"
                size="sm"
                data-id="messaging-shared-retry"
                onClick={() => void pair()}
              >
                {t("messaging.sharedLink.retry")}
              </Button>
            )
          ) : (
            <Button
              size="sm"
              disabled={busy || link.status === "unavailable"}
              data-id="messaging-shared-pair"
              onClick={() => void pair()}
            >
              {t("messaging.sharedLink.link")}
            </Button>
          )}
        </>
      )}
    </section>
  );
};

const FieldSection = ({
  title,
  fields,
  draft,
  onEdit,
  onClear,
}: {
  title: string | null;
  fields: MessagingFieldInfo[];
  draft: Record<string, string>;
  onEdit: (key: string, value: string) => void;
  onClear: (key: string) => void;
}): JSX.Element => {
  const { t } = useTranslation();

  return (
    <section>
      {title != null && (
        <h3 className="text-secondary-foreground text-xs font-semibold tracking-wide uppercase">
          {title}
        </h3>
      )}
      <FieldGroup className="mt-2 gap-3">
        {fields.map((field) => (
          <Field
            key={field.key}
            orientation="responsive"
            data-id={`messaging-field-${field.key}`}
          >
            <FieldContent>
              <FieldLabel htmlFor={`messaging-input-${field.key}`}>
                {t(`messaging.fields.${field.labelKey}`)}
              </FieldLabel>
              {field.isSet && (
                <FieldDescription>
                  {/* An env-supplied value can't be edited from here, and saying
                      so is the difference between "ignored my input" and
                      "already configured elsewhere". */}
                  {field.fromEnv
                    ? t("messaging.fromEnvironment", { key: field.key })
                    : t("messaging.saved")}
                </FieldDescription>
              )}
            </FieldContent>

            <Input
              id={`messaging-input-${field.key}`}
              type={field.secret ? "password" : "text"}
              value={draft[field.key] ?? ""}
              disabled={field.fromEnv}
              onChange={(event) => onEdit(field.key, event.target.value)}
              placeholder={
                field.isSet
                  ? (field.redactedValue ?? undefined)
                  : field.placeholder
              }
              className="min-w-0 flex-1 font-mono @md/field-group:max-w-md"
            />

            {field.isSet && !field.fromEnv && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-id={`messaging-clear-${field.key}`}
                onClick={() => onClear(field.key)}
                aria-label={t("messaging.clearField")}
              >
                <Trash2 />
              </Button>
            )}
          </Field>
        ))}
      </FieldGroup>
    </section>
  );
};

/** The gateway-wide switches, behind a dialog rather than on the pane. */
export const MessagingSettingsDialog = ({
  messaging,
  workspaces,
  onClose,
}: {
  messaging: MessagingApi;
  workspaces: Array<{ id: string; label: string }>;
  onClose: () => void;
}): JSX.Element | null => {
  const { t } = useTranslation();
  const snapshot = messaging.snapshot;

  // Plain state, not react-query, for the same reason as the snapshot hook:
  // this dialog must render wherever the connectors UI does.
  const [bots, setBots] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    void window.api?.agent
      ?.listBots?.()
      .then((list) => {
        if (!cancelled && Array.isArray(list))
          setBots(list.map((bot) => ({ id: bot.id, name: bot.name })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (snapshot == null) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("sidebarNav.messaging")}</DialogTitle>
        </DialogHeader>
        <FieldGroup
          className="border-border gap-0 rounded-lg border"
          data-id="messaging-gateway-settings"
        >
          <Field orientation="horizontal" className="px-3 py-2.5">
            <FieldContent>
              <FieldLabel htmlFor="messaging-toggle-gateway">
                {t("messaging.settings.gatewayEnabled")}
              </FieldLabel>
              <FieldDescription>
                {t("messaging.settings.gatewayEnabledHelp")}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="messaging-toggle-gateway"
              checked={snapshot.gatewayEnabled}
              onCheckedChange={(value) =>
                void messaging.updateSettings({ gatewayEnabled: value })
              }
              data-id="messaging-toggle-gateway"
            />
          </Field>
          <Field
            orientation="responsive"
            className="border-input border-t px-3 py-2.5"
          >
            <FieldContent>
              <FieldLabel htmlFor="messaging-workspace-select">
                {t("messaging.settings.workspace")}
              </FieldLabel>
              <FieldDescription>
                {t("messaging.settings.workspaceHelp")}
              </FieldDescription>
            </FieldContent>
            <NativeSelect
              id="messaging-workspace-select"
              data-id="messaging-workspace-select"
              value={snapshot.workspaceId ?? ""}
              onChange={(event) =>
                void messaging.updateSettings({
                  workspaceId:
                    event.target.value.length > 0 ? event.target.value : null,
                })
              }
              className="w-full @md/field-group:w-56"
            >
              <option value="">
                {t("messaging.settings.workspaceActive")}
              </option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            orientation="responsive"
            className="border-input border-t px-3 py-2.5"
          >
            <FieldContent>
              <FieldLabel htmlFor="messaging-bot-select">
                {t("messaging.settings.deliverToBot")}
              </FieldLabel>
              <FieldDescription>
                {t("messaging.settings.deliverToBotHelp")}
              </FieldDescription>
            </FieldContent>
            <NativeSelect
              id="messaging-bot-select"
              data-id="messaging-bot-select"
              value={snapshot.botId ?? ""}
              onChange={(event) =>
                void messaging.updateSettings({
                  botId:
                    event.target.value.length > 0 ? event.target.value : null,
                })
              }
              className="w-full @md/field-group:w-56"
            >
              <option value="">
                {t("messaging.settings.deliverToBotNone")}
              </option>
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            orientation="horizontal"
            className="border-input border-t px-3 py-2.5"
          >
            <FieldContent>
              <FieldLabel htmlFor="messaging-toggle-respond-inbound">
                {t("messaging.settings.respondToInbound")}
              </FieldLabel>
              <FieldDescription>
                {t("messaging.settings.respondToInboundHelp")}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="messaging-toggle-respond-inbound"
              checked={snapshot.respondToInbound}
              onCheckedChange={(value) =>
                void messaging.updateSettings({ respondToInbound: value })
              }
              data-id="messaging-toggle-respond-inbound"
            />
          </Field>
          <Field
            orientation="horizontal"
            className="border-input border-t px-3 py-2.5"
          >
            <FieldContent>
              <FieldLabel htmlFor="messaging-toggle-auto-approve">
                {t("messaging.settings.autoApprove")}
              </FieldLabel>
              <FieldDescription>
                {t("messaging.settings.autoApproveHelp")}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="messaging-toggle-auto-approve"
              checked={snapshot.autoApproveTools}
              onCheckedChange={(value) =>
                void messaging.updateSettings({ autoApproveTools: value })
              }
              data-id="messaging-toggle-auto-approve"
            />
          </Field>
        </FieldGroup>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Installed on the Connectors page means enabled and configured, not
 * connected: a card that flipped on every reconnect would read as broken, but
 * the enabled flag outlives its credentials and alone is not enough.
 */
export const isMessagingPlatformInstalled = (
  snapshot: MessagingSnapshot | null,
  platformId: MessagingPlatformId
): boolean => {
  const platform = snapshot?.platforms.find((entry) => entry.id === platformId);
  if (platform?.enabled === true && platform.configured) return true;
  // The Discord card is also installed when only its shared-bot lane is.
  const shared = SHARED_BOT_PLATFORM_OF[platformId];
  return shared != null && isMessagingPlatformInstalled(snapshot, shared);
};

// Actually connected, the bar for anything that says "Connected". Distinct
// from installed: `enabled` is a stored flag that can outlive its credentials.
export const isMessagingPlatformConnected = (
  snapshot: MessagingSnapshot | null,
  platformId: MessagingPlatformId
): boolean => {
  // Half of Discord's setup is not Discord connected. See SHARED_LINK_REQUIRED.
  if (sharedLinkPending(snapshot, platformId)) return false;
  const state = snapshot?.platforms.find(
    (entry) => entry.id === platformId
  )?.state;
  // "linking" is a connected session whose assistant bot is still being set
  // up — installed and usable, so the connect flow counts it as connected.
  if (state === "connected" || state === "linking" || state === "syncing")
    return true;
  const shared = SHARED_BOT_PLATFORM_OF[platformId];
  return shared != null && isMessagingPlatformConnected(snapshot, shared);
};
