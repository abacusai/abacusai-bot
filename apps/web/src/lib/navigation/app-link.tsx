/**
 * `<Link>` with a `transition` prop (spec 01 §6.7): the intent goes into the
 * new history entry's state, like `useAppNavigate`.
 */
import { createLink, type LinkComponent } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import type { NavType } from "#renderer/lib/motion";

import { withIntent } from "./use-app-navigate";

type AnchorProps = ComponentProps<"a"> & {
  transition?: NavType | "none";
};

const Anchor = ({ transition: _transition, ref, ...props }: AnchorProps) => (
  <a ref={ref} {...props} />
);

const LinkWithTransition = createLink(Anchor);

export const AppLink = ((props: {
  transition?: NavType | "none";
  state?: unknown;
}) => {
  const { transition } = props;
  return (
    <LinkWithTransition
      {...(props as ComponentProps<typeof LinkWithTransition>)}
      {...(transition === undefined || props.state !== undefined
        ? {}
        : // A fresh intent each time the link builds its entry.
          { state: (previous) => withIntent(transition)(previous) })}
    />
  );
}) as LinkComponent<typeof Anchor>;
