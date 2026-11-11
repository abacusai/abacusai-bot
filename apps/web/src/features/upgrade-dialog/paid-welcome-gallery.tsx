import { useState } from "react";

import { GalleryDeploySteps } from "#renderer/components/site-deploy/gallery";

import { PaidWelcomeDialog } from "./paid-welcome";

export const PAID_WELCOME_GALLERY_VARIANTS = [
  "paused",
  "last-chat",
  "first-task",
  "first-task-busy",
  "basic",
  "pro",
  "unknown-balance",
  "site",
  "site-paused",
] as const;

type Variant = (typeof PAID_WELCOME_GALLERY_VARIANTS)[number];

/** The paid welcome as each case sees it; every button closes it. */
export const PaidWelcomeGallery = ({ variant }: { variant: Variant }) => {
  const [open, setOpen] = useState(true);
  const close = () => setOpen(false);
  return (
    <PaidWelcomeDialog
      open={open}
      planName={variant === "pro" ? "Pro" : "Basic"}
      credits={
        variant === "unknown-balance" ? null : variant === "pro" ? 25000 : 20000
      }
      model="RouteLLM"
      topModel={
        variant === "basic" || variant === "pro" || variant.startsWith("site")
          ? null
          : "Claude Opus 5.5"
      }
      lead={
        variant === "last-chat"
          ? "chat"
          : variant.startsWith("first-task")
            ? "task"
            : variant === "paused" || variant === "site-paused"
              ? "paused"
              : "none"
      }
      lastChat={variant === "last-chat" ? "Landing page for my bakery" : null}
      busy={variant === "first-task-busy" ? "build" : null}
      paused={
        variant === "paused" || variant === "site-paused"
          ? "Build my bakery website with an online order form"
          : null
      }
      deploy={
        variant.startsWith("site") ? <GalleryDeploySteps state="ready" /> : null
      }
      unlock={variant === "pro" ? "media" : "apps"}
      onStep={close}
      onClose={close}
    />
  );
};
