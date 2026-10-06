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
import { Check } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { ConnectorMark } from "#renderer/components/connector-mark";
import { Spinner } from "#renderer/components/spinner";
import { maskedPhone } from "#renderer/lib/format/phone";
import { showError, showInfo } from "#renderer/lib/toast";
import { useMediaQuery } from "#renderer/lib/use-media-query";
import { Button } from "#renderer/ui/button";
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

/** Onboarding's fact: offered and not linked yet. A failing call offers nothing. */
export const loadWhatsAppOffered = async (
  queryClient: QueryClient,
  callApps: CallApps
): Promise<boolean> => {
  try {
    const chat = await queryClient.fetchQuery(whatsappChatQuery(callApps));
    return chat.available && chat.status !== "linked";
  } catch {
    return false;
  }
};

export const unlinkWhatsAppChat = async (
  queryClient: QueryClient,
  callApps: CallApps
): Promise<void> => {
  await callApps("unlinkAbacusBotWhatsAppChat", {});
  queryClient.setQueryData<WhatsAppChat>(CHAT_KEY, (chat) =>
    chat ? { ...chat, status: "unlinked", phone: null } : chat
  );
};

/**
 * Number, then waiting for the user's message. `as="h1"` is the onboarding
 * step (its heading takes focus); the settings sheet titles itself.
 */
export const WhatsAppConnect = ({
  callApps,
  as: Heading = "h2",
  onLinked,
  onSkip,
}: {
  callApps: CallApps;
  as?: "h1" | "h2";
  onLinked(): void;
  onSkip?(): void;
}) => {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const phoneLayout = useMediaQuery("(max-width: 799px)");
  const [number, setNumber] = useState("");
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const waiting = deepLink != null;
  const chat = useQuery({
    ...whatsappChatQuery(callApps),
    enabled: waiting,
    refetchInterval: POLL_MS,
  });
  const linked = waiting && chat.data?.status === "linked";
  const linkedOnce = useEffectEvent(onLinked);

  useEffect(() => {
    if (Heading === "h1") heading.current?.focus();
  }, [Heading, waiting]);
  useEffect(() => {
    if (linked) linkedOnce();
  }, [linked]);

  const open = (link: string) => {
    // A phone hands wa.me to the WhatsApp app; a computer keeps this tab.
    if (phoneLayout) location.href = link;
    else window.open(link, "_blank", "noopener");
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = v.parse(
        Started,
        await callApps("startAbacusBotWhatsAppChat", {
          phoneNumber: number,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      );
      if (started.status === "linked") {
        setLinked(cache, started.phone);
        onLinked();
      } else if (started.deepLink) {
        setDeepLink(started.deepLink);
        open(started.deepLink);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("phase5.failed"));
    } finally {
      setBusy(false);
    }
  };

  const skip = onSkip && (
    <Button variant="ghost" className="h-11 w-full" onClick={onSkip}>
      {t("web.whatsappBot.skip")}
    </Button>
  );

  return (
    <>
      <Heading ref={heading} tabIndex={-1} className="outline-none">
        {t(waiting ? "web.whatsappBot.waitingTitle" : "web.whatsappBot.title")}
      </Heading>
      <p>
        {t(waiting ? "web.whatsappBot.waitingBody" : "web.whatsappBot.body")}
      </p>
      {deepLink ? (
        <div className="flex w-full flex-col gap-3">
          <p
            aria-label={t("web.whatsappBot.message")}
            className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-emerald-100 px-4 py-2.5 text-left text-[15px] leading-[21px] text-emerald-950 dark:bg-emerald-900 dark:text-emerald-50"
          >
            {new URL(deepLink).searchParams.get("text")}
          </p>
          <p
            role="status"
            aria-live="polite"
            className="flex items-center justify-center gap-2 text-sm"
          >
            <Spinner aria-hidden />
            {t("web.whatsappBot.waitingFor", { phone: maskedPhone(number) })}
          </p>
          <Button
            size="lg"
            className="h-12 w-full rounded-full text-base"
            nativeButton={false}
            render={
              <a
                href={deepLink}
                target={phoneLayout ? undefined : "_blank"}
                rel="noreferrer"
              />
            }
          >
            {t("web.whatsappBot.openAgain")}
          </Button>
          <Button
            variant="ghost"
            className="h-11 w-full"
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
          <label className="flex flex-col gap-2">
            <span className="text-muted-foreground text-[13px] font-medium">
              {t("web.whatsappBot.numberLabel")}
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
            disabled={busy || number.replace(/\D/g, "").length < MIN_DIGITS}
            className="h-12 rounded-full text-base"
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

/** Onboarding's connectors step, once linked. */
export const WhatsAppLinkedBanner = ({ callApps }: { callApps: CallApps }) => {
  const { t } = useTranslation();
  const chat = useQuery(whatsappChatQuery(callApps)).data;
  if (!chat?.available || chat.status !== "linked") return null;
  return (
    <div className="bg-card flex w-full items-center gap-3 rounded-xl border p-3 text-left text-sm">
      <ConnectorMark id="whatsapp" size={24} />
      <span className="flex-1 font-medium">
        {t("web.whatsappBot.connected")}
      </span>
      {chat.phone && (
        <span className="text-muted-foreground">{maskedPhone(chat.phone)}</span>
      )}
      <Check aria-hidden className="size-4 text-emerald-500" />
    </div>
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

/** Signed in: claims a stashed link once and says how it went. */
export const WhatsAppClaim = ({ callApps }: { callApps: CallApps }) => {
  const { t } = useTranslation();
  const cache = useQueryClient();
  useEffect(() => {
    let token: unknown;
    try {
      token = JSON.parse(sessionStorage.getItem(CLAIM_KEY) ?? "null");
      sessionStorage.removeItem(CLAIM_KEY);
    } catch {
      return;
    }
    if (typeof token !== "string") return;
    callApps("claimAbacusBotWhatsApp", { token }).then(
      () => {
        void cache.invalidateQueries({ queryKey: CHAT_KEY });
        showInfo(t("web.whatsappBot.connected"));
      },
      (e: unknown) =>
        showError(e instanceof Error ? e.message : t("phase5.failed"))
    );
  }, [callApps, cache, t]);
  return null;
};
