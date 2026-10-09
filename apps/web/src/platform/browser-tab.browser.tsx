import { ExternalLink, Globe, MonitorDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { FilePreview } from "#renderer/components/file-preview";
import type { BrowserTab as Native } from "#renderer/features/sessions/browser/browser-tab";
import { useSessionsTransport } from "#renderer/features/sessions/data/queries";
import {
  ABACUS_AGENT_URL,
  DESKTOP_DOWNLOAD_URL,
} from "#renderer/lib/abacus-links";
import { externalBrowserUrl } from "#renderer/lib/browser/external-browser-url";
import { useContextualUpsell } from "#renderer/lib/contextual-upsell";
import { creditsTier } from "#renderer/lib/credits";
import { platformSystem } from "#renderer/lib/platform-system";
import { sidebarAccount } from "#renderer/lib/sidebar-account";
import { openUpgrade } from "#renderer/lib/upgrade";
import { useAccount } from "#renderer/lib/use-account";
import { Button } from "#renderer/ui/button";

export const BrowserTab: typeof Native = ({ file, root, url, visible }) => {
  const { t } = useTranslation();
  const { client } = useSessionsTransport();
  const account = useAccount();
  const tier = creditsTier(account.data);
  const paid = sidebarAccount(account.data).paid;
  useContextualUpsell(!file && tier === "free" && visible === true);
  if (file)
    return (
      <FilePreview
        initialView="preview"
        path={file}
        hostRoot={root}
        read={{
          text: (filePath, hostRoot) =>
            client.files.readText({ filePath, hostRoot, maxBytes: 1000000 }),
          image: async (filePath, hostRoot) =>
            (await client.files.readImageAsDataUrl({ filePath, hostRoot }))
              .dataUrl,
          pptx: (filePath, hostRoot) =>
            client.files.readPptx({ filePath, hostRoot }),
        }}
      />
    );
  const externalUrl = externalBrowserUrl(url);
  return (
    <div role="status" className="flex h-full min-w-0 overflow-auto p-4">
      <div className="m-auto flex w-full max-w-sm flex-col items-center gap-4 py-2 text-center">
        <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-xl">
          <Globe className="size-6" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <h2 className="text-base font-medium">
            {t("web.files.browserTitle")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("web.files.browserUnavailable")}
          </p>
          {url && !externalUrl && (
            <p className="text-muted-foreground text-sm">
              {t("web.files.browserHostOnly")}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {tier === "free" && (
            <Button onClick={() => void openUpgrade(client)}>
              {t("web.files.browserUpgrade")}
            </Button>
          )}
          {paid && (
            <Button
              nativeButton={false}
              render={
                <a
                  href={ABACUS_AGENT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
              onClick={(event) => {
                event.preventDefault();
                void platformSystem(client).openExternal({
                  url: ABACUS_AGENT_URL,
                });
              }}
            >
              <ExternalLink aria-hidden="true" />
              {t("web.files.browserAgent")}
            </Button>
          )}
          <Button
            variant="outline"
            nativeButton={false}
            render={
              <a
                href={DESKTOP_DOWNLOAD_URL}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <MonitorDown aria-hidden="true" />
            {t("web.files.download")}
          </Button>
        </div>
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground text-xs underline underline-offset-4"
          >
            {t("phase5.openBrowser")}
          </a>
        )}
      </div>
    </div>
  );
};
