import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useAppForm } from "#renderer/components/form-kit";
import { Segments } from "#renderer/components/form-kit/controls";
import { Spinner } from "#renderer/components/spinner";
import { failureText } from "#renderer/lib/error-text";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Checkbox } from "#renderer/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "#renderer/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "#renderer/ui/field";
import { Textarea } from "#renderer/ui/textarea";

import { ReferralLink } from "./referral-link";

export const inviteEmails = (text: string) => [
  ...new Set(
    text
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((x) => x.toLowerCase())
  ),
];
export const InviteDialog = ({
  channel,
  connectGmail,
}: {
  channel: "link" | "gmail" | "whatsapp";
  connectGmail(): Promise<unknown>;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const navigate = useAppNavigate();
  const cache = useQueryClient();
  const summary = useQuery(
    transport.orpc.referrals.summary.queryOptions({ input: {} })
  );
  const gmail = useQuery({
    ...transport.orpc.referrals.gmailContacts.queryOptions({ input: {} }),
    enabled: channel === "gmail" && !!summary.data?.gmailConnected,
  });
  const whatsapp = useQuery({
    ...transport.orpc.referrals.whatsappContacts.queryOptions({ input: {} }),
    enabled: IS_ELECTRON && channel === "whatsapp",
  });
  // Overrides belong to each source, so refetches and tab changes keep manual choices.
  const [choices, setChoices] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const contacts =
    channel === "gmail"
      ? (summary.data?.gmailConnected ? (gmail.data ?? []) : []).map((c) => ({
          id: c.email,
          label: c.name ?? c.email,
        }))
      : channel === "whatsapp" && IS_ELECTRON
        ? (whatsapp.data ?? []).map((c) => ({ id: c.chatId, label: c.name }))
        : [];
  const selected = contacts
    .filter((c) => choices[channel]?.[c.id] !== false)
    .map((c) => c.id);
  const [error, setError] = useState<string | null>(null);
  // The address being typed; Enter, comma or Tab turns it into a chip (the form's `emails`).
  const [draft, setDraft] = useState("");
  const isEmail = (email: string) =>
    v.safeParse(v.pipe(v.string(), v.email()), email).success;
  const schema = v.object({
    emails: v.string(),
    message: v.pipe(v.string(), v.trim(), v.maxLength(1000)),
  });
  const close = () =>
    void navigate({
      to: "/settings/account",
      search: (old) => ({ ...old, invite: undefined }),
      transition: "none",
    });
  const form = useAppForm({
    defaultValues: { emails: "", message: t("referrals.defaultMessage") },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      try {
        setError(null);
        const parsed = v.parse(schema, value);
        const emails = [
          ...new Set([
            ...selected,
            ...inviteEmails(parsed.emails),
            ...inviteEmails(draft),
          ]),
        ];
        if ((channel === "gmail" ? emails : selected).length === 0) {
          setError(t("phase5.chooseRecipients"));
          return;
        }
        if (channel === "gmail" && !emails.every(isEmail)) {
          setError(t("phase5.invalidEmail"));
          return;
        }
        const outcome =
          channel === "gmail"
            ? await transport.client.referrals.sendEmail({
                emails,
                message: parsed.message,
              })
            : await transport.client.referrals.sendWhatsapp({
                chatIds: selected,
                message: parsed.message,
              });
        if (!outcome.ok) {
          setError(t(`referrals.errors.${outcome.error}`));
          return;
        }
        showInfo(t("phase5.invitesSent"));
        await cache.invalidateQueries({
          queryKey: transport.orpc.referrals.summary.queryKey({ input: {} }),
        });
        close();
      } catch (e) {
        setError(failureText(e));
      }
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("phase5.inviteFriends")}</DialogTitle>
          <DialogDescription>{t("phase5.inviteDetail")}</DialogDescription>
        </DialogHeader>
        <Segments
          label={t("phase5.inviteChannel")}
          value={channel}
          values={["gmail", "whatsapp", "link"]
            .filter((x) => IS_ELECTRON || x !== "whatsapp")
            .map((x) => ({
              value: x,
              label: t(`phase5.inviteChannels.${x}`),
            }))}
          onChange={(invite) =>
            void navigate({
              to: "/settings/account",
              search: (old) => ({
                ...old,
                invite: invite as "link" | "gmail" | "whatsapp",
              }),
              transition: "none",
            })
          }
        />
        {!summary.data ? (
          <p>{t("phase5.inviteSignIn")}</p>
        ) : channel === "link" ? (
          <ReferralLink summary={summary.data} />
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              {channel === "gmail" && !summary.data.gmailConnected && (
                <Button
                  type="button"
                  onClick={() =>
                    void connectGmail()
                      .then(() =>
                        cache.invalidateQueries({
                          queryKey: transport.orpc.referrals.summary.queryKey({
                            input: {},
                          }),
                        })
                      )
                      .catch((e) => setError(failureText(e)))
                  }
                >
                  {t("phase5.connectGmail")}
                </Button>
              )}
              {channel === "gmail" &&
                summary.data.gmailConnected &&
                gmail.isPending && (
                  <p
                    role="status"
                    className="text-muted-foreground flex items-center gap-2 py-1 text-sm"
                  >
                    <Spinner />
                    {t("phase5.loadingGmailContacts")}
                  </p>
                )}
              <div className="max-h-48 overflow-auto">
                {contacts.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 py-1 text-sm"
                  >
                    <Checkbox
                      checked={selected.includes(c.id)}
                      onCheckedChange={(checked) =>
                        setChoices((old) => ({
                          ...old,
                          [channel]: {
                            ...old[channel],
                            [c.id]: checked === true,
                          },
                        }))
                      }
                    />
                    {c.label}
                  </label>
                ))}
              </div>
              {channel === "gmail" && (
                <form.Field name="emails">
                  {(f) => (
                    <Field>
                      <FieldLabel htmlFor="invite-emails">
                        {t("phase5.manualEmails")}
                      </FieldLabel>
                      <div className="border-input bg-input/30 focus-within:border-ring focus-within:ring-ring/50 flex min-h-16 flex-wrap items-start gap-1.5 rounded-lg border px-2.5 py-2 focus-within:ring-[3px]">
                        {inviteEmails(f.state.value).map((email) => (
                          <span
                            key={email}
                            data-slot="invite-email-chip"
                            className="bg-background flex h-6 items-center gap-1 rounded-md border ps-2 pe-1 text-xs"
                          >
                            {email}
                            <button
                              type="button"
                              aria-label={t("phase5.removeEmail", { email })}
                              className="text-muted-foreground hover:text-foreground rounded-sm"
                              onClick={() =>
                                f.handleChange(
                                  inviteEmails(f.state.value)
                                    .filter((other) => other !== email)
                                    .join("\n")
                                )
                              }
                            >
                              <X aria-hidden className="size-3" />
                            </button>
                          </span>
                        ))}
                        <input
                          id="invite-emails"
                          value={draft}
                          placeholder={t("phase5.emailPlaceholder")}
                          className="h-6 min-w-40 flex-1 bg-transparent text-sm outline-none"
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (
                              e.key === "Backspace" &&
                              draft === "" &&
                              f.state.value !== ""
                            ) {
                              f.handleChange(
                                inviteEmails(f.state.value)
                                  .slice(0, -1)
                                  .join("\n")
                              );
                              return;
                            }
                            if (
                              !["Enter", ",", "Tab"].includes(e.key) ||
                              draft.trim() === ""
                            )
                              return;
                            e.preventDefault();
                            const typed = inviteEmails(draft);
                            const valid = typed.filter(isEmail);
                            f.handleChange(
                              [
                                ...new Set([
                                  ...inviteEmails(f.state.value),
                                  ...valid,
                                ]),
                              ].join("\n")
                            );
                            const invalid = typed.filter((x) => !isEmail(x));
                            setDraft(invalid.join(" "));
                            setError(
                              invalid.length > 0
                                ? t("phase5.invalidEmail")
                                : null
                            );
                          }}
                        />
                      </div>
                    </Field>
                  )}
                </form.Field>
              )}
              <form.Field name="message">
                {(f) => (
                  <Field>
                    <FieldLabel htmlFor="invite-message">
                      {t("phase5.inviteNote")}
                    </FieldLabel>
                    <Textarea
                      id="invite-message"
                      value={f.state.value}
                      onChange={(e) => f.handleChange(e.target.value)}
                    />
                  </Field>
                )}
              </form.Field>
              {error && <p role="alert">{error}</p>}
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={close}>
                  {t("phase5.cancel")}
                </Button>
                <form.AppForm>
                  <form.SubmitButton label={t("phase5.sendInvites")} />
                </form.AppForm>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};
