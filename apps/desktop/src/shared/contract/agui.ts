/**
 * AG-UI / TanStack AI types the `ai.*` procedures speak (spec 00 A.3.1).
 * Type-only: each name comes from the package root that actually exports it,
 * and A-T1b checks that none of them resolves to `any`.
 */
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import type {
  RunAgentInputContext,
  RunAgentResumeItem,
  SubscribeConnectionAdapter,
} from "@tanstack/ai-client";

export type {
  RunAgentInputContext,
  RunAgentResumeItem,
  StreamChunk,
  SubscribeConnectionAdapter,
  UIMessage,
};

// Not exported from either package root (declared in ai-client's
// connection-adapters), so derived from the adapter's own signature, and
// re-declared as local interfaces so emitted declarations can name them.
type HydrateFn = NonNullable<SubscribeConnectionAdapter["hydrate"]>;
export interface ChatHydrationResult extends Awaited<ReturnType<HydrateFn>> {}
export interface ChatHydrateOptions extends NonNullable<
  Parameters<HydrateFn>[1]
> {}
