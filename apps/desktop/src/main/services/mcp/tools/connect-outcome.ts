import type { Connector } from "@abacus-ai/connectors/registry";
import type { HomeChannel } from "@abacus-ai/contract/bots";

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
      /** A chat app: which, so the result can say how the user reaches the bot there. */
      platform?: HomeChannel;
    }
  | {
      code: "unavailable";
      name: string;
      reason: "not-signed-in" | "not-offered" | "unreachable";
    }
  /** An account service this surface does not connect; no link was made. */
  | { code: "not_here"; name: string }
  /**
   * No link exists for it; `card` says whether a Connect card went up in the
   * app, and `routine` that this is a routine's run, with nobody in front of it.
   */
  | {
      code: "no_link";
      name: string;
      kind: Connector["kind"];
      card: boolean;
      routine: boolean;
    }
  /**
   * Every connector the link covers is connected already; it can only
   * reconnect them. `expiresAt` (ms), on either, is when the link stops working.
   */
  | { code: "reconnect"; names: string[]; url: string; expiresAt?: number }
  | {
      code: "link";
      asking: string[];
      already: string[];
      url: string;
      routine: boolean;
      expiresAt?: number;
    };

/**
 * How long a link works, for the model to pass on: its local clock time
 * (HH:MM) and whole minutes left, at least one. Null when it has no expiry.
 */
export const linkLifetime = (
  expiresAt: number | undefined,
  now = Date.now()
): { until: string; minutes: number } | null => {
  if (expiresAt == null) return null;
  const at = new Date(expiresAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    until: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    minutes: Math.max(1, Math.round((expiresAt - now) / 60_000)),
  };
};

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
