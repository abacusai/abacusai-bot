import type { SitePack } from "@abacus-ai/contract/site-deploy";

import { SiteDeployCardView } from "./deploy-card";
import { DeployStepsView } from "./deploy-steps";

export const SITE_DEPLOY_GALLERY_STATES = [
  "idle",
  "ready",
  "held-back",
  "packing",
  "too-big",
  "too-broad",
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
      : state === "packing" || state === "idle"
        ? null
        : state === "too-big"
          ? { state: "too-big", name: "bakery-site" }
          : { state: "too-broad" };

/** The deploy steps, fed a fixed zip; every button does nothing. */
export const GalleryDeploySteps = ({
  state,
}: {
  state: SiteDeployGalleryState;
}) => (
  <DeployStepsView
    idle={state === "idle"}
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

/** The paid site card under a reply, in `state`. */
export const SiteDeployCardGallery = ({
  state,
}: {
  state: SiteDeployGalleryState;
}) => (
  <div className="max-w-2xl p-6">
    <SiteDeployCardView onClose={() => undefined}>
      <GalleryDeploySteps state={state} />
    </SiteDeployCardView>
  </div>
);
