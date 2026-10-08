/**
 * What the model is told about connectors, generated from the registry so a
 * connector added or changed there is described correctly everywhere on the
 * same day.
 */
import { CONNECTORS, type Connector } from "./registry.js";

/** The words a connector answers to, joined the way the routing line reads them. */
const routesOf = (connector: Connector): string | null =>
  connector.routes != null && connector.routes.length > 0
    ? connector.routes.join(", ")
    : null;

/** Where a task goes for this connector: its own path when it brings no tools (GitHub's `gh`), else the connector by name. */
const destinationOf = (connector: Connector): string =>
  connector.kind === "platform" && connector.via != null
    ? `${connector.via} (signed in as the user once ${connector.name} is connected; until then, connect it with connect_connector)`
    : connector.name;

/**
 * One line saying which tool a kind of task belongs to. Without it github.com
 * reads as a website and a pull-request question goes to the browser, whose
 * tool text never mentions connectors. Static across a process, so it costs
 * the prompt cache nothing.
 */
export const routingPrompt = (): string => {
  const routes = CONNECTORS.flatMap((connector) => {
    const words = routesOf(connector);
    return words == null ? [] : [`${words} → ${destinationOf(connector)}`];
  });
  return (
    `Route by service, not by website: ${routes.join("; ")}. ` +
    "If a connector is not attached, connect it with connect_connector rather " +
    "than driving the service's website in the browser; the browser is for " +
    `sites that have no connector. ${catalogPrompt()}`
  );
};

/** The connector names, by kind, the way the model should read them. */
export const catalogByKind = (): Record<Connector["kind"], string[]> => {
  const names: Record<Connector["kind"], string[]> = {
    platform: [],
    messaging: [],
    mcp: [],
  };
  for (const connector of CONNECTORS)
    names[connector.kind].push(connector.name);
  return names;
};

/**
 * Every connector the app can attach, named, so the model never calls one
 * "not a connector": the registry is the list, so the model reads the list.
 */
export const catalogPrompt = (): string => {
  const names = catalogByKind();
  return (
    `The connectors this app can attach are exactly: ${names.platform.join(", ")}; ` +
    `the chat apps ${names.messaging.join(", ")}; ` +
    `and the tool servers ${names.mcp.join(", ")}. ` +
    "When the user asks to connect or use one of these, call connect_connector " +
    "with its name: that puts the Connect button in the chat. Never say a name " +
    "on this list is not a connector, and never install one by hand."
  );
};

/** How a connector reads in a listing for the model, by its status. */
export const describeForListing = (
  connector: Connector,
  status: { state: string; account?: string; botNumber?: boolean }
): string => {
  const connected = status.state === "connected";
  const account =
    status.account != null && status.account.length > 0
      ? ` as ${status.account}`
      : "";
  const how =
    connector.kind === "messaging"
      ? status.botNumber === true
        ? "connected through AbacusAI Bot's number: send_to_whatsapp messages the user there"
        : connected
          ? "connected: send with its send_<platform>_message tool"
          : "not connected: ask for it with this tool"
      : connected
        ? `connected${account}${connector.kind === "platform" && connector.via != null ? `: use ${connector.via}` : ""}`
        : "not connected: ask for it with this tool";
  return `${connector.id}  ${connector.name}  ${how}`;
};
