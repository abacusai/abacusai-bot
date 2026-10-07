/**
 * The side panel (spec 01 §7.5, canvas `WidthRules`, `BW1000`): in layout at
 * ≥1100 (resizable, both sides min 360 px, the panel up to `panelMaxFor`,
 * width persisted debounced), below that a non-modal 356 px drawer under
 * the title bar over a shell-drawn scrim that covers the content region
 * only, so the title bar and the window controls stay usable. Escape or the
 * scrim closes it; the strip's tabs stay in the store.
 */
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#renderer/components/empty-state";
import { TabsRail } from "#renderer/components/tabs-rail";
import { cn } from "#renderer/lib/cn";
import {
  durations,
  easings,
  reducedTransition,
  useMotionPreference,
} from "#renderer/lib/motion";
import { Button } from "#renderer/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "#renderer/ui/drawer";

import type { PanelTab, PanelTabKind } from "./panel-store";
import { SidePanelOutlet, useSidePanelFilled } from "./side-panel-slot";

export {
  PANEL_MIN_PX,
  PANEL_MAX_PX,
  PANE_MIN_PX,
  PANEL_DEFAULT_PX,
  panelMaxFor,
  clampPanelWidth,
} from "#renderer/lib/side-panel/geometry";

/** A tab's label: its own title, else its kind's name. */
export const usePanelTabTitle = () => {
  const { t } = useTranslation();
  return (tab: PanelTab): string =>
    tab.title?.trim() || t(`shell.panel.tabs.${tab.kind}`);
};

/**
 * The panel's body: the routes' `SidePanelContent` portals for the open
 * tabs, or the placeholder when no mounted route fills the active kind.
 */
export const SidePanelBody = ({
  tab,
  visible,
}: {
  tab: PanelTab | undefined;
  visible?: boolean;
}) => {
  const { t } = useTranslation();
  const filled = useSidePanelFilled(tab?.kind);
  return (
    <>
      <SidePanelOutlet
        tabId={tab?.id}
        visible={visible}
        className={filled ? undefined : "hidden"}
      />
      {!filled && tab != null && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <EmptyState
            title={t(`shell.panel.tabs.${tab.kind}`)}
            description={t("shell.panel.emptyDescription")}
          />
        </div>
      )}
    </>
  );
};

/** The in-layout panel's frame (the pane's sibling in the resizable group). */
export const SidePanelFrame = ({
  children,
  visible = true,
}: {
  children: ReactNode;
  visible?: boolean;
}) => {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={t("shell.panel.label")}
      data-slot={visible ? "side-panel" : undefined}
      data-mode={visible ? "layout" : "hidden"}
      className="bg-background flex size-full min-w-0 flex-col overflow-hidden rounded-(--pane-radius)"
    >
      {children}
    </aside>
  );
};

const SidePanelScrim = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose(): void;
}) => {
  const motionPref = useMotionPreference();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="scrim"
          data-slot="side-panel-scrim"
          aria-hidden="true"
          className="fixed inset-x-0 top-(--toolbar-h) bottom-0 z-40 bg-black/45"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={
            motionPref === "reduced"
              ? reducedTransition
              : { duration: durations.crossFade / 1000, ease: easings.standard }
          }
          onClick={onClose}
        />
      )}
    </AnimatePresence>
  );
};

export const SidePanelDrawer = ({
  open,
  tabs,
  active,
  onTabChange,
  onTabClose,
  onTabReorder,
  onReopen,
  kinds,
  onAdd,
  onClose,
}: {
  open: boolean;
  tabs: readonly PanelTab[];
  active: PanelTab | undefined;
  onTabChange(id: string): void;
  onTabClose(id: string): void;
  onTabReorder(ids: string[]): void;
  onReopen(): void;
  kinds: readonly PanelTabKind[];
  onAdd(kind: PanelTabKind): void;
  onClose(): void;
}) => {
  const { t } = useTranslation();
  const title = usePanelTabTitle();
  return (
    <>
      <SidePanelScrim open={open} onClose={onClose} />
      <Drawer
        open={open}
        modal={false}
        swipeDirection="right"
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DrawerContent
          data-side-panel=""
          aria-label={t("shell.panel.label")}
          className={cn("bg-background overflow-hidden")}
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>{t("shell.panel.label")}</DrawerTitle>
            <DrawerDescription>
              {active == null ? "" : title(active)}
            </DrawerDescription>
          </DrawerHeader>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-1 p-2">
              {tabs.length > 0 && active != null && (
                <TabsRail
                  tabs={tabs}
                  active={active.id}
                  title={title}
                  kinds={kinds}
                  onChange={onTabChange}
                  onClose={onTabClose}
                  onReopen={onReopen}
                  onAdd={onAdd}
                  onReorder={onTabReorder}
                />
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label={t("shell.topBar.closePanel")}
                onClick={onClose}
              >
                <X />
              </Button>
            </div>
            <SidePanelBody tab={active} visible={open} />
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
};
