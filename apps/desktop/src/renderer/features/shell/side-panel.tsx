/**
 * The side panel (spec 01 §7.5, canvas `WidthRules`, `BW1000`): in layout at
 * ≥1100 (resizable, both sides min 360 px, width persisted debounced), below
 * that a non-modal 356 px drawer under the title bar over a shell-drawn scrim
 * that covers the content region only, so the title bar and the window
 * controls stay usable. Escape or the scrim closes it by clearing `tab`.
 */
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#renderer/components/empty-state";
import { cn } from "#renderer/lib/cn";
import {
  durations,
  easings,
  reducedTransition,
  useMotionPreference,
} from "#renderer/lib/motion";
import type { SidePanelTabId } from "#renderer/lib/navigation/search";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "#renderer/ui/drawer";
import { Tabs, TabsList, TabsTrigger } from "#renderer/ui/tabs";

import { SidePanelOutlet, useSidePanelFilled } from "./side-panel-slot";

export const PANEL_MIN_PX = 360;
export const PANE_MIN_PX = 360;
export const PANEL_DEFAULT_PX = 400;
export const PANEL_PREF_KEY = "side-panel";

/**
 * One tab's body: the route's `SidePanelContent` for it, portalled into the
 * outlet, or the placeholder when no mounted route fills it.
 */
export const SidePanelBody = ({ tab }: { tab: SidePanelTabId }) => {
  const { t } = useTranslation();
  const filled = useSidePanelFilled(tab);
  return (
    <>
      <SidePanelOutlet className={filled ? undefined : "hidden"} />
      {!filled && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <EmptyState
            title={t(`shell.panel.tabs.${tab}`)}
            description={t("shell.panel.emptyDescription")}
          />
        </div>
      )}
    </>
  );
};

/** The in-layout panel's frame (the pane's sibling in the resizable group). */
export const SidePanelFrame = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={t("shell.panel.label")}
      data-slot="side-panel"
      data-mode="layout"
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
          className="fixed inset-x-0 top-(--toolbar-h) bottom-0 z-40 bg-black/45 backdrop-blur-[2px]"
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
  tab,
  tabs,
  onTabChange,
  onClose,
}: {
  open: boolean;
  tab: SidePanelTabId | undefined;
  tabs: readonly SidePanelTabId[];
  onTabChange(tab: SidePanelTabId): void;
  onClose(): void;
}) => {
  const { t } = useTranslation();
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
          className={cn("bg-background")}
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>{t("shell.panel.label")}</DrawerTitle>
            <DrawerDescription>
              {tab == null ? "" : t(`shell.panel.tabs.${tab}`)}
            </DrawerDescription>
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            {tabs.length > 0 && tab != null && (
              <Tabs
                value={tab}
                onValueChange={(next) => onTabChange(next as SidePanelTabId)}
                data-side-panel-tabs=""
              >
                <TabsList aria-label={t("shell.topBar.panelTabs")}>
                  {tabs.map((item) => (
                    <TabsTrigger key={item} value={item} className="text-xs">
                      {t(`shell.panel.tabs.${item}`)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}
            {tab != null && <SidePanelBody tab={tab} />}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
};
