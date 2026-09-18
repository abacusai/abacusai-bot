import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Copy, LoaderCircle, Mail, MessageCircle, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { ReferralInviteOutcome } from "#shared/contracts";

import { connectorById } from "../../connectors";
import { useReferralSummaryQuery } from "../../hooks/use-referrals";
import { workspaceQueryKeys } from "../../lib/query-keys";
import { useConnectFlow } from "../connectors/connect-flow";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageLead,
} from "../layout/focused-page";
import { Button, Input, Item, ItemContent, ItemTitle, Textarea } from "../ui";
import { useMessaging } from "./messaging-connectors";

/**
 * Invite friends for credits. The user picks who, from the contacts Gmail or
 * WhatsApp already knows, reads the note once, and one button sends it all
 * from their own account. Nothing goes out without that click.
 */

const GMAIL_CONNECTOR_ID = "abacus-gmailuser";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type PickerRow = { id: string; label: string; detail: string | null };

const ProgressBar = ({
  value,
  max,
}: {
  value: number;
  max: number;
}): JSX.Element => (
  <div
    className="bg-muted h-2 w-full overflow-hidden rounded-full"
    role="progressbar"
    aria-valuenow={Math.min(value, max)}
    aria-valuemin={0}
    aria-valuemax={max}
    data-id="referrals-progress"
  >
    <div
      className="from-primary h-full rounded-full bg-gradient-to-r to-violet-700 transition-[width]"
      style={{ width: `${Math.min(100, (value / Math.max(max, 1)) * 100)}%` }}
    />
  </div>
);

