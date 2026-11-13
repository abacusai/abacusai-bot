/** Each project's icon, on the first-run tiles and the start page's cards. */
import {
  ChartColumn,
  ClipboardList,
  Gamepad2,
  Joystick,
  LayoutTemplate,
  type LucideIcon,
  Mail,
  ShoppingBag,
  Store,
  UserSearch,
} from "lucide-react";

export const PROJECT_ICONS: Record<string, LucideIcon> = {
  "orders-system": ClipboardList,
  "business-site": Store,
  "lead-finder": UserSearch,
  "my-game": Gamepad2,
  "morning-inbox": Mail,
  "portfolio-site": LayoutTemplate,
  "numbers-dashboard": ChartColumn,
  "shop-page": ShoppingBag,
  "simple-game": Joystick,
};
