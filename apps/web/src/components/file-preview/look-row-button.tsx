/**
 * "Try another look" on a document row of a files card: the same document
 * printed again in another of the design system's looks, in seconds and with
 * no model call (docs-system/relook.ts). Only a document the document tool
 * made has the source to do it; for anything else the host says so.
 */
import { Palette } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { IS_ELECTRON } from "#renderer/lib/platform";
import { showError, showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";

import { type RowSend, useRowSend } from "./row-send";

const LOOKS = [
  "classic",
  "editorial",
  "bold",
  "minimal",
  "warm",
  "midnight",
] as const;

const LookMenu = ({ path }: { path: string }) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const [busy, setBusy] = useState(false);
  // The designs of this document's type, asked for when the menu opens.
  const [designs, setDesigns] = useState<Array<{ id: string; name: string }>>(
    []
  );
  const reprint = (
    change: { look?: (typeof LOOKS)[number]; design?: string },
    name: string
  ) => {
    setBusy(true);
    void transport.client.files
      .relook({ path, ...change })
      .then(() => showInfo(t("templates.lookDone", { look: name })))
      .catch((error: unknown) =>
        showError(
          error instanceof Error && error.message
            ? error.message
            : t("templates.lookFailed")
        )
      )
      .finally(() => setBusy(false));
  };
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open)
          void transport.client.files
            .designs({ path })
            .then((found) => setDesigns(found.designs))
            .catch(() => setDesigns([]));
      }}
    >
      <DropdownMenuTrigger
        aria-label={t("templates.tryLook")}
        title={t("templates.tryLook")}
        data-slot="deliverable-look"
        disabled={busy}
        className="text-muted-foreground hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md"
      >
        <Palette aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-fit min-w-40">
        {designs.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("templates.designs")}</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() =>
                reprint({ design: "classic" }, t("templates.classicDesign"))
              }
            >
              {t("templates.classicDesign")}
            </DropdownMenuItem>
            {designs.map((design) => (
              <DropdownMenuItem
                key={design.id}
                onClick={() => reprint({ design: design.id }, design.name)}
              >
                {design.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("templates.tryLook")}</DropdownMenuLabel>
          {LOOKS.map((look) => (
            <DropdownMenuItem
              key={look}
              onClick={() => reprint({ look }, t(`templates.looks.${look}`))}
            >
              {t(`templates.looks.${look}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * A deck's look is its template: the same content filled into another one.
 * That is one model call, so the pick is sent as the user's message and the
 * bot calls ppt with the template (packages/agent deck-tool.ts).
 */
const DECK_LOOKS = [
  ["emerald-editorial", "Emerald Editorial"],
  ["broadside", "Broadside"],
  ["grove", "Grove"],
  ["studio", "Studio"],
  ["pink-script", "Pink Script"],
  ["stencil-tablet", "Stencil Tablet"],
  ["vellum", "Vellum"],
  ["classroom", "Classroom"],
] as const;

const DeckLookMenu = ({ sendAsUser }: { sendAsUser: RowSend }) => {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("templates.tryLook")}
        title={t("templates.tryLook")}
        data-slot="deliverable-deck-look"
        disabled={sent}
        className="text-muted-foreground hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md"
      >
        <Palette aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-fit min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("templates.tryLook")}</DropdownMenuLabel>
          {DECK_LOOKS.map(([slug, name]) => (
            <DropdownMenuItem
              key={slug}
              onClick={() =>
                sendAsUser(
                  `Make this same deck again in the ${slug} template: the same content, a new look.`,
                  {
                    accepted: () => setSent(true),
                    failed: () => setSent(false),
                  }
                )
              }
            >
              {name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Only inside a chat, where a pick can be sent. */
const DeckLookButton = () => {
  const send = useRowSend();
  return send == null ? null : <DeckLookMenu sendAsUser={send} />;
};

/** On a document's PDF or Word row, or a deck's PowerPoint row, in the desktop app. */
export const LookRowButton = ({ path }: { path: string }) =>
  !IS_ELECTRON ? null : /\.pptx$/i.test(path) ? (
    <DeckLookButton />
  ) : /\.(pdf|docx)$/i.test(path) ? (
    <LookMenu path={path} />
  ) : null;
