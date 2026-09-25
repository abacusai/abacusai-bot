/**
 * The registry is the one list every surface reads, so the things a surface
 * would otherwise assume about a connector are checked here instead: every entry can
 * be connected, every platform entry names the tools it takes, ids and
 * service keys are unique, and what a model calls a connector resolves.
 */
import { describe, expect, it } from "vitest";

import {
  catalogPrompt,
  describeForListing,
  routingPrompt,
} from "./describe.js";
import {
  CONNECTORS,
  connectUi,
  connectorById,
  connectorForService,
  GATEWAY_SERVER_NAME,
  resolveConnector,
} from "./registry.js";
import {
  connectorToolMetaByName,
  gatewayToolMeta,
  gatewayToolName,
} from "./tool-meta.js";

describe("every entry", () => {
  it("has a unique id, a name, a category and somewhere to send the user", () => {
    const ids = CONNECTORS.map((connector) => connector.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const connector of CONNECTORS) {
      expect(connector.name.length).toBeGreaterThan(0);
      expect(connector.description.length).toBeGreaterThan(0);
      expect(connector.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it("has a way to connect that a dialog exists for", () => {
    for (const connector of CONNECTORS)
      expect(["browser-hop", "fields", "pairing", "none"]).toContain(
        connectUi(connector)
      );
  });

  it("asks for fields only where it says what they are", () => {
    for (const connector of CONNECTORS) {
      if (connectUi(connector) !== "fields") continue;
      if (connector.kind === "credential")
        expect(Object.keys(connector.fields).length).toBeGreaterThan(0);
      if (connector.kind === "mcp")
        expect(
          connector.auth === "token" ||
            connector.auth === "oauth-client" ||
            (connector.env?.length ?? 0) > 0
        ).toBe(true);
    }
  });
});

describe("platform entries", () => {
  it("name at least one gateway tool each, and no tool twice", () => {
    const seen = new Set<string>();
    for (const connector of CONNECTORS) {
      if (connector.kind !== "platform") continue;
      expect(connector.tools.length).toBeGreaterThan(0);
      expect(connector.credits).toBeGreaterThan(0);
      for (const tool of connector.tools) {
        expect(seen.has(tool), `${tool} listed twice`).toBe(false);
        seen.add(tool);
      }
    }
  });

  it("use the platform's own service key, once", () => {
    const services = CONNECTORS.flatMap((connector) =>
      connector.kind === "platform" ? [connector.service] : []
    );
    expect(new Set(services).size).toBe(services.length);
    for (const service of services) expect(service).toMatch(/^[a-z0-9_]+$/);
    expect(connectorForService("GMAILUSER")?.id).toBe("abacus-gmailuser");
  });

  it("never include GitHub: that is a token on its own card", () => {
    expect(connectorForService("githubuser")).toBeUndefined();
    expect(connectorById("github")?.kind).toBe("credential");
  });
});

describe("gateway tool metadata", () => {
  it("knows a listed tool and refuses an unlisted one", () => {
    expect(gatewayToolMeta("Gmail_Tool")).toMatchObject({
      connectorId: "abacus-gmailuser",
      service: "gmailuser",
      tool: "Gmail_Tool",
      credits: 10,
    });
    expect(gatewayToolMeta("Git_Tool")).toBeNull();
    expect(gatewayToolMeta("Github_Tool")).toBeNull();
  });

  it("takes the server's price over the registry's when it sends one", () => {
    expect(gatewayToolMeta("Gmail_Tool", { credits: 3 })?.credits).toBe(3);
    expect(gatewayToolMeta("Gmail_Tool", { credits: "x" })?.credits).toBe(10);
  });

  it("answers by the pi-side name too", () => {
    expect(gatewayToolName("Gmail_Tool")).toBe(
      `${GATEWAY_SERVER_NAME}_Gmail_Tool`
    );
    expect(
      connectorToolMetaByName("abacus-connectors_Slack_Tool")?.service
    ).toBe("slack");
    expect(connectorToolMetaByName("bash")).toBeNull();
    expect(connectorToolMetaByName("abacus-connectors_Git_Tool")).toBeNull();
  });
});

describe("what a model calls a connector", () => {
  it("resolves ids, names, service keys and chat apps", () => {
    expect(resolveConnector("gmailuser")).toMatchObject({
      match: { id: "abacus-gmailuser" },
    });
    expect(resolveConnector("Google Drive")).toMatchObject({
      match: { id: "abacus-googledriveuser" },
    });
    expect(resolveConnector("whatsapp")).toMatchObject({
      match: { id: "messaging-whatsapp" },
    });
    expect(resolveConnector("github")).toMatchObject({
      match: { id: "github" },
    });
    expect(resolveConnector("GitHub")).toMatchObject({
      match: { id: "github" },
    });
  });

  it("reports an ambiguous prefix rather than guessing", () => {
    const result = resolveConnector("google");
    expect("ambiguous" in result && result.ambiguous.length).toBeGreaterThan(1);
    expect(resolveConnector("myspace")).toEqual({ match: null });
  });
});

describe("what the model is told", () => {
  it("routes repository work to gh on the user's token, mail to Gmail", () => {
    const text = routingPrompt();
    expect(text).toMatch(
      /pull requests, commits, issues → `gh` and git in bash/
    );
    expect(text).toMatch(/GitHub connector card/);
    expect(text).toMatch(/mail → Gmail/);
    expect(text).toMatch(/events, availability → Google Calendar/);
    expect(text).not.toMatch(/GitHub connector;/);
    expect(routingPrompt()).toBe(routingPrompt());
  });

  it("names every connector, tool servers included, so none is 'not a connector'", () => {
    const text = catalogPrompt();
    for (const connector of CONNECTORS) expect(text).toContain(connector.name);
    expect(text).toMatch(/tool servers .*Playwright/);
    expect(text).toContain("call connect_connector");
    expect(routingPrompt()).toContain(text);
  });

  it("lists a connector by id and name with what to do about it", () => {
    const gmail = connectorById("abacus-gmailuser")!;
    expect(
      describeForListing(gmail, {
        state: "connected",
        account: "Gmail - ada@example.com",
      })
    ).toBe("abacus-gmailuser  Gmail  connected as Gmail - ada@example.com");
    expect(describeForListing(gmail, { state: "available" })).toContain(
      "not connected: ask for it with this tool"
    );
    const github = connectorById("github")!;
    expect(describeForListing(github, { state: "connected" })).toContain(
      "use `gh` and git in bash"
    );
    expect(describeForListing(github, { state: "available" })).toContain(
      "the user pastes a token"
    );
  });
});
