import { ArrowUpRight, X } from "lucide-react";
import type { JSX } from "react";

import { AbacusBotMark } from "../brand/abacus-bot-logo";
import { Button } from "../ui";

/**
 * The card that sits under the sidebar's nav: the Abacus mark, two lines, and
 * one button out to the web. Shared so the free tier's upsell, the
 * out-of-credits notice and the paid tier's link to the agent are one shape
 * rather than three that drifted apart.
 */
export const UpsellCard = ({
  dataId,
  title,
  body,
  cta,
  onCta,
  secondaryCta,
  onSecondaryCta,
  onDismiss,
  dismissLabel,
}: {
  dataId: string;
  title: string;
  body: string;
  /** Omitted for a card whose whole message is the text. */
  cta?: string;
  onCta?: () => void;
  /** A quieter second way out, under the button. */
  secondaryCta?: string;
  onSecondaryCta?: () => void;
  /** Given only where dismissing is allowed; the card is closable then. */
  onDismiss?: () => void;
  dismissLabel?: string;
}): JSX.Element => (
  <div
    data-id={dataId}
    className="border-primary/35 from-primary/15 relative mx-2 mb-1 flex flex-col gap-2.5 rounded-lg border bg-gradient-to-br to-violet-700/10 px-3 py-2.5"
  >
    {onDismiss != null && (
      <button
        type="button"
        data-id={`${dataId}-dismiss`}
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="text-muted-foreground hover:text-foreground absolute end-1.5 top-1.5 rounded p-0.5 transition-colors"
      >
        <X className="size-3" />
      </button>
    )}
    <div className="flex items-start gap-2">
      <AbacusBotMark size={28} className="rounded-md" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] leading-snug font-semibold text-balance">
          {title}
        </span>
        <span className="text-muted-foreground text-xs leading-snug">
          {body}
        </span>
      </span>
    </div>
    {cta != null && (
      <Button
        size="sm"
        data-id={`${dataId}-cta`}
        className="from-primary w-full bg-gradient-to-b to-violet-700 font-semibold"
        onClick={onCta}
      >
        {cta}
        <ArrowUpRight />
      </Button>
    )}
    {secondaryCta != null && (
      <Button
        variant="link"
        size="sm"
        data-id={`${dataId}-secondary-cta`}
        className="text-muted-foreground hover:text-foreground h-auto p-0 text-xs"
        onClick={onSecondaryCta}
      >
        {secondaryCta}
      </Button>
    )}
  </div>
);
