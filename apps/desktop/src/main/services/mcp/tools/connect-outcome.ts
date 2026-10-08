import type { Connector } from "@abacus-ai/connectors/registry";

/**
 * What asking for or dropping a connector did, as facts. The engine
 * (McpAgentToolsServer) decides; each chat surface words it for its user: the
 * app in ./connectors.ts, WhatsApp in ./phone/connectors.ts.
 */

/** A connector as an outcome names it. */
export interface NamedConnector {
  id: string;
  name: string;
}

export type ConnectOutcome =
  | { code: "no_connectors" }
  | {
      code: "list";
      entries: ReadonlyArray<{
        connector: Connector;
        status: { state: string; account?: string; botNumber?: boolean };
      }>;
    }
  | { code: "ambiguous"; asked: string; options: NamedConnector[] }
  | { code: "unknown"; asked: string; options: NamedConnector[] }
  | {
      code: "connected";
      name: string;
      kind: Connector["kind"];
      via?: string;
      account?: string;
      /** WhatsApp through AbacusAI Bot's own number: send_to_whatsapp reaches the user. */
      botNumber?: boolean;
    }
  | {
      code: "unavailable";
      name: string;
      reason: "not-signed-in" | "not-offered" | "unreachable";
    }
  /** No link exists for it; `card` says whether a Connect card went up in the app. */
  | { code: "no_link"; name: string; kind: Connector["kind"]; card: boolean }
  /** Every connector the link covers is connected already; it can only reconnect them. */
  | { code: "reconnect"; names: string[]; url: string }
  | { code: "link"; asking: string[]; already: string[]; url: string };

export type DisconnectOutcome =
  | { code: "required" }
  | { code: "ambiguous"; asked: string; options: NamedConnector[] }
  | { code: "unknown"; asked: string }
  | { code: "no_messaging" }
  | { code: "platform_off"; name: string }
  | { code: "no_connectors" }
  | { code: "not_connected"; name: string }
  | { code: "failed"; error: string }
  | { code: "disconnected"; name: string; kind: Connector["kind"] };
