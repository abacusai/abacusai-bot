/**
 * WhatsApp from the browser: the server links the user's WhatsApp to an
 * agent it runs itself, so it answers with no desktop app and no open tab.
 * Phones link by code ("Link with phone number instead"), since a phone
 * cannot scan a QR shown on its own screen.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { ConnectorMark } from "#renderer/components/connector-mark";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { ConnectDialogContent } from "#renderer/components/form-kit/connect-dialog";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { maskedPhone } from "#renderer/lib/format/phone";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#renderer/ui/dialog";
import { Input } from "#renderer/ui/input";

import { useMessagingDialog } from "./messaging-dialog";

const Link = v.object({
  status: v.picklist(["linked", "pending", "unlinked"]),
  code: v.nullish(v.string()),
  phone: v.nullish(v.string()),
});
type Link = v.InferOutput<typeof Link>;

/** The browser's same-origin server call (the platform module passes it in). */
export type CallApps = (service: string, input: unknown) => Promise<unknown>;

/** AbacusAI Bot's own WhatsApp number, when the server offers it. */
export interface BotNumber {
  linked: boolean;
  /** The user's linked number. */
  phone: string | null;
  /** The bot's number. */
  number: string | null;
  unlink(): Promise<void>;
  connect(done: () => void): ReactNode;
}

const STATUS_KEY = ["whatsapp-phone", "status"] as const;
const POLL_MS = 3000;

const linkStatus = async (
  callApps: CallApps,
  linking: boolean
): Promise<Link> =>
  v.parse(
    Link,
    await callApps("getAbacusBotWhatsAppStatus", linking ? { linking } : {})
  );

/** `K7Q49ZWP` reads as `K7Q4-9ZWP`, the way WhatsApp shows its own boxes. */
const spaced = (code: string) =>
  code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

type Step = "number" | "code" | "done";

