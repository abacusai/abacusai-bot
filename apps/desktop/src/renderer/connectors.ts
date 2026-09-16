/**
 * The connector catalog, as the renderer sees it: the registry in
 * `@abacus-ai/connectors`, re-exported so the components keep one import.
 * Nothing is defined here — a connector added to the registry appears on the
 * Connectors page, in onboarding, in the chat's Connect card and in the
 * `connect_connector` tool without this file changing. Logos, which are
 * bundled assets, live in `components/settings/connector-logos.ts`.
 */
export * from "@abacus-ai/connectors/registry";
export type { Connector as ConnectorDefinition } from "@abacus-ai/connectors/registry";
