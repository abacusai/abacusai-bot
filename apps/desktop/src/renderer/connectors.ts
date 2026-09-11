import type { McpServerEntry } from "#shared/contracts";
import type { MessagingPlatformId } from "#shared/messaging";

import confluenceLogo from "./assets/connectors/confluence.png";
import docusignLogo from "./assets/connectors/docusign.webp";
import dropboxLogo from "./assets/connectors/dropbox.png";
import figmaLogo from "./assets/connectors/figma.webp";
import gcpLogo from "./assets/connectors/gcs.png";
import githubLogo from "./assets/connectors/github.webp";
import gmailLogo from "./assets/connectors/gmail.png";
import googleCalendarLogo from "./assets/connectors/google_calendar.webp";
import googleDriveLogo from "./assets/connectors/google_drive.webp";
import jiraLogo from "./assets/connectors/jira.webp";
import onedriveLogo from "./assets/connectors/onedrive.webp";
import outlookLogo from "./assets/connectors/outlook.webp";
import slackLogo from "./assets/connectors/slack.png";
import xLogo from "./assets/connectors/x.webp";
import zoomLogo from "./assets/connectors/zoom.webp";

/**
 * The connector catalog: a name, a sentence, and an MCP server the agent can
 * talk to once added. Every entry must actually connect; one that does not
 * looks like the app is broken. `auth`: 'none' works on add; 'token' is a
 * pasted token sent as a header; 'key' is API keys passed as environment;
 * 'oauth' is the server's browser sign-in; 'oauth-client' is the same against
 * an OAuth app the user creates first (no RFC 7591 dynamic registration).
 * Token beats OAuth wherever a server accepts both.
 */
export type ConnectorAuth =
  | "none"
  | "oauth"
  | "token"
  | "key"
  | "oauth-client"
  | "abacus"
  | "agent-key"
  | "messaging";

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

interface ConnectorBase {
  /** Also the MCP server name it installs as, so "installed?" is a lookup. */
  id: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  /** Where the user gets a key, or reads what the server can do. */
  docsUrl: string;
  /** Environment variables the user must fill in for a `key` connector. */
  env?: string[];
  /** For a `token` connector: the header the token goes in and its label. */
  token?: { header: string; scheme: string; label: string };
  /**
   * What to go and make before this can connect, in order. Says what to make
   * and what to bring back, never menus inside someone else's console: those
   * move, and a confidently wrong path is worse than none.
   */
  setup?: string[];
  /**
   * How to label and treat each `env` field; absent means the variable's own
   * name. Only fields marked secret are masked: masking a hostname or project
   * id only stops the user proofreading what they pasted.
   */
  fields?: Record<
    string,
    { label: string; secret?: boolean; placeholder?: string }
  >;
  /** Bundled logo asset; the card falls back to a generic icon without one. */
  logo?: string;
}

/**
 * Rides the shared `abacus-connectors` gateway entry, so there is no `entry` to
 * carry. A separate interface, not an optional `entry`: a non-Abacus connector
 * that forgot its entry would install a server with neither url nor command.
 */
export interface AbacusConnector extends ConnectorBase {
  auth: "abacus";
  /**
   * "Installed" means the service is connected on the user's Abacus account,
   * not that an MCP entry with this id exists.
   */
  abacusService: string;
  /**
   * Also offered on the onboarding step, which shows a mass-market handful
   * rather than the whole catalog. The flag lives here so the catalog stays
   * the only place a connector is named.
   */
  onboarding?: boolean;
  entry?: never;
  messagingPlatform?: never;
}

/**
 * A messaging channel card. Not an MCP server: the messaging gateway's
 * platforms, surfaced so connecting a chat app lives beside every other
 * connection. "Installed" means enabled in the gateway; connecting runs the
 * platform's own pairing in a dialog rather than a browser hop.
 */
export interface MessagingConnector extends ConnectorBase {
  auth: "messaging";
  messagingPlatform: MessagingPlatformId;
  /** Offer this one on the onboarding step too — see AbacusConnector. */
  onboarding?: boolean;
  entry?: never;
  abacusService?: never;
}

/**
 * A credential the agent itself uses through CLIs in bash, not an MCP server.
 * Installing stores the fields as agent credentials; "installed" means stored.
 */
