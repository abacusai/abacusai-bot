/**
 * The connector catalog, as the renderer sees it: the registry in
 * `@abacus-ai/connectors`, re-exported so the components keep one import.
 * Nothing is defined here: a connector added to the registry appears on the
 * Connectors page, in onboarding, in the chat's Connect card and in the
 * `connect_connector` tool without this file changing. Logos, which are
 * bundled assets, live in `components/settings/connector-logos.ts`.
 */
import type { TFunction } from "i18next";

export * from "@abacus-ai/connectors/registry";
export type { Connector as ConnectorDefinition } from "@abacus-ai/connectors/registry";

/**
 * A connector's one-line description in the UI language. The registry keeps
 * English, which the agent's prompts read; the locale files carry the rest,
 * and a connector added without a key still shows its registry text.
 */
export const connectorDescription = (
  t: TFunction,
  connector: { id: string; description: string }
): string =>
  t(`connectors.descriptions.${connector.id}`, {
    defaultValue: connector.description,
  });
