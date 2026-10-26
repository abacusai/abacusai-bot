import type { AbacusReachability } from "@abacus-ai/contract/contract/system";
import { CloudOff, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "#renderer/components/spinner";
import { followNotices } from "#renderer/data/queries/notices";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

const ALL_WELL: AbacusReachability = { state: "ok", retryAt: null };

/**
 * Main's word on whether Abacus can be reached. It only says so once the
 * trouble has outlasted a blip, and says it is over on the first answer, so
 * this shows it as is.
 */
const useReachability = (): [
  AbacusReachability,
  (reach: AbacusReachability) => void,
] => {
  const { transport } = useAppContext();
  const [reach, setReach] = useState<AbacusReachability>(ALL_WELL);
  useEffect(() => {
    if (!IS_ELECTRON) return;
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) =>
        transport.client.system.connectivity.events({}, { signal }),
      setReach,
      abort.signal
    );
    return () => abort.abort();
  }, [transport]);
  return [reach, setReach];
};

/** The pane's "you're offline" / "can't reach Abacus" notice, with Try now. */
export const ConnectivityNotice = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const [reach, setReach] = useReachability();
  const [trying, setTrying] = useState(false);
  if (reach.state === "ok") return null;
  const offline = reach.state === "offline";
  const Icon = offline ? WifiOff : CloudOff;
  const tryNow = async (): Promise<void> => {
    setTrying(true);
    try {
      setReach(await transport.client.system.connectivity.retry({}));
    } catch {
      // The notice stays; the next answer from main replaces it.
    } finally {
      setTrying(false);
    }
  };
  return (
    <section
      data-slot="connectivity-notice"
      data-state={reach.state}
      className="mx-4 mt-3 mb-2 shrink-0"
      role="status"
      aria-live="polite"
    >
      <div className="bg-card border-border overflow-hidden rounded-xl border">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
          <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
          <div className="min-w-0 flex-1 basis-40">
            <p className="font-medium">
              {t(
                offline
                  ? "connectivity.offlineTitle"
                  : "connectivity.unreachableTitle"
              )}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("connectivity.detail")}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={trying}
            aria-busy={trying}
            onClick={() => void tryNow()}
          >
            {trying && <Spinner aria-hidden />}
            {t("connectivity.tryNow")}
          </Button>
        </div>
      </div>
    </section>
  );
};
