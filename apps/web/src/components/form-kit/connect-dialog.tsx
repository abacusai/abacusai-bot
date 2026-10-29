import { CheckIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { BootAvatar, type BootStage } from "#renderer/components/boot-avatar";
import type { AvatarMood } from "#renderer/lib/bots/avatar";
import { cn } from "#renderer/lib/cn";
import { useMediaQuery } from "#renderer/lib/use-media-query";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#renderer/ui/dialog";
import { SheetContent } from "#renderer/ui/sheet";

import { StatePill } from "./page";

export const ConnectDialogContent = ({
  children,
  stage = "waiting",
  mood,
  className,
  ...props
}: ComponentProps<typeof DialogContent> & {
  stage?: BootStage;
  mood?: AvatarMood;
}) => {
  const phone = useMediaQuery("(max-width: 799px)");
  const content = (
    <div className="flex min-w-0 flex-col gap-3 text-left [&_[data-slot=boot-avatar]]:items-start [&_[data-slot=button]]:text-[13px] [&_[data-slot=input]]:h-8">
      <BootAvatar stage={stage} mood={mood} size={48} brand={false} overlay />
      {children}
    </div>
  );
  return phone ? (
    <SheetContent
      {...props}
      side="bottom"
      className={cn(
        className,
        "max-h-dvh max-w-none overflow-y-auto rounded-none border-0 p-6 data-[side=bottom]:h-dvh sm:max-w-none"
      )}
    >
      {content}
    </SheetContent>
  ) : (
    <DialogContent
      {...props}
      className={cn(
        "max-h-[calc(100dvh-3rem)] gap-3 overflow-y-auto p-6 sm:max-w-[440px]",
        className
      )}
    >
      {content}
    </DialogContent>
  );
};

export const ConnectDialog = ({
  label,
  children,
  dismissible = true,
  stage,
  mood,
  ...props
}: Omit<ComponentProps<typeof Dialog>, "children"> & {
  label: string;
  children: ReactNode;
  dismissible?: boolean;
  stage?: BootStage;
  mood?: AvatarMood;
}) => (
  <Dialog
    {...props}
    {...(!dismissible
      ? {
          disablePointerDismissal: true,
          onOpenChange: (
            _: boolean,
            details: Parameters<
              NonNullable<ComponentProps<typeof Dialog>["onOpenChange"]>
            >[1]
          ) => details.cancel(),
        }
      : {})}
  >
    <ConnectDialogContent
      aria-label={label}
      showCloseButton={dismissible}
      stage={stage}
      mood={mood}
    >
      {children}
    </ConnectDialogContent>
  </Dialog>
);

/** A connect dialog's header: the service's mark, its name and where it stands. */
export const ConnectHeader = ({
  mark,
  title,
  status,
  description,
}: {
  mark?: ReactNode;
  title: ReactNode;
  status?: { label: string; tone: ComponentProps<typeof StatePill>["tone"] };
  /** Read to assistive tech; the body says it on screen. */
  description: ReactNode;
}) => (
  <DialogHeader className="flex-row items-center gap-3">
    {mark}
    <DialogTitle className="text-xl font-bold tracking-tight">
      {title}
    </DialogTitle>
    {status && (
      <span className="ml-auto">
        <StatePill tone={status.tone}>{status.label}</StatePill>
      </span>
    )}
    <DialogDescription className="sr-only">{description}</DialogDescription>
  </DialogHeader>
);

/** The secondary line under a step or a field: muted, or an error. */
export const ConnectNote = ({
  error = false,
  className,
  ...props
}: ComponentProps<"p"> & { error?: boolean }) => (
  <p
    {...(error ? { role: "alert" } : {})}
    {...props}
    className={cn(
      "text-[13px] leading-[18px]",
      error ? "text-destructive" : "text-muted-foreground",
      className
    )}
  />
);

/** What a connect is waiting on, as one pulsing line. */
export const ConnectWaiting = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <p
    role="status"
    className={cn(
      "text-muted-foreground flex items-center gap-2 text-[13px] leading-[18px]",
      className
    )}
  >
    <span className="size-2 shrink-0 animate-pulse rounded-full bg-[var(--chat-status-attention)]" />
    {children}
  </p>
);

/**
 * A row's connect waiting on the browser (`useRowConnects`): what it waits
 * for and its Cancel, in the place of the row's Connect.
 */
export const ConnectPending = ({
  onCancel,
  className,
  cancelClassName,
}: {
  onCancel(): void;
  className?: string;
  /** The surface's own button size, matched to the Connect it stands in for. */
  cancelClassName?: string;
}) => {
  const { t } = useTranslation();
  return (
    <span
      data-slot="connect-pending"
      className={cn("flex shrink-0 items-center gap-1", className)}
    >
      <span
        role="status"
        className="text-muted-foreground flex items-center gap-2 text-[13px] leading-[18px] whitespace-nowrap"
      >
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-[var(--chat-status-attention)] motion-reduce:animate-none" />
        {t("phase5.waitingSignIn")}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className={cn("text-[13px]", cancelClassName)}
        onClick={onCancel}
      >
        {t("phase5.cancel")}
      </Button>
    </span>
  );
};

/** One step of a connect; numbered only when there is more than one. */
export const ConnectStep = ({
  index,
  done = false,
  title,
  children,
}: {
  index?: number;
  done?: boolean;
  title?: ReactNode;
  children?: ReactNode;
}) => (
  <li className="flex items-start gap-3">
    {index != null && (
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
          done
            ? "bg-[var(--chat-status-done)]/15 text-[var(--chat-status-done)]"
            : "bg-muted"
        )}
      >
        {done ? <CheckIcon className="size-3.5" /> : index}
      </span>
    )}
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      {title && <span className="font-medium">{title}</span>}
      {children}
    </div>
  </li>
);

/** The dialog's closing action: one large rounded button. */
export const CONNECT_PRIMARY = "h-12 rounded-full text-base";
/** A step's own action: small, rounded, secondary. */
export const CONNECT_ACTION = "self-start rounded-full";