export interface AgentKeyConnector extends ConnectorBase {
  auth: "agent-key";
  /** The provider id saveApiKey maps to an env var (PROVIDER_ENV_VARS). */
  credentialProvider: string;
  entry?: never;
  abacusService?: never;
  messagingPlatform?: never;
}

/** Everything else: a described MCP server, which always has one to install. */
export interface McpServerConnector extends ConnectorBase {
  auth: Exclude<ConnectorAuth, "abacus" | "agent-key" | "messaging">;
  entry: McpServerEntry;
  /**
   * Something the entry cannot install: Playwright dies on first use without
   * the user's own Chrome. Checked on Add, warned about, never blocking.
   */
  requires?: "google-chrome";
  abacusService?: never;
  messagingPlatform?: never;
}

export type ConnectorDefinition =
  | AbacusConnector
  | MessagingConnector
  | AgentKeyConnector
  | McpServerConnector;

const remote = (url: string): McpServerEntry => ({ url });

/**
 * A literal `~` reaches the server unexpanded (no shell is involved); the
 * renderer swaps this for the real home when the connector is added.
 */
export const HOME_PLACEHOLDER = "{{HOME}}";
const npx = (pkg: string, ...args: string[]): McpServerEntry => ({
  command: "npx",
  args: ["-y", pkg, ...args],
});
/**
 * One-click connectors backed by the user's Abacus.AI account: connecting
 * attaches the service in the browser and the tools arrive through the shared
 * `abacus-connectors` gateway entry. Listed only when the gateway serves the
 * service's first-party tools and `_listValidAgentConnectors` admits it; a
 * card that connects but surfaces no tools is worse than an absent one.
 * Snowflake and Tableau also need an org admin to configure the org-level
 * connector first, which the connect page can only report after the click.
 */
const abacusConnector = (
  service: string,
  name: string,
  description: string,
  logo: string
): AbacusConnector => ({
  id: `abacus-${service}`,
  name,
  description,
  category: "abacus-connectors",
  auth: "abacus",
  // The connectors page, not the homepage: somewhere actionable.
  docsUrl: "https://apps.abacus.ai/chatllm/admin/connectors-list/",
  logo,
  abacusService: service,
});

/** The same card, also offered on the onboarding step — see `onboarding`. */
const onboardingConnector = (
  service: string,
  name: string,
  description: string,
  logo: string
): AbacusConnector => ({
  ...abacusConnector(service, name, description, logo),
  onboarding: true,
});

/**
 * Listed first: these make the agent reachable from the apps people already
 * talk in, worth more shelf space than one more SaaS logo.
 */
const messagingConnector = (
  platform: MessagingPlatformId,
  name: string,
  description: string,
  docsUrl: string
): MessagingConnector => ({
  id: `messaging-${platform}`,
  name,
  description,
  category: "messaging",
  auth: "messaging",
  docsUrl,
  messagingPlatform: platform,
  onboarding: true,
});

