import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useAppForm } from "#renderer/components/form-kit";
import { Segments } from "#renderer/components/form-kit/controls";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { showInfo } from "#renderer/lib/toast";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";
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
    enabled: channel === "whatsapp",
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
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
          ...new Set([...selected, ...inviteEmails(parsed.emails)]),
        ];
        if ((channel === "gmail" ? emails : selected).length === 0) {
          setError(t("phase5.chooseRecipients"));
          return;
        }
        if (
          channel === "gmail" &&
          !emails.every(
            (email) => v.safeParse(v.pipe(v.string(), v.email()), email).success
          )
        ) {
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
        setError(errorText(e));
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
          values={["link", "gmail", "whatsapp"].map((x) => ({
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
          <Button
            onClick={() =>
              void navigator.clipboard
                .writeText(summary.data!.inviteLink)
                .then(() => showInfo(t("phase5.copied")))
            }
          >
            {t("phase5.copyInvite")}
          </Button>
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
                      .catch((e) => setError(errorText(e)))
                  }
                >
                  {t("phase5.connectGmail")}
                </Button>
              )}
              <div className="max-h-48 overflow-auto">
                {(channel === "gmail"
                  ? (gmail.data ?? []).map((c) => ({
                      id: c.email,
                      label: c.name ?? c.email,
                    }))
                  : (whatsapp.data ?? []).map((c) => ({
                      id: c.chatId,
                      label: c.name,
                    }))
                ).map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 py-1 text-sm"
                  >
                    <Checkbox
                      checked={selected.includes(c.id)}
                      onCheckedChange={(checked) =>
                        setSelected((old) =>
                          checked === true
                            ? [...old, c.id]
                            : old.filter((id) => id !== c.id)
                        )
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
                      <Textarea
                        id="invite-emails"
                        value={f.state.value}
                        onChange={(e) => f.handleChange(e.target.value)}
                      />
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
