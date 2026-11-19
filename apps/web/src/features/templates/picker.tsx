/**
 * The templates gallery: every deck template and document look the tools can
 * print, as thumbnails. Picking one drops an ask naming it into the composer,
 * on the new-chat screen (a dialog) or from Library (a page that opens a new
 * chat with the ask in its box).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#renderer/ui/dialog";

import { TEMPLATES, type TemplateEntry, type TemplateKind } from "./catalogue";

const Card = ({
  entry,
  onPick,
}: {
  entry: TemplateEntry;
  onPick: (entry: TemplateEntry) => void;
}) => {
  const { t } = useTranslation();
  const [cover, ...slides] = entry.images;
  return (
    <button
      type="button"
      data-slot="template-card"
      data-template={entry.id}
      onClick={() => onPick(entry)}
      className="group hover:bg-foreground/[0.04] focus-visible:ring-ring flex flex-col gap-2 rounded-xl p-2 text-start outline-none focus-visible:ring-2"
    >
      <span
        className={cn(
          "ring-foreground/10 block overflow-hidden rounded-lg bg-white ring-1 transition-transform group-hover:-translate-y-0.5",
          entry.shape === "slide"
            ? "aspect-video"
            : entry.shape === "sheet"
              ? "aspect-[297/210]"
              : "aspect-[210/297]"
        )}
      >
        <img
          src={cover}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      </span>
      {slides.length > 0 && (
        <span className="grid grid-cols-2 gap-1.5">
          {slides.map((src) => (
            <span
              key={src}
              className="ring-foreground/10 block aspect-video overflow-hidden rounded-md bg-white ring-1"
            >
              <img
                src={src}
                alt=""
                loading="lazy"
                className="size-full object-cover"
              />
            </span>
          ))}
        </span>
      )}
      <span className="flex flex-col gap-0.5 px-0.5">
        <span className="text-sm font-medium">{entry.name}</span>
        {entry.kind === "deck" && (
          <span className="text-muted-foreground line-clamp-2 text-xs">
            {t(`templates.items.${entry.id}`)}
          </span>
        )}
      </span>
    </button>
  );
};

const Grid = ({
  kind,
  entries,
  onPick,
}: {
  kind: TemplateKind;
  entries: readonly TemplateEntry[];
  onPick: (entry: TemplateEntry) => void;
}) => (
  <div
    data-slot="templates-grid"
    className={cn(
      "grid gap-2",
      kind === "deck"
        ? "grid-cols-[repeat(auto-fill,minmax(220px,1fr))]"
        : "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]"
    )}
  >
    {entries.map((entry) => (
      <Card key={entry.id} entry={entry} onPick={onPick} />
    ))}
  </div>
);

/** Decks in one grid; documents grouped by type (CV, invoice, …). */
export const TemplatesGrid = ({
  kind,
  onPick,
}: {
  kind: TemplateKind;
  onPick: (entry: TemplateEntry) => void;
}) => {
  const { t } = useTranslation();
  const entries = TEMPLATES.filter((entry) => entry.kind === kind);
  if (kind === "deck")
    return <Grid kind={kind} entries={entries} onPick={onPick} />;
  const groups = [...new Set(entries.map((entry) => entry.group ?? ""))];
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group} className="flex flex-col gap-1">
          <h3 className="text-muted-foreground text-xs font-medium uppercase">
            {t(`templates.types.${group}`)}
          </h3>
          <Grid
            kind={kind}
            entries={entries.filter((entry) => (entry.group ?? "") === group)}
            onPick={onPick}
          />
        </section>
      ))}
    </div>
  );
};

/** On the new-chat screen: pick, and the ask lands in the box. */
export const TemplatesDialog = ({
  kind,
  onOpenChange,
  onPick,
}: {
  kind: TemplateKind | null;
  onOpenChange: (open: boolean) => void;
  onPick: (ask: string) => void;
}) => {
  const { t } = useTranslation();
  return (
    <Dialog open={kind != null} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="templates-dialog"
        className="max-h-[85vh] overflow-y-auto sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle className="text-base">
            {t(
              kind === "document"
                ? "templates.documentsTitle"
                : "templates.decksTitle"
            )}
          </DialogTitle>
          <DialogDescription>{t("templates.pickHint")}</DialogDescription>
        </DialogHeader>
        {kind != null && (
          <TemplatesGrid
            kind={kind}
            onPick={(entry) => {
              onPick(entry.ask);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

/** The two ways in on the new-chat screen. */
export const TemplateButtons = ({
  onOpen,
  disabled,
}: {
  onOpen: (kind: TemplateKind) => void;
  disabled?: boolean;
}) => {
  const { t } = useTranslation();
  return (
    <div data-slot="template-buttons" className="flex flex-wrap gap-2">
      {(["deck", "document"] as const).map((kind) => (
        <Button
          key={kind}
          size="sm"
          variant="secondary"
          aria-disabled={disabled}
          onClick={() => {
            if (disabled !== true) onOpen(kind);
          }}
        >
          {t(kind === "deck" ? "templates.makeDeck" : "templates.makeDocument")}
        </Button>
      ))}
    </div>
  );
};

/** Library: every design, each opening a new chat with its ask. */
export const TemplatesPage = () => {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const open = (entry: TemplateEntry) =>
    void navigate({
      to: "/sessions/new",
      // A fresh draft per pick: `offer` is what keeps one from being reused.
      search: {
        prompt: entry.ask,
        offer: `template-${entry.id}-${Date.now()}`,
      },
      transition: "nav-forward",
    });
  return (
    <div
      data-slot="templates-page"
      className="mx-auto flex w-full max-w-5xl flex-col gap-6 overflow-y-auto px-6 py-6"
    >
      <p className="text-muted-foreground text-sm">{t("templates.pageHint")}</p>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">{t("templates.decksTitle")}</h2>
        <TemplatesGrid kind="deck" onPick={open} />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">{t("templates.documentsTitle")}</h2>
        <TemplatesGrid kind="document" onPick={open} />
      </section>
    </div>
  );
};

/** The start page's "Make a deck" / "Make a document" buttons and their gallery. */
export const TemplatesStarter = ({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (ask: string) => void;
}) => {
  const [gallery, setGallery] = useState<TemplateKind | null>(null);
  return (
    <>
      <div className="phone:px-5 mt-3">
        <TemplateButtons disabled={disabled} onOpen={setGallery} />
      </div>
      <TemplatesDialog
        kind={gallery}
        onOpenChange={(open) => {
          if (!open) setGallery(null);
        }}
        onPick={onPick}
      />
    </>
  );
};
