import { isShareableFile, type ShareEntry } from "@abacus-ai/contract/share";
import { Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAccount } from "#renderer/lib/use-account";
import { Button } from "#renderer/ui/button";

import { requestShare } from "./share-store";

/** The app can make public links here: the desktop app, on a server that takes them. */
export const useCanShare = (): boolean => {
  const account = useAccount();
  return IS_ELECTRON && account.data?.share_artifact === true;
};

/**
 * Share, labelled: an icon alone went unseen. Opens the shell's one share
 * dialog for `path`, counted by where it was pressed.
 */
export const ShareButton = ({
  path,
  from,
  className,
}: {
  path: string;
  from: ShareEntry;
  className?: string;
}) => {
  const { t } = useTranslation();
  return (
    <Button
      variant="outline"
      size="sm"
      data-slot="share-button"
      data-from={from}
      className={cn("shrink-0", className)}
      onClick={() => requestShare(path, from)}
    >
      <Link2 aria-hidden />
      {t("share.action")}
    </Button>
  );
};

const RowShare = ({ path }: { path: string }) =>
  useCanShare() ? (
    <ShareButton path={path} from="row" className="ml-0.5" />
  ) : null;

/** Share on a files card row, for a server that takes public links. */
export const ShareRowButton = ({ path }: { path: string }) =>
  isShareableFile(path) ? <RowShare path={path} /> : null;
