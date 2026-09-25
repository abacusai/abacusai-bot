/**
 * The connector registry: one entry per service the agent can attach, and the
 * one place that says what kind of thing it is. Everything downstream (the
 * Connectors page, onboarding, the Connect button in a chat, the
 * `connect_connector` tool, the model's routing hints, the agent's per-tool
 * guards) reads this and never keeps a list of its own.
 *
 * The rule the rest of the app leans on: this registry is the allowlist. A
 * platform service, a gateway tool, or a prompt mention that is not here does
 * not exist as far as the app is concerned.
 *
 * Four kinds, told apart by `kind`:
 * - platform:   attached on the user's Abacus.AI account; its tools arrive
 *               through the shared `abacus-connectors` gateway server.
 * - credential: a token the agent itself uses from bash (`gh`), stored as an
 *               agent credential; no server.
 * - messaging:  a chat app the agent can be reached from, paired in the app.
 * - mcp:        an MCP server the app installs, with or without a credential.
 */

export type ConnectorKind = "platform" | "credential" | "messaging" | "mcp";

export type ConnectorCategory =
  | "messaging"
  | "abacus-connectors"
  | "featured"
  | "development"
  | "productivity"
  | "data"
  | "infrastructure"
  | "web"
  | "payments"
  | "support";

/** The server the platform connectors' tools arrive through. */
export const GATEWAY_SERVER_NAME = "abacus-connectors";

/** What a chat app is called in the messaging gateway. */
export type MessagingPlatform = "whatsapp" | "telegram" | "discord";

/** An MCP server entry as the app writes it into its MCP config. */
export interface McpEntry {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: { clientId?: string; clientSecret?: string; scope?: string } | false;
}

/** How a `fields` dialog labels and treats one input. */
export interface ConnectorField {
  label: string;
  secret?: boolean;
  placeholder?: string;
}

interface ConnectorBase {
  /** Stable across every surface: card data-ids, templates, the tool's answers. */
  id: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  /** Where the user gets a key, or reads what the service can do. */
  docsUrl: string;
  /** Bundled logo asset, by key; the renderer owns the file. */
  logo?: string;
  /** Offered on the onboarding step too, which shows a handful, not the catalog. */
  onboarding?: boolean;
  /**
   * What to go and make before this can connect, in order. Says what to make
   * and what to bring back, never menus inside someone else's console.
   */
  setup?: readonly string[];
  /**
   * The kinds of task this connector answers, in the model's words
   * ("mail", "pull requests"). The routing prompt is generated from these.
   */
  routes?: readonly string[];
}

export interface PlatformConnector extends ConnectorBase {
  kind: "platform";
  /** The platform's service key, lowercase: "gmailuser", "slack". */
  service: string;
  /** The gateway tools this app takes for the service: an allowlist. */
  tools: readonly string[];
  /** What one call to any of those tools costs the user, in credits. */
  credits: number;
}

export interface CredentialConnector extends ConnectorBase {
  kind: "credential";
  /** The provider id the desktop stores the credential under. */
  provider: string;
  /** The environment variable the agent (and the CLI it drives) reads it from. */
  envVar: string;
  /** How the model reaches the service once the credential is there. */
  via: string;
  fields: Record<string, ConnectorField>;
}

export interface MessagingConnector extends ConnectorBase {
  kind: "messaging";
  platform: MessagingPlatform;
}

export interface McpConnector extends ConnectorBase {
  kind: "mcp";
  /**
   * 'none' works on add; 'token' is a pasted token sent as a header; 'key' is
   * API keys passed as environment; 'oauth' is the server's browser sign-in;
   * 'oauth-client' is the same against an OAuth app the user creates first.
   */
  auth: "none" | "token" | "key" | "oauth" | "oauth-client";
  entry: McpEntry;
  /** Environment variables the user must fill in for a `key` server. */
  env?: readonly string[];
  /** For a `token` server: the header the token goes in and its label. */
  token?: { header: string; scheme: string; label: string };
  fields?: Record<string, ConnectorField>;
  /** Something the entry cannot install; checked on add, warned about, never blocking. */
  requires?: "google-chrome";
}

