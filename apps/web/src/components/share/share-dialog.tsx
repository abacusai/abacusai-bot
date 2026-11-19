/**
 * Share: the page exactly as it would go public, then its link. Nothing is
 * public until Create public link. One host in the shell serves every files
 * card and the Shared links list in the profile menu.
 */
import {
  ARTIFACT_ACCESS,
  isLivePage,
  type ArtifactAccess,
  type LivePage,
  type PagePreview,
  type SharedLink,
  type ShareEntry,
  type SharePreview,
  type ShareRefusal,
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

import { closeShareDialog, markLinked, shareDialogStore } from "./share-store";

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
  url,
  stop,
  onStopped,
}: {
  url: string;
  /** Takes the link down; false when the platform did not. */
  stop(): Promise<boolean>;
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
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          data-slot="share-copy"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
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
            void platformSystem(client).openExternal({ url });
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
          const ok = await stop().catch(() => false);
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

/** A web page runs live, so it goes through the page itself, not a static copy. */
const ArtifactShare = ({ path, from }: { path: string; from: ShareEntry }) => {
  const { t } = useTranslation();
  const { client, funnel } = useShareActions();
  // Share is for sending, so a new link opens for anyone; a page already shared keeps its own setting.
  const [access, setAccess] = useState<ArtifactAccess>("public");
  const [page, setPage] = useState<LivePage | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ShareRefusal | null>(null);
  const [preview, setPreview] = useState<PagePreview | null>(null);
  useEffect(() => {
    let live = true;
    reportStep(client, "share_opened", from);
    client.shares
      .previewPage({ path })
      .catch((): PagePreview => ({ ok: false, code: "FAILED" }))
      .then((result) => {
        if (!live) return;
        setPreview(result);
        if (result.ok === false) {
          setFailure(result.code);
          reportStep(client, "share_failed", result.code);
        }
      });
    client.shares
      .page({ path })
      .catch(() => null)
      .then((found) => {
        if (!live) return;
        setPage(found);
        if (found != null) {
          setAccess(found.access);
          markLinked(path);
        }
      });
    return () => {
      live = false;
    };
  }, [client, from, path]);
  const publish = async () => {
    setBusy(true);
    setFailure(null);
    const result = await client.shares
      .publishArtifact({ path, access })
      .catch(() => ({ ok: false as const, code: "FAILED" as const }));
    setBusy(false);
    if (result.ok === false) {
      setFailure(result.code);
      funnel("share_failed", result.code);
      return;
    }
    setPage({
      identifier: result.identifier,
      title: page?.title ?? "",
      url: result.url,
      access: result.access,
      updatedAt: new Date().toISOString(),
    });
    markLinked(path);
    funnel("share_created");
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t(page == null ? "share.artifact.title" : "share.ready")}
        </DialogTitle>
        <DialogDescription>{t("share.artifact.body")}</DialogDescription>
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
          // Scripts run so buttons work as they will on the link; no same-origin, forms or navigation.
          sandbox="allow-scripts"
          title={t("share.previewLabel")}
          srcDoc={preview.document}
          data-slot="share-preview"
          className="h-80 w-full rounded-lg border bg-white"
        />
      )}
      <div role="radiogroup" className="flex flex-col gap-2">
        {ARTIFACT_ACCESS.map((option) => (
          <label
            key={option}
            className="flex items-start gap-2 rounded-lg border p-3 text-sm"
          >
            <input
              type="radio"
              name="artifact-access"
              checked={access === option}
              onChange={() => setAccess(option)}
            />
            <span>
              {t(
                option === "private"
                  ? "share.artifact.private"
                  : "share.artifact.public"
              )}
              <span className="text-muted-foreground block text-xs">
                {t(
                  option === "private"
                    ? "share.artifact.privateHint"
                    : "share.artifact.publicHint"
                )}
              </span>
            </span>
          </label>
        ))}
      </div>
      {page != null && (
        <LinkActions
          url={page.url}
          stop={async () =>
            (
              await client.shares.unpublishArtifact({
                identifier: page.identifier,
              })
            ).ok
          }
          onStopped={closeShareDialog}
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
      <DialogFooter>
        <Button variant="ghost" onClick={closeShareDialog}>
          {t("share.cancel")}
        </Button>
        <Button
          data-slot="share-create"
          disabled={busy || page === undefined || preview?.ok !== true}
          onClick={() => void publish()}
        >
          <Link2 aria-hidden />
          {t(page == null ? "share.artifact.publish" : "share.artifact.update")}
        </Button>
      </DialogFooter>
    </>
  );
};

