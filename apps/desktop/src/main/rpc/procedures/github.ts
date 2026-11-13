import type { WorkspaceGitContext } from "@abacus-ai/contract/contracts";

import {
  DISABLED_STATUS,
  GithubRequestError,
} from "../../services/workspace/github-service";
import type { RpcContext } from "../context";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { impl } from "./impl";

/** Absent reads as on; off, no procedure here spawns `gh`. */
const enabled = (context: RpcContext): boolean =>
  context.deps.tables.prefsStore.get().githubIntegration !== false;

const assertEnabled = (context: RpcContext): void => {
  if (!enabled(context))
    throw forbidden("github-disabled", "GitHub integration is off");
};

/** The checkout the call acts on; a context naming none is NOT_FOUND. */
const checkoutFor = (
  context: RpcContext,
  target: WorkspaceGitContext
): string => {
  const checkout = context.deps.serviceHost.gitContextPath(target);
  if (checkout == null) throw notFound("workspace", target.workspaceId);
  return checkout;
};

/**
 * A refused request as the contract's error: an empty body is BAD_REQUEST,
 * the rest CONFLICT with `data.reason` (`pr-mismatch`, `gh-missing`,
 * `gh-unauthenticated`, `gh-timeout`, `gh-error`) and gh's own words.
 */
const mapped = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof GithubRequestError)) throw error;
    throw error.reason === "empty-body"
      ? badRequest(error.message)
      : conflict(error.reason, error.message);
  }
};

export const githubRouter = impl.github.router({
  status: impl.github.status.handler(({ input, context }) =>
    enabled(context)
      ? context.deps.serviceHost.github.status(input?.refresh === true)
      : DISABLED_STATUS
  ),
  pr: impl.github.pr.handler(({ input, context }) =>
    enabled(context)
      ? context.deps.serviceHost.github.pr(
          context.deps.serviceHost.gitContextPath(input)
        )
      : { kind: "unavailable" as const, status: DISABLED_STATUS }
  ),
  prDiff: impl.github.prDiff.handler(({ input, context }) => {
    assertEnabled(context);
    const checkout = checkoutFor(context, input.context);
    return mapped(() =>
      context.deps.serviceHost.github.prDiff(checkout, input.number)
    );
  }),
  review: impl.github.review.handler(async ({ input, context }) => {
    assertEnabled(context);
    const checkout = checkoutFor(context, input.context);
    await mapped(() =>
      context.deps.serviceHost.github.review(
        checkout,
        input.number,
        input.verdict,
        input.body
      )
    );
    return { ok: true as const };
  }),
  watch: impl.github.watch.handler(({ context }) =>
    context.deps.serviceHost.githubWatchView()
  ),
  setWatch: impl.github.setWatch.handler(({ input, context }) =>
    context.deps.serviceHost.setGithubWatch(input)
  ),
});
