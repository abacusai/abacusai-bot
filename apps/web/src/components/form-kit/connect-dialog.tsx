import type { ComponentProps, ReactNode } from "react";

import { BootAvatar, type BootStage } from "#renderer/components/boot-avatar";
import type { AvatarMood } from "#renderer/lib/bots/avatar";
import { useMediaQuery } from "#renderer/lib/use-media-query";
import { Dialog, DialogContent } from "#renderer/ui/dialog";
import { Sheet, SheetContent } from "#renderer/ui/sheet";

export const ConnectDialog = ({
  label,
  children,
  dismissible = true,
  stage = "waiting",
  mood,
  ...props
}: Omit<ComponentProps<typeof Dialog>, "children"> & {
  label: string;
  children: ReactNode;
  dismissible?: boolean;
  stage?: BootStage;
  mood?: AvatarMood;
}) => {
  const phone = useMediaQuery("(max-width: 799px)");
  const content = (
    <div className="flex min-w-0 flex-col gap-3 text-left [&_[data-slot=button]]:text-[13px] [&_[data-slot=input]]:h-8">
      <BootAvatar
        stage={stage}
        mood={mood}
        size={48}
        brand={false}
        overlay
        locationKey={label}
      />
      {children}
    </div>
  );
  const root = {
    ...props,
    ...(!dismissible
      ? {
          disablePointerDismissal: true,
          onOpenChange: (
            _: boolean,
            details: Parameters<
              NonNullable<ComponentProps<typeof Dialog>["onOpenChange"]>
            >[1]
          ) => details.cancel(),
        }
      : {}),
  };
  return phone ? (
    <Sheet {...root}>
      <SheetContent
        aria-label={label}
        side="bottom"
        showCloseButton={dismissible}
        className="h-dvh max-h-dvh overflow-y-auto border-0 p-6"
      >
        {content}
      </SheetContent>
    </Sheet>
  ) : (
    <Dialog {...root}>
      <DialogContent
        aria-label={label}
        showCloseButton={dismissible}
        className="max-h-[calc(100dvh-3rem)] gap-3 overflow-y-auto p-6 sm:max-w-[440px]"
      >
        {content}
      </DialogContent>
    </Dialog>
  );
};
