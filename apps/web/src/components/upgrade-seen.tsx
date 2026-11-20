import type { UpgradeSrc } from "@abacus-ai/contract/billing-plan";
import { useEffect } from "react";

import { upgradeSeen } from "#renderer/lib/upgrade";
import { useAppContext } from "#renderer/lib/use-app-context";

/**
 * Rendered beside an upgrade surface's Upgrade: reports it on screen once per
 * app run for the surface, or per `item` or `level` (lib/upgrade.ts upgradeSeen).
 */
export function UpgradeSeen({
  src,
  item,
  level,
}: {
  src: UpgradeSrc;
  item?: string;
  /** The credit level the surface shows (lib/upgrade.ts upgradeDetail). */
  level?: string;
}) {
  const { transport } = useAppContext();
  useEffect(() => {
    upgradeSeen(transport.client, src, item, level);
  }, [transport.client, src, item, level]);
  return null;
}
