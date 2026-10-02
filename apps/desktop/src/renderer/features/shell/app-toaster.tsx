import { useEffect, type ReactNode } from "react";
/**
 * The app's toast region (spec 01 §7.4): the registry toast atoms, with the
 * viewport placed under the title bar from `useTitlebarArea()` (toolbar
 * height + 10, clear of the caption buttons), so a toast never sits under
 * the window controls. Records that it mounted: a message sent before that
 * (the port lost during boot) has nowhere to show and goes to a static
 * screen instead.
 */
import { useTranslation } from "react-i18next";

import { useTitlebarArea } from "#renderer/lib/window-chrome/use-titlebar-area";
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  toast,
  useToastManager,
} from "#renderer/ui/toast";

const MOUNTED = Symbol.for("abacus.toasterMounted");
type MountedGlobal = { [MOUNTED]?: number };

/** A Toaster is mounted in this document now. */
export const isToasterMounted = (): boolean =>
  ((globalThis as MountedGlobal)[MOUNTED] ?? 0) > 0;

/** Gap between the title bar and the first toast, px. */
const TOAST_OFFSET_PX = 10;

/** Where the viewport sits, from the title-bar geometry. */
export const toastViewportStyle = (area: {
  height: number;
  end: number;
}): { top: string; right: string; bottom: string } => ({
  top: `${area.height + TOAST_OFFSET_PX}px`,
  right: `${Math.max(area.end, 16)}px`,
  bottom: "auto",
});

const ToastList = () => {
  const { toasts } = useToastManager();
  const { t } = useTranslation();
  return toasts.map((item) => (
    <Toast key={item.id} toast={item}>
      <ToastContent>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <ToastTitle />
          <ToastDescription />
        </div>
        <ToastAction />
        <ToastClose aria-label={t("common.close")} />
      </ToastContent>
    </Toast>
  ));
};

export const AppToaster = ({
  toolbarHeight,
  children,
}: {
  toolbarHeight: number;
  children: ReactNode;
}) => {
  const area = useTitlebarArea(toolbarHeight);
  useEffect(() => {
    const store = globalThis as MountedGlobal;
    store[MOUNTED] = (store[MOUNTED] ?? 0) + 1;
    return () => {
      store[MOUNTED] = (store[MOUNTED] ?? 1) - 1;
    };
  }, []);
  return (
    <ToastProvider toastManager={toast} limit={3}>
      {children}
      <ToastPortal>
        <ToastViewport
          data-testid="toast-viewport"
          style={toastViewportStyle(area)}
        >
          <ToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
};
