/**
 * WhatsApp with AbacusAI Bot's own number, in the browser only (the platform
 * module passes the same-origin `callApps` in). The user sends a pre-typed
 * message carrying a code, and the server links the sending number.
 */
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { ConnectorMark } from "#renderer/components/connector-mark";
import { FlowPage, FlowContent } from "#renderer/components/form-kit/flow-page";
import { Spinner } from "#renderer/components/spinner";
import { maskedPhone } from "#renderer/lib/format/phone";
import { isPhone } from "#renderer/lib/phone";
import { showInfo } from "#renderer/lib/toast";
import { useMediaQuery } from "#renderer/lib/use-media-query";
import { Button } from "#renderer/ui/button";
import { Dialog, DialogContent } from "#renderer/ui/dialog";
import { Field, FieldLabel } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";

export type CallApps = (service: string, input: unknown) => Promise<unknown>;

const Chat = v.object({
  available: v.boolean(),
  status: v.nullish(v.picklist(["linked", "unlinked"])),
  phone: v.nullish(v.string()),
  number: v.nullish(v.string()),
});
export type WhatsAppChat = v.InferOutput<typeof Chat>;

const Started = v.object({
  status: v.picklist(["pending", "linked"]),
  deepLink: v.nullish(v.string()),
  phone: v.nullish(v.string()),
  /** Unix seconds; the code stops linking after it. */
  expiresAt: v.nullish(v.number()),
});

const CHAT_KEY = ["whatsapp-bot", "chat"] as const;
const CLAIM_KEY = "abacusai-bot:whatsapp.claim";
const POLL_MS = 3000;
const MIN_DIGITS = 7;

export const whatsappChatQuery = (callApps: CallApps) =>
  queryOptions({
    queryKey: CHAT_KEY,
    queryFn: async () =>
      v.parse(Chat, await callApps("getAbacusBotWhatsAppChat", {})),
    staleTime: 30_000,
    retry: false,
  });

const setLinked = (cache: QueryClient, phone: string | null | undefined) =>
  cache.setQueryData<WhatsAppChat>(CHAT_KEY, (chat) =>
    chat ? { ...chat, status: "linked", phone: phone ?? chat.phone } : chat
  );

export const unlinkWhatsAppChat = async (
  queryClient: QueryClient,
  callApps: CallApps
): Promise<void> => {
  await callApps("unlinkAbacusBotWhatsAppChat", {});
  queryClient.setQueryData<WhatsAppChat>(CHAT_KEY, (chat) =>
    chat ? { ...chat, status: "unlinked", phone: null } : chat
  );
};

const messageOf = (deepLink: string) =>
  new URL(deepLink).searchParams.get("text") ?? "";

/** The pre-typed message, as it will show in WhatsApp; a computer can copy it. */
const MessageToSend = ({
  deepLink,
  copyable = false,
}: {
  deepLink: string;
  copyable?: boolean;
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const message = messageOf(deepLink);
  return (
    <div className="flex items-end justify-end gap-2">
      {copyable && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(message).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {t(copied ? "web.whatsapp.copied" : "web.whatsappBot.copyMessage")}
        </Button>
      )}
      <p
        aria-label={t("web.whatsappBot.message")}
        className="bg-muted text-foreground max-w-[85%] rounded-(--pane-radius) px-3 py-2 text-left text-sm/relaxed break-words"
      >
        {message}
      </p>
    </div>
  );
};

const WaitingLine = ({ phone }: { phone: string }) => {
  const { t } = useTranslation();
  return (
    <p
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 text-sm"
    >
      <Spinner aria-hidden />
      {t("web.whatsappBot.waitingFor", { phone: maskedPhone(phone) })}
    </p>
  );
};

/** The same wa.me link as a QR: the phone's camera opens WhatsApp with the message typed. */
const ScanToSend = ({ deepLink }: { deepLink: string }) => {
  const { t } = useTranslation();
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Loaded on demand: only a computer's waiting step draws one.
    void import("qrcode")
      .then((qr) => qr.toString(deepLink, { type: "svg", margin: 1 }))
      .then((drawn) => {
        if (live) setSvg(drawn);
      })
      .catch((error: unknown) =>
        console.warn("[whatsapp] QR not drawn", error)
      );
    return () => {
      live = false;
    };
  }, [deepLink]);
  return (
    <div className="bg-background flex flex-col items-center gap-2 rounded-(--pane-radius) border px-4 pt-4 pb-3">
      <span className="text-sm font-medium">
        {t("web.whatsappBot.scanTitle")}
      </span>
      <div className="flex size-44 items-center justify-center rounded-lg bg-white p-1">
        {svg ? (
          <img
            className="size-full"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
            alt={t("web.whatsappBot.scanTitle")}
          />
        ) : (
          <Spinner aria-hidden />
        )}
      </div>
      <span className="text-muted-foreground text-xs text-pretty">
        {t("web.whatsappBot.scanHint")}
      </span>
    </div>
  );
};

