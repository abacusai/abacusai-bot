import type { ReferralSummary } from "@abacus-ai/contract/contracts";
import { Check, Copy } from "lucide-react";
import { motion } from "motion/react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ABACUS_TERMS_URL } from "#renderer/lib/abacus-links";
import {
  durations,
  easings,
  springs,
  reducedTransition,
  useMotionPreference,
} from "#renderer/lib/motion";
import { platformSystem } from "#renderer/lib/platform-system";
import { showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";

export const ReferralLink = ({
  summary,
  firstOpen = true,
}: {
  summary: ReferralSummary;
  firstOpen?: boolean;
}) => {
  const { t, i18n } = useTranslation();
  const { transport } = useAppContext();
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const [copied, setCopied] = useState(false);
  const reduced = useMotionPreference() === "reduced";
  const progress = Math.min(
    1,
    Math.max(0, summary.invitesSent) / summary.milestoneInvites
  );
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <div className="flex flex-col gap-4">
      <svg
        viewBox="0 0 240 112"
        className="text-primary mx-auto h-24 w-60"
        aria-hidden
      >
        <defs>
          <linearGradient id={id + "-tint"} x2="1" y2="1">
            <stop stopColor="currentColor" stopOpacity=".03" />
            <stop offset="1" stopColor="currentColor" stopOpacity=".15" />
          </linearGradient>
        </defs>
        <motion.ellipse
          cx="120"
          cy="54"
          rx="92"
          ry="45"
          fill="currentColor"
          initial={false}
          animate={
            firstOpen && !reduced ? { opacity: [0, 0.08, 0] } : { opacity: 0 }
          }
          transition={{
            duration: durations.surface / 1000,
            ease: easings.standard,
          }}
        />
        <rect
          x="42"
          y="32"
          width="156"
          height="64"
          rx="12"
          fill="currentColor"
          opacity=".08"
        />
        <path
          d="M64 22h112a8 8 0 0 1 8 8v12a10 10 0 0 0 0 20v12a8 8 0 0 1-8 8H64a8 8 0 0 1-8-8V62a10 10 0 0 0 0-20V30a8 8 0 0 1 8-8Z"
          fill={`url(#${id}-tint)`}
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M142 28v48"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="3 5"
          opacity=".3"
        />
        <path
          d="M94 40h24v23H94zM90 40h32v7H90zM106 40v23M106 40c-16 0-13-17-5-9l5 9Zm0 0c16 0 13-17 5-9l-5 9Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      <p className="text-muted-foreground text-center text-sm">
        {t("profile.referralValue")}
      </p>
      {summary.milestoneInvites > 0 && (
        <div className="flex flex-col items-center gap-2">
          <div className="flex gap-1" aria-hidden>
            {Array.from({ length: 5 }, (_, index) => (
              <span
                key={index}
                className={
                  index < Math.floor(progress * 5)
                    ? "bg-primary/60 h-1.5 w-5 rounded-full"
                    : "bg-primary/10 h-1.5 w-5 rounded-full"
                }
              />
            ))}
          </div>
          <p className="text-muted-foreground text-center text-xs">
            {t("referrals.progressTitle", {
              sent: number.format(Math.max(0, summary.invitesSent)),
              total: number.format(summary.milestoneInvites),
            })}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <label htmlFor={id} className="text-xs font-medium">
          {t("phase5.inviteLink")}
        </label>
        <Input
          id={id}
          ref={field}
          readOnly
          value={summary.inviteLink}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          onClick={async () => {
            setCopied(false);
            try {
              await navigator.clipboard.writeText(summary.inviteLink);
              setCopied(true);
              showInfo(t("phase5.copied"));
            } catch {
              field.current?.focus();
              field.current?.select();
            }
          }}
        >
          <motion.span
            key={copied ? "copied" : "copy"}
            className="inline-flex size-4 items-center justify-center"
            initial={reduced ? false : { opacity: 0, transform: "scale(0.9)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            transition={reduced ? reducedTransition : springs.surface}
          >
            {copied ? (
              <Check className="size-4" aria-hidden />
            ) : (
              <Copy className="size-4" aria-hidden />
            )}
          </motion.span>
          {t(copied ? "phase5.copied" : "phase5.copyInvite")}
        </Button>
      </div>
      <a
        className="text-muted-foreground self-center text-xs underline underline-offset-4"
        href={ABACUS_TERMS_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          void platformSystem(transport.client).openExternal({
            url: ABACUS_TERMS_URL,
          });
        }}
      >
        {t("profile.terms")}
      </a>
    </div>
  );
};