export type Connector =
  | PlatformConnector
  | CredentialConnector
  | MessagingConnector
  | McpConnector;

/**
 * What connecting needs from the user. One dialog per kind, shared by every
 * surface that offers a Connect button.
 */
export type ConnectUi = "browser-hop" | "fields" | "pairing" | "none";

export const connectUi = (connector: Connector): ConnectUi => {
  switch (connector.kind) {
    case "platform":
      return "browser-hop";
    case "credential":
      return "fields";
    case "messaging":
      return "pairing";
    case "mcp":
      return connector.auth === "none"
        ? "none"
        : connector.auth === "oauth"
          ? "browser-hop"
          : "fields";
  }
};

/**
 * A literal `~` reaches a server unexpanded (no shell is involved); the
 * renderer swaps this for the real home when the connector is added.
 */
export const HOME_PLACEHOLDER = "{{HOME}}";

/** One call to a platform connector's tool, in credits, until the server says otherwise per service. */
const PLATFORM_CALL_CREDITS = 10;

const remote = (url: string): McpEntry => ({ url });
const npx = (pkg: string, ...args: string[]): McpEntry => ({
  command: "npx",
  args: ["-y", pkg, ...args],
});

const platform = (
  service: string,
  name: string,
  description: string,
  tools: readonly string[],
  options: {
    logo?: string;
    onboarding?: boolean;
    routes?: readonly string[];
  } = {}
): PlatformConnector => ({
  kind: "platform",
  id: `abacus-${service}`,
  name,
  description,
  category: "abacus-connectors",
  // The connectors page, not the homepage: somewhere actionable.
  docsUrl: "https://apps.abacus.ai/chatllm/admin/connectors-list/",
  service,
  tools,
  credits: PLATFORM_CALL_CREDITS,
  ...options,
});

const messaging = (
  platform: MessagingPlatform,
  name: string,
  description: string,
  docsUrl: string
): MessagingConnector => ({
  kind: "messaging",
  id: `messaging-${platform}`,
  name,
  description,
  category: "messaging",
  docsUrl,
  platform,
  onboarding: true,
});