const LinkDialog = ({
  callApps,
  open,
  onOpenChange,
  linked,
  bot,
}: {
  callApps: CallApps;
  open: boolean;
  onOpenChange(open: boolean): void;
  linked: Link | undefined;
  bot: BotNumber | undefined;
}) => {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const dialog = useMessagingDialog();
  const [step, setStep] = useState<Step>("number");
  const [number, setNumber] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const manage =
    (bot ? bot.linked : linked?.status === "linked") && step === "number";

  useEffect(() => {
    if (!open || step !== "code") return;
    let live = true;
    const timer = setInterval(() => {
      void linkStatus(callApps, true)
        .then((link) => {
          if (!live) return;
          if (link.code) setCode(link.code);
          if (link.status === "linked") {
            setPhone(link.phone ?? null);
            setStep("done");
            cache.setQueryData(STATUS_KEY, { ...link, code: null });
          }
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, step, cache, callApps]);

  const start = async () => {
    setBusy(true);
    setError(null);
    const request = async () => {
      const link = v.parse(
        Link,
        await callApps("linkAbacusBotWhatsApp", {
          phoneNumber: number,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          // The default language for check-ins until the bot learns the user's own.
          language: navigator.language,
        })
      );
      if (link.status === "linked") {
        setPhone(link.phone ?? null);
        setStep("done");
        cache.setQueryData(STATUS_KEY, link);
      } else {
        setCode(link.code ?? null);
        setStep("code");
      }
    };
    await request()
      .catch((e) => {
        setError(e instanceof Error ? e.message : t("phase5.failed"));
      })
      .finally(() => setBusy(false));
  };

  const reset = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setStep("number");
      setCode(null);
      setError(null);
    }
  };

  const chatPhone = (
    (bot ? bot.number : (phone ?? linked?.phone)) ?? ""
  ).replace(/\D/g, "");

  return (
    <Dialog open={open} onOpenChange={reset}>
      <ConnectDialogContent
        className="sm:max-w-[440px]"
        finalFocus={dialog.finalFocus}
      >
        <DialogHeader className="flex-row items-center gap-3">
          <ConnectorMark id="whatsapp" size={32} />
          <DialogTitle className="text-xl font-bold tracking-tight">
            {t(
              step === "code"
                ? "web.whatsapp.codeTitle"
                : step === "done"
                  ? "web.whatsapp.doneTitle"
                  : manage || bot
                    ? "web.whatsapp.title"
                    : "web.whatsapp.dialogTitle"
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t(bot ? "web.whatsappBot.body" : "web.whatsapp.dialogBody")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4 text-[15px] leading-[21px]">
          {manage ? (
            <>
              <p className="text-muted-foreground">
                {t("web.whatsapp.linkedTo", {
                  phone: maskedPhone((bot ? bot.phone : linked?.phone) ?? ""),
                })}
              </p>
              <Button
                size="lg"
                className="h-12 rounded-full text-base"
                nativeButton={false}
                render={
                  <a
                    href={`https://wa.me/${chatPhone}`}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                {t("web.whatsapp.openChat")}
              </Button>
              <Button
                size="lg"
                variant="ghost"
                className="text-destructive h-12 rounded-full text-base"
                onClick={() => setConfirming(true)}
              >
                {t("web.whatsapp.unlink")}
              </Button>
              <ConfirmAction
                open={confirming}
                onOpenChange={setConfirming}
                title={t("web.whatsapp.unlink")}
                description={t("web.whatsapp.unlinkConfirm")}
                label={t("web.whatsapp.unlink")}
                onConfirm={async () => {
                  if (bot) await bot.unlink();
                  else {
                    await callApps("unlinkAbacusBotWhatsApp", {});
                    cache.setQueryData(STATUS_KEY, {
                      status: "unlinked",
                      code: null,
                      phone: null,
                    });
                  }
                  reset(false);
                }}
              />
            </>
          ) : bot ? (
            bot.connect(() => reset(false))
          ) : step === "number" ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void start();
              }}
            >
              <p>{t("web.whatsapp.dialogBody")}</p>
              <label className="flex flex-col gap-2">
                <span className="text-muted-foreground text-[13px] font-medium">
                  {t("web.whatsapp.numberLabel")}
                </span>
                <Input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  required
                  placeholder={t("web.whatsapp.numberPlaceholder")}
                  value={number}
                  onChange={(event) => setNumber(event.target.value)}
                  className="h-12 rounded-[14px] text-base"
                />
              </label>
              {error && (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                size="lg"
                disabled={busy || number.replace(/\D/g, "").length < 8}
                className="h-12 rounded-full text-base"
              >
                {t("web.whatsapp.getCode")}
              </Button>
              <p className="text-muted-foreground text-center text-xs">
                {t("web.whatsapp.consent")}
              </p>
            </form>
          ) : step === "code" ? (
            <>
              <div className="bg-background flex flex-col items-center gap-2.5 rounded-[18px] border px-4 pt-4 pb-3.5">
                <span className="text-muted-foreground text-[13px]">
                  {t("web.whatsapp.codeLabel")}
                </span>
                <span
                  aria-live="polite"
                  className="font-mono text-[32px] font-medium tracking-[0.08em]"
                >
                  {code ? spaced(code) : "••••-••••"}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="rounded-full"
                  disabled={!code}
                  onClick={() => {
                    if (!code) return;
                    void navigator.clipboard.writeText(code).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  {t(copied ? "web.whatsapp.copied" : "web.whatsapp.copy")}
                </Button>
              </div>
              <ol className="flex flex-col gap-3">
                {(["step1", "step2", "step3"] as const).map((key, index) => (
                  <li key={key} className="flex items-start gap-3">
                    <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold">
                      {index + 1}
                    </span>
                    <span>{t(`web.whatsapp.${key}`)}</span>
                  </li>
                ))}
              </ol>
              <p className="text-muted-foreground text-[13px] leading-[18px]">
                {t("web.whatsapp.scamNote")}
              </p>
              <Button
                size="lg"
                className="h-12 rounded-full text-base"
                nativeButton={false}
                render={<a href="whatsapp://" />}
              >
                {t("web.whatsapp.openWhatsApp")}
              </Button>
              <p
                role="status"
                className="text-muted-foreground flex items-center justify-center gap-2 text-[13px]"
              >
                <span className="size-2 animate-pulse rounded-full bg-amber-500" />
                {t("web.whatsapp.waiting")}
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <span className="flex size-16 items-center justify-center rounded-full bg-emerald-500/15">
                  <Check className="size-8 text-emerald-500" />
                </span>
                {phone && (
                  <p className="text-[17px] font-semibold">
                    {t("web.whatsapp.linkedTo", { phone: maskedPhone(phone) })}
                  </p>
                )}
                <p className="text-muted-foreground">
                  {t("web.whatsapp.doneBody")}
                </p>
              </div>
              <Button
                size="lg"
                className="h-12 rounded-full text-base"
                nativeButton={false}
                render={
                  <a
                    href={`https://wa.me/${chatPhone}`}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                {t("web.whatsapp.openChat")}
              </Button>
              <Button
                size="lg"
                variant="secondary"
                className="h-12 rounded-full text-base"
                onClick={() => reset(false)}
              >
                {t("web.whatsapp.done")}
              </Button>
            </>
          )}
        </div>
      </ConnectDialogContent>
    </Dialog>
  );
};

/** Library › Messaging in the browser: WhatsApp, run by the server. */
export const WebMessagingPage = ({
  callApps,
  bot,
}: {
  callApps: CallApps;
  bot?: BotNumber;
}) => {
  const { t } = useTranslation();
  const dialog = useMessagingDialog();
  const open = dialog.platform === "whatsapp";
  const setOpen = (open: boolean) => {
    if (open) void dialog.open("whatsapp");
    else void dialog.close();
  };
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => linkStatus(callApps, false),
    retry: false,
    enabled: !bot,
  });
  const linked = bot ? bot.linked : status.data?.status === "linked";
  return (
    <AreaPage
      title={t("library.pages.messaging")}
      description={t("web.whatsapp.pageDescription")}
    >
      <GroupCard>
        <SettingRow
          id="whatsapp"
          title={t("web.whatsapp.title")}
          detail={
            bot
              ? bot.linked && bot.phone
                ? maskedPhone(bot.phone)
                : t("web.whatsappBot.rowDetail")
              : t("web.whatsapp.rowDetail")
          }
        >
          <ConnectorMark id="whatsapp" size={28} />
          {linked && (
            <StatePill tone="success">{t("web.whatsapp.connected")}</StatePill>
          )}
          <Button
            size="sm"
            variant={linked ? "secondary" : "default"}
            className="rounded-full"
            disabled={!bot && (status.isPending || status.isError)}
            data-messaging-channel="whatsapp"
            onClick={() => setOpen(true)}
          >
            {t(linked ? "phase5.manage" : "phase5.connect")}
          </Button>
        </SettingRow>
      </GroupCard>
      {status.error instanceof Error && (
        <p role="alert" className="text-destructive px-1 text-[13px]">
          {status.error.message}
        </p>
      )}
      <p className="text-muted-foreground px-1 text-[13px]">
        {t("web.whatsapp.note")}
      </p>
      <LinkDialog
        callApps={callApps}
        open={open}
        onOpenChange={setOpen}
        linked={status.data}
        bot={bot}
      />
    </AreaPage>
  );
};