const FileShare = ({ path, from }: { path: string; from: ShareEntry }) => {
  const { t, i18n } = useTranslation();
  const { client, funnel } = useShareActions();
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [link, setLink] = useState<SharedLink | null>(null);
  const [failure, setFailure] = useState<ShareRefusal | null>(null);
  const [creating, setCreating] = useState(false);
  const lang = i18n.language;

  useEffect(() => {
    let live = true;
    reportStep(client, "share_opened", from);
    client.shares
      .preview({ path, lang })
      .catch((): SharePreview => ({ ok: false, code: "FAILED" }))
      .then((result) => {
        if (!live) return;
        setPreview(result);
        if (result.ok === false) {
          setFailure(result.code);
          reportStep(client, "share_failed", result.code);
        } else if (result.existing != null) {
          setLink(result.existing);
          markLinked(path);
        }
      });
    return () => {
      live = false;
    };
  }, [client, from, lang, path]);

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
    markLinked(path);
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
        <LinkActions
          url={link.url}
          stop={async () =>
            (await client.shares.remove({ shareId: link.shareId })).ok
          }
          onStopped={closeShareDialog}
        />
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

/** One row of Shared links: a file's still copy, or a live page. */
type SharedRow =
  | { kind: "file"; key: string; title: string; at: string; link: SharedLink }
  | { kind: "page"; key: string; title: string; at: string; page: LivePage };

const SharedLinks = () => {
  const { t } = useTranslation();
  const { client } = useShareActions();
  const [rows, setRows] = useState<SharedRow[] | null | undefined>();
  useEffect(() => {
    let live = true;
    Promise.all([
      client.shares.list({}).catch(() => null),
      client.shares.pages({}).catch(() => null),
    ]).then(([links, pages]) => {
      if (!live) return;
      if (links == null && pages == null) {
        setRows(null);
        return;
      }
      const merged: SharedRow[] = [
        ...(links ?? []).map((link) => ({
          kind: "file" as const,
          key: `file:${link.shareId}`,
          title: link.title,
          at: link.createdAt,
          link,
        })),
        ...(pages ?? []).map((page) => ({
          kind: "page" as const,
          key: `page:${page.identifier}`,
          title: page.title,
          at: page.updatedAt,
          page,
        })),
      ];
      setRows(merged.sort((a, b) => b.at.localeCompare(a.at)));
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
      {rows === null && (
        <p role="alert" className="text-destructive text-sm">
          {t("share.errors.FAILED")}
        </p>
      )}
      {rows?.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("share.linksEmpty")}</p>
      )}
      <ul className="flex max-h-96 flex-col gap-4 overflow-y-auto">
        {rows?.map((row) => (
          <li key={row.key} className="flex flex-col gap-1">
            <span className="truncate text-sm font-medium">{row.title}</span>
            <LinkActions
              url={row.kind === "file" ? row.link.url : row.page.url}
              stop={async () =>
                row.kind === "file"
                  ? (await client.shares.remove({ shareId: row.link.shareId }))
                      .ok
                  : (
                      await client.shares.unpublishArtifact({
                        identifier: row.page.identifier,
                      })
                    ).ok
              }
              onStopped={() =>
                setRows((current) =>
                  current?.filter((item) => item.key !== row.key)
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
        {request?.kind === "file" &&
          (isLivePage(request.path) ? (
            <ArtifactShare
              key={request.path}
              path={request.path}
              from={request.from}
            />
          ) : (
            <FileShare
              key={request.path}
              path={request.path}
              from={request.from}
            />
          ))}
        {request?.kind === "links" && <SharedLinks />}
      </DialogContent>
    </Dialog>
  );
};
