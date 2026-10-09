import { Globe, MonitorDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { FilePreview } from "#renderer/components/file-preview";
import type { BrowserTab as Native } from "#renderer/features/sessions/browser/browser-tab";
import { useSessionsTransport } from "#renderer/features/sessions/data/queries";
import { DESKTOP_DOWNLOAD_URL } from "#renderer/lib/abacus-links";
import { externalBrowserUrl } from "#renderer/lib/browser/external-browser-url";
import { Button } from "#renderer/ui/button";

export const BrowserTab: typeof Native = ({ file, root, url }) => {
  const { t } = useTranslation();
  const { client } = useSessionsTransport();
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
    <div role="status" className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
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
          <Button
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
            {t("web.connect.download")}
          </Button>
          {externalUrl && (
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <a
                  href={externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              {t("phase5.openBrowser")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
