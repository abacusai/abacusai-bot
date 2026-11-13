import type { SitePack } from "@abacus-ai/contract/site-deploy";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";

import { SiteDeployCardView } from "./deploy-card";
import { DeployStepsView } from "./deploy-steps";

export const SITE_DEPLOY_GALLERY_STATES = [
  "idle",
  "ready",
  "held-back",
  "packing",
  "too-big",
  "too-broad",
  "keep-server",
  "keep-routine",
] as const;

export type SiteDeployGalleryState =
  (typeof SITE_DEPLOY_GALLERY_STATES)[number];

const READY: SitePack = {
  state: "ready",
  path: "/Users/you/.abacusai-bot/exports/bakery-site.zip",
  name: "bakery-site",
  files: 23,
  bytes: 1_240_000,
  leftOut: [".git", "node_modules"],
  heldBack: [],
};

/** The zip as each state of the gallery shows it. */
export const galleryPack = (state: SiteDeployGalleryState): SitePack | null =>
  state === "ready"
    ? READY
    : state === "held-back"
      ? { ...READY, heldBack: [".env", "config/secrets.json"] }
      : state === "packing" ||
          state === "idle" ||
          state === "keep-server" ||
          state === "keep-routine"
        ? null
        : state === "too-big"
          ? { state: "too-big", name: "bakery-site" }
          : { state: "too-broad" };

/** The deploy steps, fed a fixed zip; every button does nothing. */
export const GalleryDeploySteps = ({
  state,
  prompt,
}: {
  state: SiteDeployGalleryState;
  prompt?: string;
}) => (
  <DeployStepsView
    idle={state === "idle" || state === "keep-server"}
    prompt={prompt}
    pack={galleryPack(state)}
    progress={state === "packing" ? { files: 14, bytes: 640_000 } : null}
    copied={false}
    onOpenAgent={() => undefined}
    onPack={() => undefined}
    onReveal={() => undefined}
    onDragOut={() => undefined}
    onCopy={() => undefined}
    onCancel={() => undefined}
    onRetry={() => undefined}
  />
);

/** The paid card under a reply, in `state`: a site's, or "keep it running" for a server or a routine. */
export const SiteDeployCardGallery = ({
  state,
}: {
  state: SiteDeployGalleryState;
}) => {
  const { t } = useTranslation();
  const keep = state === "keep-server" || state === "keep-routine";
  return (
    <div className="max-w-2xl p-6">
      <SiteDeployCardView
        title={
          keep
            ? t("keepRunning.title", {
                name:
                  state === "keep-server" ? "btc-bot" : "Morning AI headlines",
              })
            : undefined
        }
        body={keep ? t("keepRunning.paidLine") : undefined}
        onClose={() => undefined}
      >
        {state === "keep-routine" ? (
          <div>
            <Button size="sm">
              {t("keepRunning.setUp")}
              <ArrowUpRight aria-hidden />
            </Button>
          </div>
        ) : (
          <GalleryDeploySteps
            state={state}
            prompt={
              state === "keep-server" ? t("keepRunning.prompt") : undefined
            }
          />
        )}
      </SiteDeployCardView>
    </div>
  );
};