/**
 * Number, then the message to send: the user taps Open WhatsApp (a real link,
 * so the phone hands it to the app and this tab stays to see the link land).
 * `as="h1"` is the first-run intro (its heading takes focus); the messaging
 * sheet titles itself.
 */
export const WhatsAppConnect = ({
  callApps,
  as: Heading = "h2",
  onLinked,
  onSkip,
}: {
  callApps: CallApps;
  as?: "h1" | "h2";
  onLinked?(): void;
  onSkip?(): void;
}) => {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [number, setNumber] = useState("");
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const numberId = useId();
  // A mouse means a computer: the phone scans a QR rather than this tab opening WhatsApp.
  const laptop = useMediaQuery("(pointer: fine)");
  const waiting = deepLink != null && !expired;
  const chat = useQuery({
    ...whatsappChatQuery(callApps),
    enabled: waiting,
    refetchInterval: POLL_MS,
  });
  const linked = waiting && chat.data?.status === "linked";
  const linkedOnce = useEffectEvent(() => onLinked?.());

  useEffect(() => {
    if (Heading === "h1") heading.current?.focus();
  }, [Heading, waiting]);
  useEffect(() => {
    if (linked) linkedOnce();
  }, [linked]);
  useEffect(() => {
    if (!waiting || expiresAt == null) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, expiresAt * 1000 - Date.now())
    );
    return () => clearTimeout(timer);
  }, [waiting, expiresAt]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      // Signed in from the link the bot texted back: it links at once when this
      // is the number that texted, otherwise it is the usual pre-typed code.
      const token = stashedClaim();
      const started = v.parse(
        Started,
        await callApps(
          token ? "claimAbacusBotWhatsApp" : "startAbacusBotWhatsAppChat",
          {
            phoneNumber: number,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            // The default language for check-ins until the bot learns the user's own.
            language: navigator.language,
            ...(token ? { token } : {}),
          }
        )
      );
      if (token) dropClaim();
      if (started.status === "linked") {
        setLinked(cache, started.phone);
        onLinked?.();
      } else if (started.deepLink) {
        setExpired(false);
        setExpiresAt(started.expiresAt ?? null);
        setDeepLink(started.deepLink);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("phase5.failed"));
    } finally {
      setBusy(false);
    }
  };

  const skip = onSkip && (
    <Button variant="ghost" size="lg" className="w-full" onClick={onSkip}>
      {t("web.whatsappBot.skip")}
    </Button>
  );

  return (
    <>
      <Heading ref={heading} tabIndex={-1} className="page-title outline-none">
        {t(
          expired
            ? "web.whatsappBot.expiredTitle"
            : waiting
              ? "web.whatsappBot.waitingTitle"
              : "web.whatsappBot.title"
        )}
      </Heading>
      <p className="text-muted-foreground text-sm/relaxed text-pretty">
        {t(
          expired
            ? "web.whatsappBot.expiredBody"
            : waiting
              ? laptop
                ? "web.whatsappBot.waitingBodyLaptop"
                : "web.whatsappBot.waitingBody"
              : "web.whatsappBot.body"
        )}
      </p>
      {expired ? (
        <div className="flex w-full flex-col gap-3">
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button
            size="lg"
            className="w-full"
            disabled={busy}
            onClick={() => void start()}
          >
            {t("web.whatsappBot.newCode")}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="w-full"
            onClick={() => {
              setDeepLink(null);
              setExpired(false);
            }}
          >
            {t("web.whatsappBot.changeNumber")}
          </Button>
          {skip}
        </div>
      ) : deepLink && laptop ? (
        <div className="flex w-full flex-col gap-3">
          <ScanToSend deepLink={deepLink} />
          <WaitingLine phone={number} />
          <div className="text-muted-foreground flex items-center gap-3 text-xs">
            <span className="bg-border h-px flex-1" />
            {t("web.whatsappBot.orFromComputer")}
            <span className="bg-border h-px flex-1" />
          </div>
          <Button
            variant="secondary"
            size="lg"
            className="w-full"
            nativeButton={false}
            render={<a href={deepLink} target="_blank" rel="noreferrer" />}
          >
            {t("web.whatsapp.openWhatsApp")}
          </Button>
          <MessageToSend deepLink={deepLink} copyable />
          <Button
            variant="ghost"
            size="lg"
            className="w-full"
            onClick={() => setDeepLink(null)}
          >
            {t("web.whatsappBot.changeNumber")}
          </Button>
          {skip}
        </div>
      ) : deepLink ? (
        <div className="flex w-full flex-col gap-3">
          <MessageToSend deepLink={deepLink} />
          <WaitingLine phone={number} />
          <Button
            size="lg"
            className="w-full"
            nativeButton={false}
            render={<a href={deepLink} target="_blank" rel="noreferrer" />}
          >
            {t("web.whatsapp.openWhatsApp")}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="w-full"
            onClick={() => setDeepLink(null)}
          >
            {t("web.whatsappBot.changeNumber")}
          </Button>
          {skip}
        </div>
      ) : (
        <form
          className="flex w-full flex-col gap-3 text-left"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <Field>
            <FieldLabel htmlFor={numberId}>
              {t("web.whatsappBot.numberLabel")}
            </FieldLabel>
            <Input
              id={numberId}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              placeholder={t("web.whatsapp.numberPlaceholder")}
              value={number}
              onChange={(event) => setNumber(event.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button
            type="submit"
            size="lg"
            disabled={busy || number.replace(/\D/g, "").length < MIN_DIGITS}
            className="w-full"
          >
            {t("web.whatsappBot.connect")}
          </Button>
          <p className="text-muted-foreground text-center text-xs">
            {t("web.whatsappBot.note")}
          </p>
          {skip}
        </form>
      )}
    </>
  );
};

/**
 * AbacusAI Bot on a phone is WhatsApp: connect a number, then chat there.
 * Only these two screens draw (no Skip); the bot runs on the server. The
 * caller has the chat in the cache already, and linking or unlinking flips it.
 */
export const PhoneWhatsAppApp = ({ callApps }: { callApps: CallApps }) => {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const chat = useQuery(whatsappChatQuery(callApps));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeNumber = async () => {
    setBusy(true);
    setError(null);
    try {
      await unlinkWhatsAppChat(cache, callApps);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("phase5.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FlowPage media={<ConnectorMark id="whatsapp" size={56} />}>
      {chat.data?.status === "linked" ? (
        <>
          <h1 className="page-title">{t("web.whatsappBot.doneTitle")}</h1>
          <p className="text-muted-foreground text-sm/relaxed">
            {t("web.whatsappBot.doneBody")}
          </p>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button
            size="lg"
            className="w-full"
            nativeButton={false}
            render={
              <a
                href={`https://wa.me/${(chat.data.number ?? "").replace(/\D/g, "")}`}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            {t("web.whatsapp.openWhatsApp")}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="w-full"
            disabled={busy}
            onClick={() => void changeNumber()}
          >
            {t("web.whatsappBot.useDifferentNumber")}
          </Button>
        </>
      ) : (
        <WhatsAppConnect callApps={callApps} as="h1" />
      )}
    </FlowPage>
  );
};

/**
 * The browser's first run: "Connect your WhatsApp" over the shell, once per
 * account (`seen` is the account's pref), while the server offers the bot's
 * number and none is linked. Linking or skipping marks it seen; the
 * messaging page keeps the way in. A phone gets no Skip.
 */
export const WhatsAppIntro = ({
  callApps,
  seen,
  markSeen,
}: {
  callApps: CallApps;
  seen: boolean;
  markSeen(): Promise<void>;
}) => {
  const { t } = useTranslation();
  const chat = useQuery({ ...whatsappChatQuery(callApps), enabled: !seen });
  const [closed, setClosed] = useState(false);
  if (seen || closed || !chat.data?.available) return null;
  if (chat.data.status === "linked") return null;
  const close = (linked: boolean) => {
    setClosed(true);
    if (linked) showInfo(t("web.whatsappBot.connected"));
    void markSeen().catch((error: unknown) =>
      console.warn("[whatsapp] intro not marked seen", error)
    );
  };
  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(_, details) => details.cancel()}
    >
      <DialogContent
        aria-label={t("web.whatsappBot.title")}
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-(--pane-radius)"
      >
        <FlowContent media={<ConnectorMark id="whatsapp" size={56} />}>
          <WhatsAppConnect
            callApps={callApps}
            as="h1"
            onLinked={() => close(true)}
            // On a phone the bot is WhatsApp: there is no browser to skip to.
            {...(isPhone() ? {} : { onSkip: () => close(false) })}
          />
        </FlowContent>
      </DialogContent>
    </Dialog>
  );
};

/**
 * The agent's "Connect WhatsApp" card on the web: the same number-then-message
 * flow in a dismissible dialog. `onLinked` runs once the number is linked.
 */
export const WhatsAppConnectDialog = ({
  callApps,
  open,
  onOpenChange,
  onLinked,
}: {
  callApps: CallApps;
  open: boolean;
  onOpenChange(open: boolean): void;
  onLinked(): void;
}) => {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent
        aria-label={t("web.whatsappBot.title")}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-(--pane-radius)"
      >
        <FlowContent media={<ConnectorMark id="whatsapp" size={56} />}>
          <WhatsAppConnect callApps={callApps} onLinked={onLinked} />
        </FlowContent>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Boot, before a sign-in redirect can drop it: keeps the bot's
 * `?whatsapp=<token>` claim link for this tab and clears the address.
 */
export const stashWhatsAppClaim = () => {
  const url = new URL(location.href);
  const token = url.searchParams.get("whatsapp");
  if (!token) return;
  try {
    sessionStorage.setItem(CLAIM_KEY, JSON.stringify(token));
  } catch {
    return;
  }
  url.searchParams.delete("whatsapp");
  history.replaceState(history.state, "", url);
};

const stashedClaim = (): string | null => {
  try {
    const token: unknown = JSON.parse(
      sessionStorage.getItem(CLAIM_KEY) ?? "null"
    );
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
};

const dropClaim = () => {
  try {
    sessionStorage.removeItem(CLAIM_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
};
