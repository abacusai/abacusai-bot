/**
 * Share: the page exactly as it would go public, then its link. Nothing is
 * public until Create public link. One host in the shell serves every files
 * card and the Shared links list in the profile menu.
 */
import type {
  SharedLink,
  SharePreview,
  ShareRefusal,
} from "@abacus-ai/contract/share";
import { useStore } from "@tanstack/react-store";
import { Check, Copy, ExternalLink, Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { platformSystem } from "#renderer/lib/platform-system";
import { showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#renderer/ui/dialog";
import { Input } from "#renderer/ui/input";

import { closeShareDialog, shareDialogStore } from "./share-store";

type Step =
  | "share_opened"
  | "share_created"
  | "share_copied"
  | "share_link_opened"
  | "share_unshared"
  | "share_failed";

type Client = ReturnType<typeof useAppContext>["transport"]["client"];

const reportStep = (client: Client, step: Step, detail?: string): void => {
  client.system
    .funnelStep({ step, ...(detail != null ? { detail } : {}) })
    .catch(() => {});
};

const useShareActions = () => {
  const { client } = useAppContext().transport;
  return {
    client,
    funnel: (step: Step, detail?: string) => reportStep(client, step, detail),
  };
};

const LinkActions = ({
  link,
  onStopped,
}: {
  link: SharedLink;
  onStopped(): void;
}) => {
  const { t } = useTranslation();
  const { client, funnel } = useShareActions();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col gap-2" data-slot="share-link">
      <div className="flex gap-2">
        <Input
          readOnly
          aria-label={t("share.linkLabel")}
          value={link.url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          data-slot="share-copy"
          onClick={async () => {
            await navigator.clipboard.writeText(link.url);
            setCopied(true);
            funnel("share_copied");
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {t(copied ? "share.copied" : "share.copy")}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          data-slot="share-open"
          onClick={() => {
            funnel("share_link_opened");
            void platformSystem(client).openExternal({ url: link.url });
          }}
        >
          <ExternalLink aria-hidden />
          {t("share.open")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-slot="share-stop"
          className="text-destructive"
          onClick={() => setConfirming(true)}
        >
          {t("share.stop")}
        </Button>
      </div>
      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title={t("share.stopTitle")}
        description={t("share.stopBody")}
        label={t("share.stop")}
        onConfirm={async () => {
          const { ok } = await client.shares.remove({ shareId: link.shareId });
          if (!ok) {
            showInfo(t("share.errors.FAILED"));
            return;
          }
          funnel("share_unshared");
          showInfo(t("share.stopped"));
          onStopped();
        }}
      />
    </div>
  );
};

const FileShare = ({ path }: { path: string }) => {
  const { t, i18n } = useTranslation();
  const { client, funnel } = useShareActions();
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [link, setLink] = useState<SharedLink | null>(null);
  const [failure, setFailure] = useState<ShareRefusal | null>(null);
  const [creating, setCreating] = useState(false);
  const lang = i18n.language;

  useEffect(() => {
    let live = true;
    reportStep(client, "share_opened");
    client.shares
      .preview({ path, lang })
      .catch((): SharePreview => ({ ok: false, code: "FAILED" }))
      .then((result) => {
        if (!live) return;
        setPreview(result);
        if (result.ok === false) {
          setFailure(result.code);
          reportStep(client, "share_failed", result.code);
        } else if (result.existing != null) setLink(result.existing);
      });
    return () => {
      live = false;
    };
  }, [client, lang, path]);

  const create = async () => {
    setCreating(true);
    setFailure(null);
    const result = await client.shares
      .create({ path, lang })
      .catch(() => ({ ok: false as const, code: "FAILED" as const }));
    setCreating(false);
    if (result.ok === false) {
      setFailure(result.code);
      funnel("share_failed", result.code);
      return;
    }
    setLink(result.link);
    funnel("share_created");
  };

  const title = preview?.ok === true ? preview.title : "";
  if (link != null)
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("share.ready")}</DialogTitle>
          <DialogDescription>{t("share.notice")}</DialogDescription>
        </DialogHeader>
        <LinkActions link={link} onStopped={closeShareDialog} />
        {link.canExpire && (
          <p className="text-muted-foreground text-xs">{t("share.expires")}</p>
        )}
      </>
    );
  return (
    <>
      <DialogHeader>
        <DialogTitle className="truncate">
          {title === "" ? t("share.action") : t("share.title", { title })}
        </DialogTitle>
        <DialogDescription>{t("share.notice")}</DialogDescription>
      </DialogHeader>
      {preview == null && (
        <div
          className="bg-muted text-muted-foreground flex h-80 items-center justify-center rounded-lg text-sm"
          data-slot="share-loading"
        >
          {t("share.preparing")}
        </div>
      )}
      {preview?.ok === true && (
        <iframe
          // No script, no navigation: the page cannot act inside the app.
          sandbox=""
          title={t("share.previewLabel")}
          srcDoc={preview.document}
          data-slot="share-preview"
          className="h-80 w-full rounded-lg border bg-white"
        />
      )}
      {failure != null && (
        <p
          role="alert"
          className="text-destructive text-sm"
          data-slot="share-error"
        >
          {t(`share.errors.${failure}`)}
        </p>
      )}
      <p className="text-muted-foreground text-xs">{t("share.cleaned")}</p>
      <DialogFooter>
        <Button variant="ghost" onClick={closeShareDialog}>
          {t("share.cancel")}
        </Button>
        <Button
          data-slot="share-create"
          disabled={preview?.ok !== true || creating}
          onClick={() => void create()}
        >
          <Link2 aria-hidden />
          {t(creating ? "share.creating" : "share.create")}
        </Button>
      </DialogFooter>
    </>
  );
};

const SharedLinks = () => {
  const { t } = useTranslation();
  const { client } = useShareActions();
  const [links, setLinks] = useState<SharedLink[] | null | undefined>();
  useEffect(() => {
    let live = true;
    client.shares
      .list({})
      .catch(() => null)
      .then((result) => {
        if (live) setLinks(result);
      });
    return () => {
      live = false;
    };
  }, [client]);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("share.links")}</DialogTitle>
        <DialogDescription>{t("share.notice")}</DialogDescription>
      </DialogHeader>
      {links === null && (
        <p role="alert" className="text-destructive text-sm">
          {t("share.errors.FAILED")}
        </p>
      )}
      {links?.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("share.linksEmpty")}</p>
      )}
      <ul className="flex max-h-96 flex-col gap-4 overflow-y-auto">
        {links?.map((link) => (
          <li key={link.shareId} className="flex flex-col gap-1">
            <span className="truncate text-sm font-medium">{link.title}</span>
            <LinkActions
              link={link}
              onStopped={() =>
                setLinks((rows) =>
                  rows?.filter((row) => row.shareId !== link.shareId)
                )
              }
            />
          </li>
        ))}
      </ul>
    </>
  );
};

export const ShareDialogHost = () => {
  const request = useStore(shareDialogStore, (state) => state);
  return (
    <Dialog
      open={request != null}
      onOpenChange={(open) => {
        if (!open) closeShareDialog();
      }}
    >
      <DialogContent className="sm:max-w-lg" data-slot="share-dialog">
        {request?.kind === "file" && (
          <FileShare key={request.path} path={request.path} />
        )}
        {request?.kind === "links" && <SharedLinks />}
      </DialogContent>
    </Dialog>
  );
};
