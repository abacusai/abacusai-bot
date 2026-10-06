/**
 * Whether a document-level view transition (the router's route transition,
 * transition-types.ts) is in flight right now. Layout that would otherwise
 * animate itself on a route change (the sidebar column's spring) reads this
 * and jumps instead: the transition then captures the final geometry and its
 * `::view-transition-group` animations move the pane and the sidebar as one
 * choreography, never a second layer of motion under the cross-fade.
 *
 * The router renders the new area's pending shell just before it starts the
 * transition, so an effect that would animate reads this from a frame
 * callback (the browser runs those before it captures the new state), not
 * at commit time. Browsers (and jsdom) without `activeViewTransition`
 * answer false.
 */
export const isRouteTransitionActive = (doc: Document = document): boolean =>
  (doc as Document & { activeViewTransition?: unknown }).activeViewTransition !=
  null;