export const CONNECTORS: ConnectorDefinition[] = [
  // ── Messaging ────────────────────────────────────────────────────────────
  messagingConnector(
    "whatsapp",
    "WhatsApp",
    "Chat with the agent from WhatsApp, and let it message people as you. Connects by scanning a QR code with your phone.",
    "https://faq.whatsapp.com/1317564962315842"
  ),
  messagingConnector(
    "telegram",
    "Telegram",
    "Chat with the agent from Telegram, and let it message people as you. Connects by scanning a QR code with your phone.",
    "https://telegram.org/"
  ),
  messagingConnector(
    "discord",
    "Discord",
    "Chat with the agent from Discord, and let it message people as you. Connects by scanning a QR code with the Discord app, or by linking the Abacus AI bot.",
    "https://discord.com/"
  ),
  // ── Abacus.AI connectors ─────────────────────────────────────────────────
  onboardingConnector(
    "gmailuser",
    "Gmail",
    "Read, search, draft and send mail from your Gmail account.",
    gmailLogo
  ),
  onboardingConnector(
    "googledriveuser",
    "Google Drive",
    "Browse, read and manage files, docs and spreadsheets in your Drive.",
    googleDriveLogo
  ),
  onboardingConnector(
    "googlecalendar",
    "Google Calendar",
    "Check availability, list events and schedule meetings on your calendar.",
    googleCalendarLogo
  ),
  onboardingConnector(
    "slack",
    "Slack",
    "Search, read and post in your Slack workspace — one click, no Slack app to create.",
    slackLogo
  ),
  onboardingConnector(
    "outlook",
    "Outlook",
    "Read, search and send mail from your Outlook account.",
    outlookLogo
  ),
  onboardingConnector(
    "onedrive",
    "OneDrive",
    "Browse, read and manage files in your OneDrive.",
    onedriveLogo
  ),
  onboardingConnector(
    "jira",
    "Jira",
    "Search, create and update issues in your Jira projects.",
    jiraLogo
  ),
  onboardingConnector(
    "confluence",
    "Confluence",
    "Search and read pages in your Confluence spaces.",
    confluenceLogo
  ),
  onboardingConnector(
    "dropbox",
    "Dropbox",
    "Browse, read and manage files in your Dropbox.",
    dropboxLogo
  ),
  onboardingConnector(
    "twitter",
    "X (Twitter)",
    "Read and post on X with your own account.",
    xLogo
  ),
  {
    // A personal access token instead of the platform connector: the App-install
    // flow ends scoped to public repos only, and a PAT also powers the `gh` CLI.
    id: "github",
    name: "GitHub",
    description:
      "Repos, issues and pull requests through the gh CLI, with your own token — private repos included.",
    category: "featured",
    auth: "agent-key",
    credentialProvider: "github",
    docsUrl: "https://github.com/settings/tokens",
    env: ["GH_TOKEN"],
    setup: [
      "Create a personal access token at github.com/settings/tokens — either a fine-grained token with access to the repositories you want (Contents + Pull requests + Issues, read/write as needed), or a classic token with the `repo` scope.",
      "Copy the token (it is shown once) and paste it below.",
    ],
    fields: { GH_TOKEN: { label: "Personal access token", secret: true } },
    logo: githubLogo,
  },
  {
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
    id: "huggingface",
    name: "Hugging Face",
    description: "Search models, datasets and Spaces, and read their cards.",
    category: "data",
    auth: "none",
    docsUrl: "https://huggingface.co/settings/mcp",
    entry: remote("https://huggingface.co/mcp"),
  },

  // ── Infrastructure ───────────────────────────────────────────────────────
  {
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
    id: "zapier",
    name: "Zapier",
    description:
      "Thousands of app actions behind one server, wired to your Zapier account.",
    category: "productivity",
    auth: "oauth",
    docsUrl: "https://help.zapier.com/hc/en-us/articles/36265392843917",
    entry: remote("https://mcp.zapier.com/api/mcp/mcp"),
  },

  // ── Productivity ─────────────────────────────────────────────────────────
  abacusConnector(
    "figmauser",
    "Figma",
    "Read files, projects and design data from your Figma account.",
    figmaLogo
  ),
  abacusConnector(
    "zoom",
    "Zoom",
    "Look up meetings, recordings and users in your Zoom account — read-only.",
    zoomLogo
  ),
  abacusConnector(
    "docusign",
    "DocuSign",
    "Envelopes, templates and signing workflows from your DocuSign account.",
    docusignLogo
  ),
  abacusConnector(
    "gcpcloud",
    "Google Cloud",
    "Compute, Storage, BigQuery and more, through your Google Cloud service account.",
    gcpLogo
  ),
  {
    id: "notion",
    name: "Notion",
    description:
      "Search the workspace, read pages, and write notes back into it.",
    category: "featured",
    auth: "oauth",
    docsUrl: "https://developers.notion.com/docs/mcp",
    entry: remote("https://mcp.notion.com/mcp"),
  },
  {
    id: "canva",
    name: "Canva",
    description:
      "Find, create and export designs without leaving the conversation.",
    category: "web",
    auth: "oauth",
    docsUrl: "https://www.canva.dev/docs/mcp/",
    entry: remote("https://mcp.canva.com/mcp"),
  },

  // ── Payments and support ─────────────────────────────────────────────────
  {
    id: "stripe",
    name: "Stripe",
    description: "Customers, payments and subscriptions, queried and created.",
    category: "payments",
    auth: "oauth",
    docsUrl: "https://docs.stripe.com/mcp",
    entry: remote("https://mcp.stripe.com"),
  },
  {
    id: "paypal",
    name: "PayPal",
    description: "Invoices, orders and disputes over PayPal’s own server.",
    category: "payments",
    auth: "oauth",
    docsUrl: "https://www.paypal.ai/",
    entry: remote("https://mcp.paypal.com/mcp"),
  },
];

export const CONNECTOR_CATEGORY_ORDER: ConnectorCategory[] = [
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
