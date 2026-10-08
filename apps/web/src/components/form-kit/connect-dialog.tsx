import type { ComponentProps, ReactNode } from "react";

import { BootAvatar, type BootStage } from "#renderer/components/boot-avatar";
import type { AvatarMood } from "#renderer/lib/bots/avatar";
import { cn } from "#renderer/lib/cn";
import { useMediaQuery } from "#renderer/lib/use-media-query";
import { Dialog, DialogContent } from "#renderer/ui/dialog";
import { SheetContent } from "#renderer/ui/sheet";

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
    <div className="flex min-w-0 flex-col gap-3 text-left [&_[data-slot=button]]:text-[13px] [&_[data-slot=input]]:h-8">
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
