import { isShareableFile } from "@abacus-ai/contract/share";
import { Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAccount } from "#renderer/lib/use-account";
import { Button } from "#renderer/ui/button";

import { requestShare } from "./share-store";

const ShareButton = ({ path }: { path: string }) => {
  const { t } = useTranslation();
  const account = useAccount();
  if (account.data?.share_artifact !== true) return null;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t("share.action")}
      title={t("share.action")}
      data-slot="deliverable-share"
      className="text-muted-foreground shrink-0"
      onClick={() => requestShare(path)}
    >
      <Share2 />
    </Button>
  );
};

/** Share on a files card row, for a server that takes public links. */
export const ShareRowButton = ({ path }: { path: string }) =>
  IS_ELECTRON && isShareableFile(path) ? <ShareButton path={path} /> : null;
