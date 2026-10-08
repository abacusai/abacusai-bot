import { createContext, useContext, type ReactNode } from "react";

export const MIN_TITLE_RAIL_WIDTH = 240;

export type TabsRailPlacement = "titlebar" | "panel" | "none";

export const tabsRailPlacement = ({
  available,
  floating,
  phone,
  titleWidth,
}: {
  available: boolean;
  floating: boolean;
  phone: boolean;
  titleWidth: number;
}): TabsRailPlacement =>
  !available
    ? "none"
    : floating && (phone || titleWidth < MIN_TITLE_RAIL_WIDTH)
      ? "panel"
      : "titlebar";

const PlacementContext = createContext<{
  placement: TabsRailPlacement;
  reportWidth?: (width: number) => void;
}>({ placement: "titlebar" });

export const TabsRailPlacementProvider = ({
  placement,
  reportWidth,
  children,
}: {
  placement: TabsRailPlacement;
  reportWidth: (width: number) => void;
  children: ReactNode;
}) => (
  <PlacementContext value={{ placement, reportWidth }}>
    {children}
  </PlacementContext>
);

export const useTabsRailPlacement = () =>
  useContext(PlacementContext).placement;
export const useTabsRailWidthReporter = () =>
  useContext(PlacementContext).reportWidth;
