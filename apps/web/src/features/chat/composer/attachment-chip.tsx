import {
  isPastedText,
  pastedTextTitle,
} from "@abacus-ai/contract/transcript/user-text";
import { FileText, Folder, RotateCcw, ScanText } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { containmentRootFor } from "#renderer/components/file-preview/paths";
import { Spinner } from "#renderer/components/spinner";
import type { DraftAttachment } from "#renderer/lib/continuity/composer-drafts";
import {
  Attachment,
  AttachmentAction,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from "#renderer/ui/attachment";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "#renderer/ui/hover-card";

import type { ChatHostActions } from "../runtime/host-actions";
import { formatSize } from "./attachments";

export const AttachmentChip = ({
  attachment,
  host,
  root,
  onRemove,
  onRetry,
}: {
  attachment: DraftAttachment;
  host: ChatHostActions;
  root: string | null;
  onRemove(): void;
  onRetry(): void;
}) => {
  const { t } = useTranslation();
  const errorId = useId();
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState(attachment.preview);
  const [text, setText] = useState<string>();
  const isImage =
    attachment.mimeType?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|avif)$/i.test(attachment.name);
  const isText =
    attachment.mimeType?.startsWith("text/") ||
    /\.(txt|md|json|csv|log|tsx?|jsx?|py|css|html|ya?ml)$/i.test(
      attachment.name
    );
  const pasted = isPastedText(attachment.name);
  useEffect(() => {
    if (!attachment.path || attachment.state !== "done") return;
    const hostRoot = containmentRootFor(attachment.path, root);
    let active = true;
    if (isImage && !image)
      void host
        .readImage(attachment.path, hostRoot)
        .then((url) => {
          if (active) setImage(url);
        })
        .catch(() => {});
    // A paste is titled by its first line, so it is read without the hover.
    if ((open || pasted) && isText && text === undefined && host.readText)
      void host
        .readText(attachment.path, hostRoot)
        .then((value) => {
          if (active) setText(value.split("\n").slice(0, 8).join("\n"));
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [
    attachment.path,
    attachment.state,
    host,
    root,
    open,
    isImage,
    isText,
    image,
    text,
    pasted,
  ]);
  const pastedLabel = t("chat.composer.pastedText");
  const title = pasted
    ? pastedTextTitle(text ?? "") || pastedLabel
    : attachment.name;
  const details = pasted
    ? [pastedLabel, formatSize(attachment.size)].filter(Boolean).join(" · ")
    : attachment.kind === "folder"
      ? attachment.count == null
        ? ""
        : t("chat.composer.folderItems", { count: attachment.count })
      : formatSize(attachment.size);
  return (
    <Attachment
      size="chip"
      state={attachment.state}
      className={pasted ? "max-w-80 min-w-0" : "max-w-60 min-w-0"}
      data-slot="attachment-chip"
    >
      <HoverCard open={open} onOpenChange={setOpen}>
        <HoverCardTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 text-start outline-none"
              aria-label={title}
              aria-describedby={
                attachment.state === "error" ? errorId : undefined
              }
            />
          }
        >
          <AttachmentMedia variant={image ? "image" : "icon"}>
            {attachment.state === "uploading" ? (
              <Spinner aria-label={t("chat.composer.uploading")} />
            ) : image ? (
              <img src={image} alt="" className="size-full object-cover" />
            ) : pasted ? (
              <ScanText aria-hidden />
            ) : attachment.kind === "folder" || attachment.files ? (
              <Folder aria-hidden />
            ) : (
              <FileText aria-hidden />
            )}
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{title}</AttachmentTitle>
          </AttachmentContent>
          {details ? (
            <span className="text-muted-foreground shrink-0 text-[11px]">
              {details}
            </span>
          ) : null}
        </HoverCardTrigger>
        <HoverCardContent side="top" className="w-auto max-w-64">
          {image ? (
            <img
              src={image}
              alt={attachment.name}
              className="mb-2 max-h-60 max-w-60 rounded-md object-contain"
            />
          ) : null}
          <p className="max-w-60 truncate font-medium">{title}</p>
          {text ? (
            <pre className="mt-1 max-h-40 max-w-60 overflow-auto text-xs whitespace-pre-wrap">
              {text}
            </pre>
          ) : null}
          <p className="text-muted-foreground">{details}</p>
          {attachment.source ? (
            <p className="text-muted-foreground text-xs">
              {t(
                attachment.source === "computer"
                  ? "web.files.computer"
                  : "web.files.vm"
              )}
            </p>
          ) : null}
          {attachment.state === "uploading" ? (
            <progress
              className="h-1 w-full"
              value={attachment.progress ?? 0}
              max={100}
              aria-label={t("web.files.uploading")}
            />
          ) : null}
          {attachment.files ? (
            <details className="max-h-32 overflow-auto text-xs">
              <summary>
                {t("web.files.fileCount", { count: attachment.files.length })}
              </summary>
              {attachment.files.map((file) => (
                <div key={file.name} className="truncate" title={file.name}>
                  {file.name} · {formatSize(file.size)}
                </div>
              ))}
            </details>
          ) : null}
          {attachment.state === "error" ? (
            <p role="alert" className="text-destructive max-w-60">
              {attachment.error || t("chat.composer.attachFailed")}
            </p>
          ) : null}
        </HoverCardContent>
      </HoverCard>
      {attachment.state === "error" ? (
        <span id={errorId} className="sr-only">
          {attachment.error || t("chat.composer.attachFailed")}
        </span>
      ) : null}
      {attachment.state === "error" ? (
        <AttachmentAction
          aria-label={t("chat.composer.retryAttachment")}
          onClick={onRetry}
        >
          <RotateCcw />
        </AttachmentAction>
      ) : null}
      <AttachmentAction
        aria-label={t("chat.composer.removeAttachment")}
        onClick={onRemove}
      >
        ×
      </AttachmentAction>
    </Attachment>
  );
};
