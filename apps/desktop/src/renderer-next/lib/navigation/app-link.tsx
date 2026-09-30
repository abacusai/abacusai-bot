/**
 * `<Link>` with a `transition` prop (spec 01 §6.7): the intent goes into the
 * new history entry's state, like `useAppNavigate`.
 */
import { createLink, type LinkComponent } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import type { NavType } from "#next/lib/motion";

type AnchorProps = ComponentProps<"a"> & {
  transition?: NavType | "none";
};

const Anchor = ({ transition: _transition, ref, ...props }: AnchorProps) => (
  <a ref={ref} {...props} />
);

const LinkWithTransition = createLink(Anchor);

const intentState =
  (transition: NavType | "none") =>
  (previous: Record<string, unknown>): Record<string, unknown> => ({
    ...previous,
    navIntent: { id: crypto.randomUUID(), type: transition },
  });

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
        : { state: intentState(transition) as never })}
    />
  );
}) as LinkComponent<typeof Anchor>;