/** A checklist of people with select-all, a note, and the one send button. */
const ContactPicker = ({
  dataId,
  rows,
  loading,
  emptyText,
  message,
  onMessageChange,
  onSend,
  sending,
  extra,
}: {
  dataId: string;
  rows: PickerRow[];
  loading: boolean;
  emptyText: string;
  message: string;
  onMessageChange: (value: string) => void;
  onSend: (ids: string[]) => Promise<void>;
  sending: boolean;
  extra?: JSX.Element;
}): JSX.Element => {
  const { t } = useTranslation();
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const selected = useMemo(
    () => rows.filter((row) => !unchecked.has(row.id)).map((row) => row.id),
    [rows, unchecked]
  );

  return (
    <div className="flex flex-col gap-3" data-id={dataId}>
      {extra}
      {loading ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin" />
          {t("common.loading")}
        </p>
      ) : rows.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-id={`${dataId}-empty`}
        >
          {emptyText}
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground" data-id={`${dataId}-count`}>
              {t("referrals.selectedCount", {
                selected: selected.length,
                total: rows.length,
              })}
            </span>
            <span className="flex gap-2">
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setUnchecked(new Set())}
              >
                {t("referrals.selectAll")}
              </Button>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setUnchecked(new Set(rows.map((row) => row.id)))}
              >
                {t("referrals.selectNone")}
              </Button>
            </span>
          </div>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
            {rows.map((row) => {
              const checked = !unchecked.has(row.id);
              return (
                <li key={row.id}>
                  <label className="hover:bg-accent/40 flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-primary size-4"
                      checked={checked}
                      onChange={() =>
                        setUnchecked((current) => {
                          const next = new Set(current);
                          if (checked) next.add(row.id);
                          else next.delete(row.id);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    {row.detail != null && (
                      <span className="text-muted-foreground truncate text-xs">
                        {row.detail}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <Textarea
        value={message}
        onChange={(event) => onMessageChange(event.target.value)}
        rows={3}
        maxLength={1000}
        aria-label={t("referrals.messageLabel")}
        data-id={`${dataId}-message`}
      />
      <Button
        disabled={sending || selected.length === 0}
        onClick={() => void onSend(selected)}
        data-id={`${dataId}-send`}
        className="self-start"
      >
        {sending && <LoaderCircle className="animate-spin" />}
        {sending
          ? t("referrals.sending")
          : t("referrals.sendInvites", { count: selected.length })}
      </Button>
    </div>
  );
};

export const ReferralsPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: summary, isLoading: summaryLoading } =
    useReferralSummaryQuery();
  const flow = useConnectFlow();
  const messaging = useMessaging();

  const [message, setMessage] = useState<string>(() =>
    t("referrals.defaultMessage")
  );
  const [gmailRows, setGmailRows] = useState<PickerRow[] | null>(null);
  const [manualEmail, setManualEmail] = useState("");
  const [whatsappRows, setWhatsappRows] = useState<PickerRow[] | null>(null);
  const [sending, setSending] = useState<"gmail" | "whatsapp" | null>(null);
  const [connectingGmail, setConnectingGmail] = useState(false);

  const gmailConnected = summary?.gmailConnected === true;
  const whatsappState =
    messaging.snapshot?.platforms.find((entry) => entry.id === "whatsapp")
      ?.state ?? null;
  const whatsappConnected = whatsappState === "connected";

  useEffect(() => {
    if (!gmailConnected) return;
    let cancelled = false;
    void window.api.agent.listReferralGmailContacts().then((contacts) => {
      if (cancelled) return;
      setGmailRows(
        contacts.map((contact) => ({
          id: contact.email,
          label: contact.name?.trim() || contact.email,
          detail: contact.name?.trim() ? contact.email : null,
        }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [gmailConnected]);

  useEffect(() => {
    if (!whatsappConnected) return;
    let cancelled = false;
    void window.api.agent.listReferralWhatsappContacts().then((contacts) => {
      if (cancelled) return;
      setWhatsappRows(
        contacts.map((contact) => ({
          id: contact.chatId,
          label: contact.name,
          detail: null,
        }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [whatsappConnected]);

  // Leaving the page abandons a Gmail connect in flight.
  useEffect(() => () => flow.cancel(), [flow]);

  const report = (outcome: ReferralInviteOutcome): void => {
    if (!outcome.ok) {
      toast.error(
        t(
          outcome.error === "gmail-not-connected"
            ? "referrals.errors.gmail"
            : outcome.error === "whatsapp-not-connected"
              ? "referrals.errors.whatsapp"
              : outcome.error === "not-signed-in"
                ? "referrals.errors.signedOut"
                : "referrals.errors.unavailable"
        )
      );
      return;
    }
    toast.success(t("referrals.sentToast", { count: outcome.sent }), {
      description:
        outcome.skipped > 0 || outcome.failed > 0
          ? t("referrals.sentToastDetail", {
              skipped: outcome.skipped,
              failed: outcome.failed,
            })
          : undefined,
    });
    if (outcome.milestoneCreditsGranted > 0) {
      toast.success(
        t("referrals.milestoneToast", {
          credits: outcome.milestoneCreditsGranted.toLocaleString(),
        })
      );
    }
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.referralSummary,
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.abacusAccount,
    });
  };

  const sendEmails = async (emails: string[]): Promise<void> => {
    setSending("gmail");
    try {
      report(await window.api.agent.sendReferralEmailInvites(emails, message));
      setGmailRows((rows) =>
        rows == null ? rows : rows.filter((row) => !emails.includes(row.id))
      );
    } finally {
      setSending(null);
    }
  };

  const sendWhatsapp = async (chatIds: string[]): Promise<void> => {
    setSending("whatsapp");
    try {
      report(
        await window.api.agent.sendReferralWhatsappInvites(chatIds, message)
      );
      setWhatsappRows((rows) =>
        rows == null ? rows : rows.filter((row) => !chatIds.includes(row.id))
      );
    } finally {
      setSending(null);
    }
  };

  const connectGmail = async (): Promise<void> => {
    const connector = connectorById(GMAIL_CONNECTOR_ID);
    if (connector == null) return;
    setConnectingGmail(true);
    try {
      const result = await flow.start(connector);
      if (result.ok === true) {
        await queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.referralSummary,
        });
      } else if (result.cancelled !== true) {
        toast.error(t("referrals.errors.gmail"));
      }
    } finally {
      setConnectingGmail(false);
    }
  };

  const addManualEmails = (): void => {
    const emails = manualEmail
      .split(/[\s,;]+/)
      .map((value) => value.trim().toLowerCase())
      .filter((value) => EMAIL_RE.test(value));
    if (emails.length === 0) return;
    setGmailRows((rows) => {
      const known = new Set((rows ?? []).map((row) => row.id));
      const added = emails
        .filter((email) => !known.has(email))
        .map((email) => ({ id: email, label: email, detail: null }));
      return [...added, ...(rows ?? [])];
    });
    setManualEmail("");
  };

  const copyLink = (): void => {
    if (summary == null) return;
    void navigator.clipboard.writeText(summary.inviteLink);
    toast.success(t("referrals.linkCopied"), { id: "referral-link-copy" });
  };

  return (
    <FocusedPage data-id="referrals-page">
      {flow.dialogs}
      <FocusedPageBody>
        <FocusedPageLead
          description={
            summary == null
              ? t("referrals.lead")
              : t("referrals.leadWithNumbers", {
                  credits: summary.milestoneCredits.toLocaleString(),
                  count: summary.milestoneInvites,
                  perFriend: summary.creditsPerFriend.toLocaleString(),
                })
          }
        />

        {summaryLoading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <LoaderCircle className="size-4 animate-spin" />
            {t("common.loading")}
          </p>
        ) : summary == null ? (
          <p
            className="text-muted-foreground text-sm"
            data-id="referrals-signed-out"
          >
            {t("referrals.notSignedIn")}
          </p>
        ) : (
          <>
            <Item variant="outline" data-id="referrals-progress-card">
              <ItemContent className="gap-2">
                <ItemTitle data-id="referrals-progress-title">
                  {summary.milestoneGranted
                    ? t("referrals.progressGranted", {
                        credits: summary.milestoneCredits.toLocaleString(),
                      })
                    : t("referrals.progressTitle", {
                        sent: summary.invitesSent,
                        total: summary.milestoneInvites,
                      })}
                </ItemTitle>
                <ProgressBar
                  value={summary.invitesSent}
                  max={summary.milestoneInvites}
                />
                <p className="text-muted-foreground text-xs">
                  {t("referrals.friendsJoined", {
                    count: summary.friendsJoined,
                    credits: (
                      summary.friendsJoined * summary.creditsPerFriend
                    ).toLocaleString(),
                  })}
                </p>
                <div className="flex min-w-0 items-center gap-1">
                  <code
                    className="text-muted-foreground bg-accent/40 min-w-0 truncate rounded px-1.5 py-0.5 text-[11px]"
                    data-id="referrals-link"
                  >
                    {summary.inviteLink}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("referrals.copyLink")}
                    title={t("referrals.copyLink")}
                    data-id="referrals-copy-link"
                    onClick={copyLink}
                  >
                    <Copy />
                  </Button>
                </div>
              </ItemContent>
            </Item>

            <section className="flex flex-col gap-3" data-id="referrals-gmail">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Mail className="size-4" />
                {t("referrals.gmailTitle")}
              </h3>
              <p className="text-muted-foreground text-sm">
                {t("referrals.gmailBody")}
              </p>
              {!gmailConnected && (
                <Button
                  variant="outline"
                  className="self-start"
                  disabled={connectingGmail}
                  onClick={() => void connectGmail()}
                  data-id="referrals-connect-gmail"
                >
                  {connectingGmail && <LoaderCircle className="animate-spin" />}
                  {t("referrals.connectGmail")}
                </Button>
              )}
              <ContactPicker
                dataId="referrals-gmail-picker"
                rows={gmailRows ?? []}
                loading={gmailConnected && gmailRows == null}
                emptyText={
                  gmailConnected
                    ? t("referrals.noGmailContacts")
                    : t("referrals.addEmailsHint")
                }
                message={message}
                onMessageChange={setMessage}
                onSend={sendEmails}
                sending={sending === "gmail"}
                extra={
                  <div className="flex gap-2">
                    <Input
                      value={manualEmail}
                      onChange={(event) => setManualEmail(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addManualEmails();
                        }
                      }}
                      placeholder={t("referrals.addEmailsPlaceholder")}
                      aria-label={t("referrals.addEmailsPlaceholder")}
                      data-id="referrals-manual-email"
                    />
                    <Button
                      variant="outline"
                      onClick={addManualEmails}
                      data-id="referrals-manual-email-add"
                    >
                      <Plus />
                      {t("referrals.addEmails")}
                    </Button>
                  </div>
                }
              />
            </section>

            <section
              className="flex flex-col gap-3"
              data-id="referrals-whatsapp"
            >
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <MessageCircle className="size-4" />
                {t("referrals.whatsappTitle")}
              </h3>
              <p className="text-muted-foreground text-sm">
                {t("referrals.whatsappBody")}
              </p>
              {whatsappConnected ? (
                <ContactPicker
                  dataId="referrals-whatsapp-picker"
                  rows={whatsappRows ?? []}
                  loading={whatsappRows == null}
                  emptyText={t("referrals.noWhatsappContacts")}
                  message={message}
                  onMessageChange={setMessage}
                  onSend={sendWhatsapp}
                  sending={sending === "whatsapp"}
                />
              ) : (
                <Button
                  variant="outline"
                  className="self-start"
                  onClick={() => void navigate({ to: "/settings/connectors" })}
                  data-id="referrals-link-whatsapp"
                >
                  {t("referrals.linkWhatsapp")}
                </Button>
              )}
            </section>
          </>
        )}
      </FocusedPageBody>
    </FocusedPage>
  );
};
