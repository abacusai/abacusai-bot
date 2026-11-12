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
 *               A `local` one is a program another app put on the computer
 *               (Roblox Studio's): offered only on the systems it exists on.
 */

export type ConnectorKind = "platform" | "messaging" | "mcp";

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
  /** Only these of the server's tools reach the model; every one when unset. */
  tools?: string[];
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
  /**
   * How the model should use it once connected, in the model's words: what
   * to reach for first, and what to tell the user when it is not ready.
   */
  usage?: string;
}

export interface PlatformConnector extends ConnectorBase {
  kind: "platform";
  /** The platform's service key, lowercase: "gmailuser", "slack". */
  service: string;
  /** The gateway tools this app takes for the service: an allowlist. */
  tools: readonly string[];
  /** What one call to any of those tools costs the user, in credits. */
  credits: number;
  /**
   * How the model reaches a service that brings no gateway tools: GitHub's
   * token reaches the agent as GH_TOKEN, for `gh` and git in bash.
   */
  via?: string;
}

export interface MessagingConnector extends ConnectorBase {
  kind: "messaging";
  platform: MessagingPlatform;
}

/** The desktop systems, as Node names them. */
export type DesktopOs = "darwin" | "win32" | "linux";

/**
 * A server that ships inside another app on the user's computer: the entry
 * that starts it on this system, and the file whose presence says that app
 * is installed. `%NAME%` in `app` is the environment variable's value.
 */
export interface LocalServer {
  entry: McpEntry;
  /**
   * The app itself, where an install puts it: any of these paths. A `*`
   * segment stands for any one folder (Roblox keeps each Studio version in a
   * folder named after it).
   */
  app: readonly string[];
  /**
   * What `entry` launches. The app can be installed without it: Studio writes
   * its launcher only once its MCP server is turned on.
   */
  server: string;
}

export interface McpConnector extends ConnectorBase {
  kind: "mcp";
  /**
   * 'none' works on add; 'token' is a pasted token sent as a header; 'key' is
   * API keys passed as environment; 'oauth' is the server's browser sign-in;
   * 'oauth-client' is the same against an OAuth app the user creates first.
   */
  auth: "none" | "token" | "key" | "oauth" | "oauth-client";
  /** What it installs as; a `local` connector says it per system instead. */
  entry?: McpEntry;
  /**
   * A server another app installs, by the systems that app runs on. The
   * connector is offered only on those, and connects once the app is there.
   */
  local?: Partial<Record<DesktopOs, LocalServer>>;
  /** Where the user gets the app a `local` server ships in. */
  appUrl?: string;
  /** Environment variables the user must fill in for a `key` server. */
  env?: readonly string[];
  /** For a `token` server: the header the token goes in and its label. */
  token?: { header: string; scheme: string; label: string };
  fields?: Record<string, ConnectorField>;
}

export type Connector = PlatformConnector | MessagingConnector | McpConnector;

/**
 * What connecting needs from the user. One dialog per kind, shared by every
 * surface that offers a Connect button.
 */
export type ConnectUi = "browser-hop" | "fields" | "pairing" | "none";

/**
 * The fields a "fields" connector asks for, by key: a tool server's own, its
 * token, its OAuth client, or its environment keys. Every surface that takes
 * them (the Connectors page, the Connect card) reads this one list.
 */
export const connectFields = (
  connector: Connector
): Record<string, ConnectorField> => {
  if (connector.kind !== "mcp") return {};
  if (connector.fields) return connector.fields;
  if (connector.auth === "token")
    return {
      token: { label: connector.token?.label ?? "Token", secret: true },
    };
  if (connector.auth === "oauth-client")
    return {
      clientId: { label: "Client ID", secret: false },
      clientSecret: { label: "Client secret", secret: true },
    };
  return Object.fromEntries(
    (connector.env ?? []).map((key) => [key, { label: key, secret: true }])
  );
};