export const CONNECTORS: readonly Connector[] = [
  // ── Messaging, listed first: an agent you can text is a different product ──
  messaging(
    "whatsapp",
    "WhatsApp",
    "Chat with the agent from WhatsApp, and let it message people as you. Connects by scanning a QR code with your phone.",
    "https://faq.whatsapp.com/1317564962315842"
  ),
  messaging(
    "telegram",
    "Telegram",
    "Chat with the agent from Telegram, and let it message people as you. Connects by scanning a QR code with your phone.",
    "https://telegram.org/"
  ),
  messaging(
    "discord",
    "Discord",
    "Chat with the agent from Discord, and let it message people as you. Connects by scanning a QR code with the Discord app, or by linking the Abacus AI bot.",
    "https://discord.com/"
  ),

  // ── Abacus.AI account connectors ────────────────────────────────────────
  platform(
    "gmailuser",
    "Gmail",
    "Read, search, draft and send mail from your Gmail account.",
    ["Gmail_Tool", "Gmail_Attachments"],
    { logo: "gmail", onboarding: true, routes: ["mail"] }
  ),
  platform(
    "googledriveuser",
    "Google Drive",
    "Browse, read and manage files, docs and spreadsheets in your Drive.",
    ["Google_Drive_Tool", "Google_Sheets_Tool"],
    {
      logo: "google-drive",
      onboarding: true,
      routes: ["files", "docs", "spreadsheets"],
    }
  ),
  platform(
    "googlecalendar",
    "Google Calendar",
    "Check availability, list events and schedule meetings on your calendar.",
    ["Google_Calendar_Tool"],
    {
      logo: "google-calendar",
      onboarding: true,
      routes: ["events", "availability"],
    }
  ),
  platform(
    "slack",
    "Slack",
    "Search, read and post in your Slack workspace: one click, no Slack app to create.",
    ["Slack_Tool"],
    { logo: "slack", onboarding: true, routes: ["Slack messages and channels"] }
  ),
  platform(
    "outlook",
    "Outlook",
    "Read, search and send mail from your Outlook account.",
    ["Outlook_Tool"],
    { logo: "outlook", onboarding: true }
  ),
  platform(
    "onedrive",
    "OneDrive",
    "Browse, read and manage files in your OneDrive.",
    ["OneDrive_Tool"],
    { logo: "onedrive", onboarding: true }
  ),
  platform(
    "jira",
    "Jira",
    "Search, create and update issues in your Jira projects.",
    ["Jira_Tool"],
    { logo: "jira", onboarding: true, routes: ["Jira issues"] }
  ),
  platform(
    "confluence",
    "Confluence",
    "Search and read pages in your Confluence spaces.",
    ["Confluence_Tool"],
    { logo: "confluence", onboarding: true }
  ),
  platform(
    "dropbox",
    "Dropbox",
    "Browse, read and manage files in your Dropbox.",
    ["Dropbox_Tool"],
    { logo: "dropbox", onboarding: true }
  ),
  platform(
    "twitter",
    "X (Twitter)",
    "Read and post on X with your own account.",
    ["Twitter_Tool"],
    { logo: "x", onboarding: true }
  ),

  // ── Featured ────────────────────────────────────────────────────────────
  {
    // A personal access token instead of the platform's GitHub App: the App
    // install ends scoped to public repos, bills every read, and cannot
    // authenticate `gh`. The token does all three the other way.
    kind: "credential",
    id: "github",
    name: "GitHub",
    description:
      "Repos, issues and pull requests through the gh CLI, with your own token, private repos included.",
    category: "featured",
    docsUrl: "https://github.com/settings/tokens",
    provider: "github",
    envVar: "GH_TOKEN",
    via: "`gh` and git in bash",
    logo: "github",
    routes: ["repositories", "pull requests", "commits", "issues"],
    setup: [
      "Create a personal access token at github.com/settings/tokens: either a fine-grained token with access to the repositories you want (Contents + Pull requests + Issues, read/write as needed), or a classic token with the `repo` scope.",
      "Copy the token (it is shown once) and paste it below.",
    ],
    fields: { GH_TOKEN: { label: "Personal access token", secret: true } },
  },
  {
    kind: "mcp",
    id: "playwright",
    name: "Playwright",
    description:
      "Drive a real browser: navigate, click, fill forms, and read the page back.",
    category: "featured",
    auth: "none",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    // Pinned: `@latest` re-resolves on every spawn and breaks offline machines.
    entry: npx("@playwright/mcp@0.0.80"),
    requires: "google-chrome",
  },
  {
    kind: "mcp",
    id: "huggingface",
    name: "Hugging Face",
    description: "Search models, datasets and Spaces, and read their cards.",
    category: "data",
    auth: "none",
    docsUrl: "https://huggingface.co/settings/mcp",
    entry: remote("https://huggingface.co/mcp"),
  },

  // ── Infrastructure ──────────────────────────────────────────────────────
  {
    kind: "mcp",
    id: "cloudflare-docs",
    name: "Cloudflare Docs",
    description:
      "The Cloudflare developer documentation, searchable by the agent.",
    category: "infrastructure",
    auth: "none",
    docsUrl:
      "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    entry: remote("https://docs.mcp.cloudflare.com/mcp"),
  },
  {
    kind: "mcp",
    id: "zapier",
    name: "Zapier",
    description:
      "Thousands of app actions behind one server, wired to your Zapier account.",
    category: "productivity",
    auth: "oauth",
    docsUrl: "https://help.zapier.com/hc/en-us/articles/36265392843917",
    entry: remote("https://mcp.zapier.com/api/mcp/mcp"),
  },

  // ── Productivity ────────────────────────────────────────────────────────
  platform(
    "figmauser",
    "Figma",
    "Read files, projects and design data from your Figma account.",
    ["Figma_Tool"],
    { logo: "figma" }
  ),
  platform(
    "zoom",
    "Zoom",
    "Look up meetings, recordings and users in your Zoom account (read-only).",
    ["Zoom_Tool"],
    { logo: "zoom" }
  ),
  platform(
    "docusign",
    "DocuSign",
    "Envelopes, templates and signing workflows from your DocuSign account.",
    ["Docusign_Tool"],
    { logo: "docusign" }
  ),
  platform(
    "gcpcloud",
    "Google Cloud",
    "Compute, Storage, BigQuery and more, through your Google Cloud service account.",
    ["GCP_Tool"],
    { logo: "gcp" }
  ),
  {
    kind: "mcp",
    id: "notion",
    name: "Notion",
    description:
      "Search the workspace, read pages, and write notes back into it.",
    category: "featured",
    auth: "oauth",
    docsUrl: "https://developers.notion.com/docs/mcp",
    entry: remote("https://mcp.notion.com/mcp"),
    routes: ["Notion pages"],
  },
  {
    kind: "mcp",
    id: "canva",
    name: "Canva",
    description:
      "Find, create and export designs without leaving the conversation.",
    category: "web",
    auth: "oauth",
    docsUrl: "https://www.canva.dev/docs/mcp/",
    entry: remote("https://mcp.canva.com/mcp"),
  },

  // ── Payments and support ────────────────────────────────────────────────
  {
    kind: "mcp",
    id: "stripe",
    name: "Stripe",
    description: "Customers, payments and subscriptions, queried and created.",
    category: "payments",
    auth: "oauth",
    docsUrl: "https://docs.stripe.com/mcp",
    entry: remote("https://mcp.stripe.com"),
  },
  {
    kind: "mcp",
    id: "paypal",
    name: "PayPal",
    description: "Invoices, orders and disputes over PayPal’s own server.",
    category: "payments",
    auth: "oauth",
    docsUrl: "https://www.paypal.ai/",
    entry: remote("https://mcp.paypal.com/mcp"),
  },
];

