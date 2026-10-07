/**
 * A masked pop-up route's sheet (spec 01 §6.6): open while the route is
 * matched; Escape and the close button go `history.back()`, or to the mask
 * target when the pop-up was the first entry (a deep link).
 */
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { FileRoutesByTo } from "#renderer/routeTree.gen";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#renderer/ui/sheet";

export interface RouteSheetProps {
  title: string;
  description?: string;
  /** Where to go when there is no history entry to go back to. */
  fallbackTo: Extract<
    keyof FileRoutesByTo,
    "/routines" | "/bots/new" | "/sessions/new"
  >;
  children?: ReactNode;
}

export const RouteSheet = ({
  title,
  description,
  fallbackTo,
  children,
}: RouteSheetProps) => {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const close = (): void => {
    if (canGoBack) router.history.back();
    else void router.navigate({ to: fallbackTo, replace: true });
  };
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent side="right" data-testid="route-sheet">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description != null && (
            <SheetDescription>{description}</SheetDescription>
          )}
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
};
