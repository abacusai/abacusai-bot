import { useTranslation } from "react-i18next";

import { FilePreview } from "#renderer/components/file-preview";
import type { BrowserTab as Native } from "#renderer/features/sessions/browser/browser-tab";
import { useSessionsTransport } from "#renderer/features/sessions/data/queries";
import { Button } from "#renderer/ui/button";

export const BrowserTab: typeof Native = ({ file, root, url }) => {
  const { t } = useTranslation();
  const { client } = useSessionsTransport();
  if (file)
    return (
      <FilePreview
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
  return (
    <div
      role="status"
      className="text-muted-foreground flex flex-col items-start gap-2 p-4 text-sm"
    >
      <p>{t("web.files.browserUnavailable")}</p>
      {url && (
        <Button
          onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
        >
          {t("phase5.openBrowser")}
        </Button>
      )}
    </div>
  );
};