export const connectUi = (connector: Connector): ConnectUi => {
  switch (connector.kind) {
    case "platform":
      return "browser-hop";
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
 * The entry this MCP connector installs as on `os`: its system's own for a
 * `local` connector (null where that app does not run), else its one entry.
 */
export const mcpEntryOn = (
  connector: McpConnector,
  os: string
): McpEntry | null =>
  connector.local != null
    ? (connector.local[os as DesktopOs]?.entry ?? null)
    : (connector.entry ?? null);

/**
 * A literal `~` reaches a server unexpanded (no shell is involved); the
 * renderer swaps this for the real home when the connector is added.
 */
export const HOME_PLACEHOLDER = "{{HOME}}";

/** One call to a platform connector's tool, in credits, until the server says otherwise per service. */
const PLATFORM_CALL_CREDITS = 10;

/**
 * The Studio tools the model is offered: finding things, editing scripts,
 * running Luau and playtesting. Studio ships some thirty, and a long tool
 * list costs every turn and confuses smaller models; image capture and the
 * asset generators are left out, since execute_luau covers building.
 */
export const ROBLOX_STUDIO_TOOLS = [
  "list_roblox_studios",
  "get_studio_state",
  "search_game_tree",
  "inspect_instance",
  "script_search",
  "script_read",
  "multi_edit",
  "execute_luau",
  "start_stop_play",
  "get_console_output",
] as const;

const remote = (url: string): McpEntry => ({ url });

const platform = (
  service: string,
  name: string,
  description: string,
  tools: readonly string[],
  options: {
    logo?: string;
    onboarding?: boolean;
    routes?: readonly string[];
    category?: ConnectorCategory;
    via?: string;
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
  // One tap on GitHub's own Authorize screen, acting as the user across their
  // repositories, private and organization ones included. No gateway tools:
  // the token reaches the agent as GH_TOKEN, for `gh` and git.
  platform(
    "githubbot",
    "GitHub",
    "Repos, issues and pull requests through the gh CLI, as you, private repos included.",
    [],
    {
      category: "featured",
      logo: "github",
      routes: ["repositories", "pull requests", "commits", "issues"],
      via: "`gh` and git in bash",
    }
  ),
  // Roblox Studio's own server, which ships with Studio (Windows and macOS
  // only) and speaks stdio. Studio must be open with "Enable Studio as MCP
  // server" turned on in its Assistant; until then its tools find no Studio.
  {
    kind: "mcp",
    id: "roblox-studio",
    name: "Roblox Studio",
    description:
      "Build in your open place: write and run scripts, edit the game and playtest it.",
    category: "development",
    auth: "none",
    docsUrl: "https://create.roblox.com/docs/studio/mcp",
    logo: "roblox",
    appUrl: "https://create.roblox.com/",
    local: {
      win32: {
        entry: {
          command: "cmd.exe",
          args: ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"],
          tools: [...ROBLOX_STUDIO_TOOLS],
        },
        app: [
          "%LOCALAPPDATA%\\Roblox\\Versions\\*\\RobloxStudioBeta.exe",
          "%ProgramFiles(x86)%\\Roblox\\Versions\\*\\RobloxStudioBeta.exe",
        ],
        server: "%LOCALAPPDATA%\\Roblox\\mcp.bat",
      },
      darwin: {
        entry: {
          command: "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP",
          tools: [...ROBLOX_STUDIO_TOOLS],
        },
        app: ["/Applications/RobloxStudio.app"],
        server: "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP",
      },
    },
    routes: ["Roblox games", "Roblox Studio places", "Luau scripts"],
    usage:
      "Work inside the user's open place, not in chat: call list_roblox_studios first and pass its studio_id; " +
      "find things with search_game_tree, inspect_instance, script_search and script_read; write or change " +
      "scripts with multi_edit; build or change the world with execute_luau; then test with start_stop_play and get_console_output and fix what the output shows. Do not paste Luau " +
      "for the user to copy unless they ask for it. If list_roblox_studios finds no Studio or a call fails, " +
      "tell the user in one line: open the place in Roblox Studio, then in Assistant choose … > Manage MCP " +
      "Servers and turn on Enable Studio as MCP server.",
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
    // Not the older /api/mcp/mcp: it still runs the whole OAuth flow, then
    // refuses every token it issued with 401 "Invalid authorization token".
    entry: remote("https://mcp.zapier.com/api/v1/connect"),
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
  platform(
    "azurecloud",
    "Microsoft Azure",
    "Resources, storage and costs in your Azure subscriptions, through an app registration.",
    ["Azure_Tool"],
    { logo: "azure" }
  ),
  platform(
    "gitlabuser",
    "GitLab",
    "Projects, issues, merge requests and pipelines in your GitLab account.",
    ["Gitlab_Tool"],
    { logo: "gitlab", routes: ["GitLab projects and merge requests"] }
  ),
  platform(
    "teams",
    "Microsoft Teams",
    "Read and post in your Teams chats and channels.",
    ["Teams_Tool"],
    { logo: "teams" }
  ),
  platform(
    "sharepoint",
    "SharePoint",
    "Find and read files and pages on your SharePoint sites.",
    ["Sharepoint_Tool"],
    { logo: "sharepoint" }
  ),
  platform(
    "onenote",
    "OneNote",
    "Read and write notebooks, sections and pages in OneNote.",
    ["OneNote_Tool"],
    { logo: "onenote" }
  ),
  platform(
    "box",
    "Box",
    "Browse, read and manage files in your Box account.",
    ["Box_Tool"],
    { logo: "box" }
  ),
  platform(
    "monday",
    "Monday.com",
    "Read and update boards, items and updates in monday.com.",
    ["Monday_Tool"],
    { logo: "monday" }
  ),
  platform(
    "smartsheet",
    "Smartsheet",
    "Read and update your sheets, rows and reports in Smartsheet.",
    ["Smartsheet_Tool"],
    { logo: "smartsheet" }
  ),
  platform(
    "autodesk",
    "Autodesk",
    "Projects, documents and issues in Autodesk Construction Cloud.",
    ["Autodesk_Tool"],
    { logo: "autodesk" }
  ),

  // ── Marketing and sales ─────────────────────────────────────────────────
  platform(
    "googleads",
    "Google Ads",
    "Campaign performance, keywords and budgets, and changes when you ask for them.",
    ["Google_Ads_Tool"],
    { logo: "google-ads", routes: ["Google Ads campaigns"] }
  ),
  platform(
    "metaads",
    "Meta Ads",
    "Campaigns, ad sets and results across Facebook and Instagram ads.",
    ["Meta_Ads_Tool"],
    { logo: "meta", routes: ["Facebook and Instagram ads"] }
  ),
  platform(
    "googleanalyticsuser",
    "Google Analytics",
    "Traffic, conversions and audience reports from your GA4 properties.",
    ["Google_Analytics_Tool"],
    { logo: "google-analytics", routes: ["website traffic"] }
  ),
  platform(
    "googlesearchconsole",
    "Google Search Console",
    "Search queries, rankings and indexing for your sites.",
    ["Google_Search_Console_Tool"],
    { logo: "search-console", routes: ["search rankings"] }
  ),
  platform(
    "youtube",
    "YouTube",
    "Your channel, videos, playlists and comments.",
    ["Youtube_Tool"],
    { logo: "youtube", routes: ["YouTube channels and videos"] }
  ),
  platform(
    "instagram",
    "Instagram",
    "Posts, comments and insights on your Instagram business account.",
    ["Instagram_Tool"],
    { logo: "instagram" }
  ),
  platform(
    "messenger",
    "Facebook Messenger",
    "Read and answer messages to your Facebook Pages.",
    ["Messenger_Tool"],
    { logo: "messenger" }
  ),
  platform(
    "whatsappbusiness",
    "WhatsApp Business",
    "Send messages and templates from your WhatsApp Business number.",
    ["WhatsApp_Tool"],
    { logo: "whatsapp" }
  ),
  platform(
    "hubspot",
    "HubSpot",
    "Contacts, companies and deals in your HubSpot CRM.",
    ["Hubspot_Tool"],
    { logo: "hubspot", routes: ["CRM contacts and deals"] }
  ),
  platform(
    "dynamics365",
    "Dynamics 365",
    "Sales, service and Dataverse records in Microsoft Dynamics 365.",
    ["Dynamics_365_Tool"],
    { logo: "dynamics365" }
  ),
  platform(
    "quickbooks",
    "QuickBooks",
    "Invoices, customers, expenses and reports in QuickBooks Online.",
    ["Quickbooks_Tool"],
    { logo: "quickbooks", routes: ["invoices and bookkeeping"] }
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