export const CONNECTOR_CATEGORY_ORDER: readonly ConnectorCategory[] = [
  "messaging",
  "abacus-connectors",
  "featured",
  "development",
  "web",
  "data",
  "infrastructure",
  "productivity",
  "payments",
  "support",
];

const BY_ID = new Map(CONNECTORS.map((connector) => [connector.id, connector]));
const BY_SERVICE = new Map(
  CONNECTORS.filter(
    (connector): connector is PlatformConnector => connector.kind === "platform"
  ).map((connector) => [connector.service, connector])
);

export const connectorById = (id: string): Connector | undefined =>
  BY_ID.get(id);

/** The platform connector for a service key, in either case; undefined when the app does not take it. */
export const connectorForService = (
  service: string
): PlatformConnector | undefined => BY_SERVICE.get(service.toLowerCase());

export const connectorForPlatform = (
  platform: string
): MessagingConnector | undefined =>
  CONNECTORS.find(
    (connector): connector is MessagingConnector =>
      connector.kind === "messaging" && connector.platform === platform
  );

export const platformConnectors = (): readonly PlatformConnector[] =>
  CONNECTORS.filter(
    (connector): connector is PlatformConnector => connector.kind === "platform"
  );

/**
 * Resolve what a model (or a person) called a connector to an entry: by id,
 * name, platform service key or chat-app id: case-, space- and
 * punctuation-blind, then by prefix, then by a contained word of four letters
 * or more. More than one loose match is an ambiguity, reported as such.
 */
export const resolveConnector = (
  asked: string
): { match: Connector } | { ambiguous: Connector[] } | { match: null } => {
  const normalize = (text: string): string =>
    text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = normalize(asked);
  if (wanted.length === 0) return { match: null };
  const keysOf = (connector: Connector): string[] => [
    connector.id,
    connector.name,
    ...(connector.kind === "platform" ? [connector.service] : []),
    ...(connector.kind === "messaging" ? [connector.platform] : []),
    ...(connector.kind === "credential" ? [connector.provider] : []),
  ];
  const exact = CONNECTORS.filter((connector) =>
    keysOf(connector).some((key) => normalize(key) === wanted)
  );
  if (exact.length === 1) return { match: exact[0]! };
  if (exact.length > 1) return { ambiguous: exact };
  const loose = CONNECTORS.filter((connector) =>
    keysOf(connector).some(
      (key) =>
        normalize(key).startsWith(wanted) ||
        (wanted.length >= 4 && normalize(key).includes(wanted))
    )
  );
  if (loose.length === 1) return { match: loose[0]! };
  if (loose.length > 1) return { ambiguous: loose };
  return { match: null };
};
