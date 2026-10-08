import { timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";

import type { ChannelCapabilities } from "@abacus-ai/agent/channel";
import { readTravelers } from "@abacus-ai/agent/traveler-store";
import type { IpcEvent } from "@abacus-ai/contract/contracts";
import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";

import { emitHostEvent } from "#main/rpc/emit";

import { abacusBotHome } from "../../paths";
import {
  chooseOption,
  globToRegexSource,
  isSyntaxError,
  navigationRefusal,
  navigationSettled,
  numericArg,
  parseKeyCombo,
  planExecuteAttempts,
  recipeFor,
  resolveTarget,
  SnapshotStore,
  type TargetResolution,
} from "../browser/browser-actions";
import {
  checkScript,
  clickScript,
  extractScript,
  fillScript,
  selectScript,
  settleScript,
  typeScript,
  valueScript,
} from "../browser/browser-page-scripts";
import {
  diffRefs,
  extractRefMap,
  filterSnapshot,
  flattenNodes,
  formatOverlays,
  formatPageSummary,
  formatTree,
  frameSnapshotScript,
  GET_ELEMENT_CENTER_JS,
  PAGE_SUMMARY_JS,
  renderTree,
  SNAPSHOT_BUILD_JS,
  type PageSummary,
  type SnapshotNode,
  type SnapshotOverlay,
} from "../browser/browser-snapshot";
import {
  pickBrowserTarget,
  type BrowserPage,
  type BrowserTargetMemory,
  type BrowserTargetSource,
} from "../browser/browser-target";
import {
  FENCE_ERROR,
  fenceBlockPatterns,
  fenceGuardExpression,
  isFencedUrl,
} from "../browser/host-fence";
import { type CapturedImage, SecretFields } from "../browser/secret-fields";
import type { MediaStore } from "../messaging/media-store";
import { abacusHostFence } from "../providers/abacus-host";
import type { CheckoutPause, RunEnd } from "../vault/checkout-run";
import {
  BROWSER_CHECKOUT_TOOL,
  BROWSER_PAUSE_TOOL,
  CHECKOUT_TOOL_LISTINGS,
  type CheckoutStateLine,
  checkoutStateLine,
  pageText,
  parsePause,
  SCREENSHOT_NEEDS,
  TRAVELER_FILL_FIELDS,
  TRAVELER_FILL_TOOL,
} from "../vault/checkout-tools";
import {
  chooseLoginFields,
  fieldName,
  LOGIN_CONTEXT_FUNCTION,
  LOGIN_FIELD_FUNCTION,
  LOGIN_FORM_PRESENT_SCRIPT,
  type LoginCandidate,
  loginFilledText,
  loginPurpose,
  REF_OF_FUNCTION,
  submitName,
} from "../vault/login-fill";
import {
  type Activation,
  activationVerdict,
  activatesControl,
  approvalCovers,
  commitVerdict,
  type ControlFacts,
  controlFactsScript,
  COMMIT_PAGE_EXECUTE_REFUSAL,
  EXECUTE_REFUSAL,
  type GuardState,
  isSpaceKey,
  looksLikePaymentStep,
  type NavigationAction,
  navigationVerdict,
  originOf,
  pageFactsScript,
  TOTAL_NOT_ANCHORED,
  USED_REFUSAL,
} from "../vault/pay-guard";
import { onSite, registrableDomain } from "../vault/site";
import { VAULT_UNAVAILABLE, type VaultField } from "../vault/vault-client";
import {
  cardField,
  codeFieldAllowed,
  DOCUMENT_INPUT_FACTS_SCRIPT,
  hasCodeField,
  factsFromDocument,
  fieldKindAllowed,
  httpsHost,
  LIVE_FIELD_FUNCTION,
  type DomNode,
  type FieldFacts,
  FILL_KINDS,
  type FillKind,
  fieldsOf,
  fieldUnsupported,
  formatExpiry,
  isPaymentFrameOrigin,
  NO_SIGNIN_REASON,
  planFill,
  SELECT_OPTION_FUNCTION,
  selectCandidates,
  readPageTotal,
  type PageTotal,
} from "../vault/vault-fill";
import {
  type PaymentApproval,
  type VaultSession,
  VaultSessions,
} from "../vault/vault-session";
import {
  VAULT_FILL_TOOL,
  VAULT_TOOL_NAMES,
  type Vault,
} from "../vault/vault-tools";
import {
  McpHttpServer,
  type McpToolListing,
  type McpToolResult as ToolResult,
} from "./mcp-http-server";
import {
  heldBrowserRefusal,
  onWatchHost,
  watchHostIsPublic,
  type HeldBrowserSession,
} from "./unattended-browser";

const NAVIGATE_TIMEOUT_MS = 20_000;
const WEBVIEW_ATTACH_TIMEOUT_MS = 15_000;
// The wait after a first attach timeout: long enough for a pane the renderer
// is opening, short enough that a session that can never have one answers fast.
const ATTACH_RETRY_GRACE_MS = 2_000;
// How long a `goto` insists on seeing the view leave before settling on the
// host check alone; a `goto` to the page already open never goes loading.
const NAVIGATE_START_GRACE_MS = 1_500;
// Shorter than a `goto` deadline: history moves go somewhere already visited.
const HISTORY_NAVIGATE_TIMEOUT_MS = 10_000;

/**
 * Said with a way out: a bare "unavailable" reads as bad luck and the model
 * retries through attach timeouts when `web_fetch` would have done in a second.
 */
const NO_BROWSER =
  "The browser preview is not available right now. Do not retry in a loop. " +
  "To read a public page use `web_fetch` with the URL, or `web_search` to find one; " +
  "neither needs a browser. Only if the task truly requires a browser (a signed-in app, " +
  "a form to fill) tell the user the browser pane did not open and ask them to try again.";
/** The same, for a chat with no pane (the phone). */
const NO_BROWSER_PANELESS =
  "The browser is not available right now. Do not retry in a loop. " +
  "To read a public page use `web_fetch` with the URL, or `web_search` to find one; " +
  "neither needs a browser. Only if the task truly requires a browser (a signed-in app, " +
  "a form to fill) tell the user the browser could not start and ask them to try again later.";
/** Owns the tab a chat screenshot is taken in, after the session's id. */
const CHAT_SCREENSHOT_OWNER = ":chat-screenshot";
const SERVER_NAME = "browser";
const SERVER_VERSION = "2.1.0";
const TEMP_DIR = path.join(abacusBotHome(), "temp");

const TOOLS_SCHEMA: Record<
  string,
  { description: string; inputSchema: Record<string, unknown> }
> = {
  browser_navigate: {
    description: [
      "Navigate the browser. goto loads a URL; back, forward and reload move through history.",
      "",
      "Put the query in the URL whenever the site allows it; one goto replaces a dozen clicks:",
      "  google.com/travel/flights?q=Flights from BLR to DEL on 2026-09-20 one way",
      "  google.com/maps/search/coffee+near+me   ·   amazon.in/s?k=usb+c+cable",
      "",
      "The result already lists the page's clickable elements with @eN refs, so you can act",
      "right away without a separate snapshot.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["goto", "back", "forward", "reload"],
          description: 'Navigation action; a call with only a url is a "goto"',
        },
        url: {
          type: "string",
          description: 'URL to navigate to (required for "goto")',
        },
      },
      required: [],
    },
  },
  browser_snapshot: {
    description: [
      "Read the page. Every element you can act on has an @eN ref that stays the same",
      "for as long as the element is on the page.",
      "",
      'snapshot:    the element tree. Add find:"Delhi" to list only elements whose label',
      "             matches, or interactive_only:true to drop plain text. Prefer find over",
      "             reading a whole tree.",
      "extract:     structured rows without writing JavaScript: selector (required), optional",
      '             fields {"price": ".price"} mapping names to selectors inside each row, limit.',
      "             A <table> comes back as rows of cells.",
      "screenshot:  an image of the viewport plus a short description of where the page is.",
      "text:        visible text, optionally scoped by selector.",
      "url / title: just that.",
      'find:        shorthand for snapshot with find:"..." (same result).',
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "snapshot",
            "extract",
            "screenshot",
            "text",
            "url",
            "title",
            "find",
          ],
          description: "What to read",
        },
        find: {
          type: "string",
          description:
            'snapshot only: list only elements whose label, placeholder or value contains this text (e.g. "Add to cart")',
        },
        interactive_only: {
          type: "boolean",
          description: "snapshot only: leave out plain text nodes",
        },
        selector: {
          type: "string",
          description:
            'CSS selector: the rows for "extract" (required there), or the region for "text"',
        },
        fields: {
          type: "object",
          description:
            'extract only: column name → selector inside each row, e.g. {"title":"h2","price":".a-price"}',
          additionalProperties: { type: "string" },
        },
        limit: {
          type: "number",
          description: "extract only: maximum rows (default 25, max 100)",
        },
      },
      required: ["action"],
    },
  },
  browser_interact: {
    description: [
      "Act on an element by its @eN ref. The result says what changed (new elements with",
      "their refs, a new URL, a dialog that appeared), so you rarely need",
      "another snapshot. Refs stay valid while the element exists.",
      "",
      "click:         click (params: ref)",
      "fill:          replace a field's text (params: ref, text)",
      "pick:          fill an autocomplete and choose the matching suggestion from its dropdown,",
      "               then confirm the field took it (params: ref, text). Use this for city,",
      "               airport, product and address boxes; plain fill leaves them unchanged.",
      "type:          append text without clearing (params: ref, text)",
      "select:        choose an option in a <select> (params: ref, value; option text works)",
      "press:         a key or combo (params: key, e.g. Enter, Escape, ArrowDown, Control+a)",
      "dismiss:       close the cookie banner, consent dialog or overlay on top of the page",
      "check / uncheck: a checkbox (params: ref)",
      "hover, focus, scroll_into_view: (params: ref)",
      "scroll:        the page or an element (params: direction, amount, optional ref)",
      "wait:          until text appears, a URL matches, or an element exists",
      "               (params: text | url_pattern | ref, amount = timeout ms). Use this instead",
      "               of snapshotting in a loop while results load.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "click",
            "fill",
            "pick",
            "type",
            "select",
            "press",
            "dismiss",
            "hover",
            "scroll",
            "scroll_into_view",
            "focus",
            "check",
            "uncheck",
            "wait",
          ],
          description: "Interaction action",
        },
        ref: {
          type: "string",
          description:
            'Element ref from a snapshot or a previous result, e.g. "@e3"',
        },
        selector: {
          type: "string",
          description:
            "Advanced: a CSS selector instead of a ref. Only when no ref exists for the element.",
        },
        text: {
          type: "string",
          description:
            "Text for fill/pick/type, or the text to wait for in wait",
        },
        value: {
          type: "string",
          description: "Option value or label for select",
        },
        key: {
          type: "string",
          description:
            'Key for press, e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+a"',
        },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction",
        },
        amount: {
          type: "number",
          description:
            "Scroll pixels (default 500) or wait timeout ms (default 5000)",
        },
        url_pattern: {
          type: "string",
          description: 'URL glob pattern for wait, e.g. "**/results**"',
        },
        total_ref: {
          type: "string",
          description:
            "For the Pay click of an approved payment: the ref of the element showing the order total. " +
            "Defaults to the one the card fill named.",
        },
      },
      required: ["action"],
    },
  },
  browser_execute: {
    description: [
      "Run JavaScript in the page and return the result. For anything browser_snapshot extract",
      "cannot express: shadow roots, iframes, computed styles. A bare expression is returned",
      "as-is; `return` also works.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript code to execute. Runs inside an async function; a bare expression or a return statement both work.",
        },
      },
      required: ["code"],
    },
  },
  browser_tabs: {
    description: [
      "The browser's tabs. A page that opens a new tab (a booking button, a link that opens",
      "elsewhere) moves the browser tools to it on its own; the action's result says so.",
      "",
      "list:   your tabs, with ids; the one marked active is the one the tools act on.",
      "switch: act on another tab (params: tab).",
      "close:  close a tab (params: tab; default the active one). The tools return to the",
      "        tab that opened it.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "switch", "close"],
          description: "What to do",
        },
        tab: {
          type: "number",
          description: "A tab id from list",
        },
      },
      required: ["action"],
    },
  },
};

/** Drop screenshots older than a day: nothing looks at yesterday's page. */
function pruneOldScreenshots(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(TEMP_DIR)) {
      const file = path.join(TEMP_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        /* raced with another prune, or unreadable: skip */
      }
    }
  } catch {
    /* directory missing; the capture will create it */
  }
}

function summarizeToolCall(
  tool: string,
  args: Record<string, unknown>
): string {
  const a = args ?? {};
  const action = typeof a.action === "string" ? a.action : undefined;
  switch (tool) {
    case "browser_navigate":
      if (action === "goto" && typeof a.url === "string")
        return `Open ${a.url}`;
      return `Navigate (${action ?? "unknown"})`;
    case "browser_snapshot":
      return `Read page state (${action ?? "snapshot"})`;
    case "browser_interact": {
      const target = (a.ref as string) ?? (a.selector as string) ?? "element";
      return `${action ?? "Interact with"} ${target}`;
    }
    case "browser_execute":
      return "Run JavaScript in the page";
    case "browser_tabs":
      return `Tabs (${action ?? "list"})`;
    case VAULT_FILL_TOOL:
      if (a.field === "login") return "Sign in with a saved login";
      return `Fill a saved ${typeof a.field === "string" ? a.field : "value"} into ${typeof a.ref === "string" ? a.ref : "a field"}`;
    case TRAVELER_FILL_TOOL:
      return `Fill a saved passport number into ${typeof a.ref === "string" ? a.ref : "a field"}`;
    default:
      return tool;
  }
}

/** A result's first text block, or "" when it starts with something else. */
const firstText = (result: ToolResult): string => {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
};

/** Pure-read tools; the permission gate skips these to avoid prompt fatigue. */
function isReadOnlyBrowserTool(
  name: string,
  args: Record<string, unknown>
): boolean {
  return (
    name === "browser_snapshot" ||
    (name === "browser_tabs" && (args.action ?? "list") === "list") ||
    // The vault's own tools touch no page: they list items or mint links the user acts on.
    (VAULT_TOOL_NAMES.includes(name) && name !== VAULT_FILL_TOOL) ||
    // A pause only reads the page; the checkout handle is the runtime's own.
    name === BROWSER_PAUSE_TOOL ||
    name === BROWSER_CHECKOUT_TOOL
  );
}

/** The link a click on `selector` would follow, resolved; null for none. */
const linkTargetScript = (selector: string): string => `(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  const link = el && el.closest('a[href], area[href]');
  if (link) return link.href;
  const form = el && el.form;
  return form ? form.action : null;
})()`;

/** The text of the element showing a total, for the host to read itself. */
const totalTextScript = (selector: string): string => `(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  return String(el.innerText || el.textContent || '').slice(0, 200);
})()`;

const ABACUS_REFUSAL =
  "Refused: Abacus.AI's own pages and APIs (the user's account, vault pages and payment approvals) are never " +
  "opened or acted on in this browser. Those links are for the user alone, on their own device.";

/** Keys that copy, cut or paste: never on a page holding a secret field. */
const isClipboardCombo = (key: string, mods: string[]): boolean => {
  const command = mods.some((mod) =>
    ["control", "ctrl", "meta", "command", "cmd"].includes(mod)
  );
  const main = key.toLowerCase();
  return (
    (command && ["c", "x", "v", "insert"].includes(main)) ||
    (mods.includes("shift") && (main === "insert" || main === "delete"))
  );
};

/** Remote objects one vault fill holds, released together. */
const VAULT_OBJECT_GROUP = "abacusai-vault-fill";

/**
 * Right before typing, in one evaluation in the node's own document: focus
 * and select the node, then report the document's live origin, the
 * top-level page's origin as the document sees it, and whether the node has
 * the focus now.
 */
const ARM_FUNCTION = `function() {
  if (!this.isConnected) return { focused: false };
  this.scrollIntoView({ block: 'center', behavior: 'instant' });
  this.focus();
  if (typeof this.select === 'function') this.select();
  const ancestors = location.ancestorOrigins;
  const top = ancestors && ancestors.length > 0 ? ancestors[ancestors.length - 1] : location.origin;
  return { focused: document.hasFocus() && document.activeElement === this, origin: location.origin, top: top };
}`;

/** Whether the node still has the focus, its document included; run on the node itself. */
const STILL_FOCUSED_FUNCTION = `function() { return document.hasFocus() && document.activeElement === this; }`;

/**
 * Empties the element that took text meant for another, and marks it
 * filled: whatever reached it is the user's secret.
 */
const CLEAR_FUNCTION = `function() {
  try {
    if (this.isContentEditable) this.textContent = '';
    else if ('value' in this) {
      const proto = Object.getPrototypeOf(this);
      const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (set) set.call(this, ''); else this.value = '';
    }
    this.dispatchEvent(new Event('input', { bubbles: true }));
  } catch {}
  return true;
}`;

interface FrameTreeNode {
  frame?: {
    id?: string;
    loaderId?: string;
    url?: string;
    securityOrigin?: string;
  };
  childFrames?: FrameTreeNode[];
}

/** Compares two tokens in constant time. */
const tokensMatch = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The checkout stages from the traveler details on, where a passport number may be typed. */
const TRAVELER_FILL_STAGES: ReadonlySet<string> = new Set([
  "details",
  "login",
  "review",
  "awaiting_approval",
  "card_fill",
  "bank_otp",
]);

/** A text field whose name, label or placeholder names a passport or ID document number. */
const passportField = (facts: FieldFacts): boolean =>
  !facts.wasPassword &&
  /^(text|search|tel)$/.test(facts.type) &&
  !facts.autocomplete.some((token) => token.startsWith("cc-")) &&
  /passport|travel\s*doc|document\s*(?:no|num|number|id)|id\s*(?:no|num|number)|national\s*id|pasaporte|passeport|reisepass|पासपोर्ट/i.test(
    facts.hints.join(" ")
  );

/** Input types a person types into: what "the page has no fields" counts. */
const LOGIN_TEXT_ENTRY: ReadonlySet<string> = new Set([
  "text",
  "email",
  "password",
  "tel",
  "number",
  "search",
  "url",
]);

/** How long a failed read of a saved login's sites is believed. */
const LOGIN_SITES_RETRY_MS = 60_000;

/** Why one login field was not filled, and whether it only waits on the user's sign-in approval. */
type LoginFieldFailure = { reason: string; awaitingApproval: boolean };

/** The saved login a browser run was handed, from browser_checkout's login_item_id. */
const loginItemOf = (
  args: Record<string, unknown>
): { itemId: string; sites: string[] | null; retryAt: number } | null =>
  typeof args.login_item_id === "string" &&
  /^[A-Za-z0-9_-]{1,128}$/.test(args.login_item_id)
    ? { itemId: args.login_item_id, sites: null, retryAt: 0 }
    : null;

/** The card details the vault may not have (an older server, or not saved with the card). */
const CARD_DETAILS: ReadonlySet<VaultField> = new Set([
  "card_exp_month",
  "card_exp_year",
  "cardholder_name",
]);

/** A card detail the vault cannot give, left to the user, never guessed. */
const CARD_DETAIL_UNSUPPORTED =
  "The vault cannot fill the card's expiry or the name on it (not supported, or not saved with the card), so " +
  "nothing was typed. Do not type or guess " +
  'them yourself: stop with browser_pause need:"user" and ask the user to complete the expiry and name on the ' +
  "page themselves.";

export interface McpBrowserServerOptions {
  /** Gate consulted before each tool call; when omitted, nothing is gated. */
  requestPermission?: (
    tool: string,
    summary: string,
    sessionId?: string
  ) => Promise<"allow" | "deny">;
  /** The waits, sized for a cold first launch; tests override them. */
  timeouts?: {
    attachMs?: number;
    navigateMs?: number;
    historyMs?: number;
    /** How long one call may run, queue wait included. */
    callMs?: number;
  };
  /** The browser runtime's views, resolved per call so a late attach counts. */
  target?: () => BrowserTargetSource | null;
  /** The conversation a session's browser belongs to; picks the pane opened. */
  conversationKeyForSession?: (sessionId: string) => ConversationKey | null;
  /** Where screenshots are kept for `send_media`; without one they get no media id. */
  media?: () => MediaStore | null;
  /** The user's vault: its tools are served here, beside the page they read origins from. */
  vault?: Vault;
  /** What a host lane's chat can do (the phone); null for every other session. */
  channelForSession?: (sessionId: string) => ChannelCapabilities | null;
  /**
   * Whether the session is the user's own (not a bot's sender or routine
   * chat): only those fill saved traveler details. Absent, none do.
   */
  isOwnerSession?: (sessionId: string) => boolean;
  /**
   * The capability the agent runtime's own client presents on
   * `browser_checkout`, handed to it at spawn. Absent, the tool refuses.
   */
  checkoutToken?: string;
  /** A session that runs unattended, held to its one page; null for any other. */
  heldSession?: (sessionId: string) => HeldBrowserSession | null;
}

/** A read refused because the page's secret fields could not be checked first. */
class UnreadablePageError extends Error {
  constructor() {
    super(
      "The page's password, card and code fields could not be checked, so it was not read. Try again once the page has loaded."
    );
  }
}

export class McpBrowserServer extends McpHttpServer {
  /** The last snapshot's refs, per session. See SnapshotStore. */
  private readonly snapshots = new SnapshotStore();

  constructor(private readonly options: McpBrowserServerOptions = {}) {
    super({ name: SERVER_NAME, version: SERVER_VERSION });
  }

  stop(): void {
    // Refs, the remembered view and the attach verdict all describe a browser
    // that is about to stop existing.
    this.snapshots.clearAll();
    this.frameNumbers.clear();
    this.targetMemory.clear();
    this.attachTimedOut.clear();
    super.stop();
  }

  protected listTools(): McpToolListing[] {
    return [
      ...Object.entries(TOOLS_SCHEMA).map(([name, s]) => ({
        name,
        description: s.description,
        inputSchema: s.inputSchema,
      })),
      ...(this.options.vault?.listings() ?? []),
      ...CHECKOUT_TOOL_LISTINGS,
    ];
  }

  /** Sessions whose full attach wait already expired; see getWC. */
  private readonly attachTimedOut = new Set<string>();

  private attachKey(sessionId?: string): string {
    return sessionId ?? "";
  }

  /** The view each session settled on, and the last URL it navigated. */
  private readonly targetMemory = new Map<string, BrowserTargetMemory>();

  private memoryFor(sessionId?: string): BrowserTargetMemory {
    const key = sessionId ?? "";
    let memory = this.targetMemory.get(key);
    if (memory == null) {
      memory = { id: null, url: null };
      this.targetMemory.set(key, memory);
    }
    return memory;
  }

  private remember(
    sessionId: string | undefined,
    id: number,
    url?: string
  ): void {
    const memory = this.memoryFor(sessionId);
    memory.id = id;
    if (url != null) memory.url = url;
  }

  /** The session's own view, if the runtime has one alive. */
  private findView(sessionId?: string): BrowserPage | null {
    const source = this.options.target?.() ?? null;
    if (source == null) return null;

    let candidates;
    try {
      candidates = source.candidates();
    } catch {
      return null;
    }
    const memory = this.memoryFor(sessionId);
    const chosen = pickBrowserTarget(candidates, memory, sessionId ?? null);
    if (chosen == null) return null;

    const wc = source.webContents(chosen);
    if (wc == null || wc.isDestroyed()) return null;
    memory.id = wc.id;
    if (sessionId != null) source.noteUse?.(sessionId);

    return wc;
  }

  /**
   * Where `wc` sits among the session's tabs, when it has more than one: the
   * model must know the page it acts on was opened from another.
   */
  private tabLine(wc: BrowserPage, sessionId?: string): string | null {
    if (sessionId == null) return null;
    const tabs = this.options.target?.()?.sessionTabs?.(sessionId) ?? [];
    if (tabs.length < 2) return null;
    const tab = tabs.find((item) => item.id === wc.id);
    if (tab == null) return null;
    const opener = tabs.find((item) => item.id === tab.openerId);
    const from =
      opener == null
        ? ""
        : ` Opened from tab ${opener.id} ("${opener.title || opener.url}"), which stays open as it was.`;
    return `Active tab ${tab.id} of ${tabs.length} open (browser_tabs lists them).${from}`;
  }

  /** Secret fields of pages whose source keeps none per tab (the built-in view). */
  private readonly pageSecrets = new WeakMap<BrowserPage, SecretFields>();

  private secretsOf(wc: BrowserPage): SecretFields {
    const kept = this.options.target?.()?.secrets?.(wc.id);
    if (kept != null) return kept;
    let secrets = this.pageSecrets.get(wc);
    if (secrets == null) {
      secrets = new SecretFields();
      this.pageSecrets.set(wc, secrets);
    }
    return secrets;
  }

  /**
   * The page with its secret fields hidden and foreign frames covered; the
   * one way a screenshot is taken. A source that knows its tabs' live origins
   * captures; the built-in view covers what its page cannot reach.
   */
  private async captureImage(wc: BrowserPage): Promise<CapturedImage | null> {
    const source = this.options.target?.();
    const secrets = this.secretsOf(wc);
    if (source?.captureMasked != null)
      return source.captureMasked(wc.id, secrets);
    return secrets.captureMasked(wc);
  }

  /**
   * Runs a script that reads values out of the page, with every field known
   * secret marked again first, so a page that stripped the marks does not
   * get a field read out. When the marks cannot be put back, nothing is read.
   */
  private async readPage(wc: BrowserPage, expression: string): Promise<any> {
    try {
      await this.secretsOf(wc).reassert(wc);
    } catch {
      throw new UnreadablePageError();
    }
    return this.evalJS(wc, expression);
  }

  /**
   * A handle for the screenshot in the media store, held for the calling
   * session; null without a store or a session, or for an image larger than
   * a chat takes (a viewport JPEG is far below it).
   */
  private keepAsMedia(image: CapturedImage, sessionId?: string): string | null {
    const store = this.options.media?.() ?? null;
    if (store == null || sessionId == null) return null;
    const kept = store.put(sessionId, Buffer.from(image.data, "base64"));
    return "id" in kept ? kept.id : null;
  }

  /**
   * A screenshot of a page the agent served at `origin` (loopback), with
   * secret fields hidden, kept as `sessionId`'s media: how a served page
   * reaches a chat whose user cannot open it. Taken in a tab of its own
   * under a separate owner, opened blank, told to block Abacus.AI's hosts
   * (or nothing is loaded), and captured only while its live origin is
   * still `origin`. Every tab that owner has, a popup included, is closed
   * after, so the session's own tabs stay as they were.
   */
  async screenshotForChat(
    url: string,
    origin: string,
    sessionId: string
  ): Promise<{ id: string } | { reason: string }> {
    const failed = { reason: "the page could not be captured." };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return failed;
    }
    if (
      parsed.origin !== origin ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    )
      return failed;
    // In the session's own queue, like any of its browser calls; a call that
    // timed out while waiting never starts.
    const call = { cancelled: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.inSessionOrder(sessionId, () =>
          call.cancelled
            ? Promise.resolve(failed)
            : this.captureServed(url, origin, sessionId)
        ),
        new Promise<{ reason: string }>((resolve) => {
          timer = setTimeout(() => {
            call.cancelled = true;
            resolve(failed);
          }, this.callTimeout());
        }),
      ]);
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  /** `screenshotForChat`'s work, run in the session's queue. */
  private async captureServed(
    url: string,
    origin: string,
    sessionId: string
  ): Promise<{ id: string } | { reason: string }> {
    const unavailable = {
      reason: "no browser is available here to take a screenshot of it.",
    };
    const failed = { reason: "the page could not be captured." };
    const source = this.options.target?.() ?? null;
    if (source == null || this.options.media?.() == null) return unavailable;
    const owner = `${sessionId}${CHAT_SCREENSHOT_OWNER}`;
    let tabId: number | null = null;
    try {
      tabId = await source.materialize(owner, "about:blank");
      const wc = tabId == null ? null : source.webContents(tabId);
      if (wc == null || wc.isDestroyed()) return unavailable;
      if (!(await this.blockAbacus(wc))) return failed;
      await Promise.race([
        wc.loadURL(url),
        new Promise((resolve) => setTimeout(resolve, NAVIGATE_TIMEOUT_MS)),
      ]).catch(() => undefined);
      await this.settle(wc, NAVIGATE_TIMEOUT_MS);
      // The fence's own check, on the live document: still the served page.
      const live = await this.liveOrigin(wc);
      if (live !== origin || this.isAbacus(live)) return failed;
      const image = await this.captureImage(wc);
      if (image == null) return failed;
      const id = this.keepAsMedia(image, sessionId);
      return id != null ? { id } : { reason: "the screenshot is too large." };
    } catch (error) {
      console.error(
        `[mcp-browser] chat screenshot failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return failed;
    } finally {
      const tabs = new Set(
        (source.sessionTabs?.(owner) ?? []).map((tab) => tab.id)
      );
      if (tabId != null) tabs.add(tabId);
      for (const tab of tabs)
        await source.closeTab?.(owner, tab).catch(() => false);
      source.releaseSession?.(owner);
    }
  }

  /** Why there is no browser, worded for the caller's chat. */
  private noBrowser(sessionId?: string): string {
    const channel =
      sessionId == null
        ? null
        : (this.options.channelForSession?.(sessionId) ?? null);
    return channel?.pane === false ? NO_BROWSER_PANELESS : NO_BROWSER;
  }

  private async executeTabs(
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const source = this.options.target?.() ?? null;
    if (source?.sessionTabs == null || sessionId == null)
      return this.err(
        "This browser has one page per conversation; there are no other tabs."
      );
    const action = typeof args.action === "string" ? args.action : "list";
    const list = (): string => {
      const tabs = source.sessionTabs?.(sessionId) ?? [];
      if (tabs.length === 0) return "No tabs open yet.";
      return tabs
        .map(
          (tab) =>
            `tab ${tab.id}${tab.current ? " [active]" : ""}: ${tab.title || "(untitled)"} - ${tab.url}` +
            (tab.openerId != null ? ` (opened from tab ${tab.openerId})` : "")
        )
        .join("\n");
    };
    if (action === "list") return this.ok(list());
    const active = (source.sessionTabs(sessionId) ?? []).find(
      (tab) => tab.current
    );
    const tabId =
      typeof args.tab === "number"
        ? args.tab
        : action === "close"
          ? active?.id
          : undefined;
    if (tabId == null) return this.err(`${action} needs a tab id from list.`);
    if (action === "switch") {
      if (!(await source.activateTab?.(sessionId, tabId)))
        return this.err(`There is no tab ${tabId}. Tabs:\n${list()}`);
      const wc = this.findView(sessionId);
      if (wc == null) return this.err(this.noBrowser(sessionId));
      return this.ok(
        await this.arrival(
          wc,
          sessionId,
          `Now driving tab ${tabId}: ${wc.getURL()}`
        )
      );
    }
    if (action === "close") {
      if (!(await source.closeTab?.(sessionId, tabId)))
        return this.err(`There is no tab ${tabId}. Tabs:\n${list()}`);
      const wc = this.findView(sessionId);
      return this.ok(
        wc == null
          ? `Closed tab ${tabId}. No tabs are open.`
          : `Closed tab ${tabId}. Now driving tab ${wc.id}: ${wc.getURL()}`
      );
    }
    return this.err(
      `Unknown tabs action: ${action}. Use list, switch or close.`
    );
  }

  /** Whether the pages are the app's own pane, which the renderer shows and animates. */
  private presentsInApp(): boolean {
    return this.options.target?.()?.presentsInApp !== false;
  }

  private emitPreviewEvent(url?: string, sessionId?: string): void {
    if (!this.presentsInApp()) return;
    const conversationKey =
      sessionId == null
        ? null
        : (this.options.conversationKeyForSession?.(sessionId) ?? null);
    emitHostEvent({
      type: "mcp-open-preview",
      url,
      ...(conversationKey == null ? {} : { conversationKey }),
      emittedAt: new Date().toISOString(),
    });
  }

  /**
   * Block until the view has finished going somewhere, or the deadline passes.
   * Returns the URL it settled on, or null. `targetHost` is null for history
   * navigation, which has no destination to check.
   */
  private async awaitNavigation(
    wc: BrowserPage,
    startUrl: string,
    targetHost: string | null,
    timeoutMs: number
  ): Promise<string | null> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    // A grace longer than the deadline can never elapse, and the wait would
    // report a failure for a navigation that had arrived.
    const grace = Math.min(NAVIGATE_START_GRACE_MS, timeoutMs / 2);
    // `loadURL` and `goBack` are asynchronous: the first poll can run before
    // the view has begun leaving.
    let sawLoading = false;

    while (Date.now() < deadline) {
      const loading = wc.isLoading();
      if (loading) sawLoading = true;
      const current = wc.getURL();

      if (
        navigationSettled({
          loading,
          currentUrl: current,
          startUrl,
          targetHost,
          sawLoading,
          elapsedMs: Date.now() - startedAt,
          graceMs: grace,
        })
      ) {
        return current;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return null;
  }

  /**
   * Go back, forward, or reload, and report where it ended up. All three are
   * asynchronous, so success is decided by the settled URL, not the call.
   */
  private async historyNavigate(
    wc: BrowserPage,
    what: "back" | "forward" | "reload",
    go: () => void,
    sessionId?: string
  ): Promise<ToolResult> {
    const startUrl = wc.getURL();

    go();

    const landed = await this.awaitNavigation(
      wc,
      startUrl,
      null,
      this.historyTimeout()
    );
    this.onNavigated();

    const done = what === "reload" ? "Page reloaded" : `Navigated ${what}`;

    if (landed == null) {
      return this.ok(
        `${done}, but it had not finished after ${this.historyTimeout() / 1000}s ` +
          `(preview is at ${wc.getURL()}). Snapshot to see where it actually is.`
      );
    }

    return this.ok(await this.arrival(wc, sessionId, `${done} to ${landed}.`));
  }

  /**
   * Drive the preview to a URL and report where it landed. `emitPreviewEvent`
   * and `loadURL` race, and the loser is aborted, so awaiting `loadURL` alone
   * never settles; success is decided by where the webContents ended up.
   */
  private async navigateTo(
    wc: BrowserPage,
    url: string,
    sessionId?: string
  ): Promise<ToolResult> {
    const target = new URL(url);
    const startUrl = wc.getURL();

    this.emitPreviewEvent(url, sessionId);

    // Chromium serves its error page at the URL that failed, so landing on the
    // host proves nothing; only `did-fail-load` knows. ERR_ABORTED (-3) is the
    // normal outcome for the losing racer of two navigations, not a failure.
    let failure: string | null = null;
    const onFailLoad = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      _failedUrl: string,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame && errorCode !== -3) {
        failure = `${errorDescription} (${errorCode})`;
      }
    };
    wc.on("did-fail-load", onFailLoad);

    wc.loadURL(url).catch(() => {
      // Interrupted by the renderer's own navigation to the same URL. Expected.
    });

    const landed = await this.awaitNavigation(
      wc,
      startUrl,
      target.host,
      this.navigateTimeout()
    );
    if (!wc.isDestroyed()) wc.off("did-fail-load", onFailLoad);

    if (failure != null) {
      this.onNavigated();

      return this.err(
        `${url} did not load: ${failure}. The site refused the request or is unreachable. Try a different source.`
      );
    }

    if (landed != null) {
      this.onNavigated();
      // Remember both so later calls drive this view, by URL after a remount.
      this.remember(sessionId, wc.id, landed);

      return this.ok(
        await this.arrival(wc, sessionId, `Navigated to ${landed}.`)
      );
    }

    const current = wc.getURL();
    this.onNavigated();

    return this.err(
      `Navigation to ${url} did not complete within ${this.navigateTimeout() / 1000}s (preview is at ${current}). ` +
        "The page may still be loading. Take a snapshot to check."
    );
  }

  /**
   * The view this session drives, creating one when it has none. A session
   * gets its own hidden browser from the runtime, so a bot never touches what
   * is on screen; only a caller with no session id uses the renderer's pane.
   */
  private async getWC(
    sessionId?: string,
    navigateUrl?: string
  ): Promise<BrowserPage | null> {
    const attachKey = this.attachKey(sessionId);
    let wc = this.findView(sessionId);
    if (wc != null) {
      this.attachTimedOut.delete(attachKey);

      return wc;
    }

    const source = this.options.target?.() ?? null;
    if (source == null) return null;

    if (sessionId != null) {
      try {
        const id = await source.materialize(
          sessionId,
          navigateUrl ?? "about:blank"
        );
        if (id != null) {
          wc = source.webContents(id);
          if (wc != null && !wc.isDestroyed()) {
            this.remember(sessionId, wc.id);
            this.attachTimedOut.delete(attachKey);

            return wc;
          }
        }
      } catch (error) {
        console.error(
          `[mcp-browser] could not create a browser view for session ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    // No session to own a view: ask the renderer for its pane and wait,
    // briefly once it has already failed to appear.
    const grace = this.attachTimedOut.has(attachKey)
      ? Math.min(ATTACH_RETRY_GRACE_MS, this.attachTimeout())
      : this.attachTimeout();

    this.emitPreviewEvent(navigateUrl ?? "about:blank", sessionId);

    const deadline = Date.now() + grace;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      wc = this.findView(sessionId);
      if (wc != null) {
        this.attachTimedOut.delete(attachKey);

        return wc;
      }
    }

    if (!this.attachTimedOut.has(attachKey)) {
      console.error(
        `[mcp-browser] no browser view appeared within ${grace}ms for session ${sessionId ?? "(none)"}`
      );
    }
    this.attachTimedOut.add(attachKey);

    return null;
  }

  private attachTimeout(): number {
    return this.options.timeouts?.attachMs ?? WEBVIEW_ATTACH_TIMEOUT_MS;
  }
  private navigateTimeout(): number {
    return this.options.timeouts?.navigateMs ?? NAVIGATE_TIMEOUT_MS;
  }
  private historyTimeout(): number {
    return this.options.timeouts?.historyMs ?? HISTORY_NAVIGATE_TIMEOUT_MS;
  }

  private async cdp(
    wc: BrowserPage,
    method: string,
    params?: Record<string, unknown>
  ): Promise<any> {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    return wc.debugger.sendCommand(method, params);
  }

  /**
   * Keys the browser needs told about by name and virtual key code; anything
   * absent is a printable character CDP derives from the text.
   */
  private static readonly NAMED_KEYS: Record<
    string,
    { code: string; keyCode: number }
  > = {
    Enter: { code: "Enter", keyCode: 13 },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    PageUp: { code: "PageUp", keyCode: 33 },
    PageDown: { code: "PageDown", keyCode: 34 },
    Space: { code: "Space", keyCode: 32 },
  };

  /** CDP's modifier bitmask. */
  private static modifierMask(mods: string[]): number {
    let mask = 0;
    if (mods.includes("alt")) mask |= 1;
    if (mods.includes("control") || mods.includes("ctrl")) mask |= 2;
    if (mods.includes("meta") || mods.includes("command")) mask |= 4;
    if (mods.includes("shift")) mask |= 8;

    return mask;
  }

  /**
   * Send a key the way the keyboard would: a printable character as `keyDown`
   * with `text`, a named key with its virtual key code so Enter submits.
   */
  private async dispatchTrustedKey(
    wc: BrowserPage,
    key: string,
    mods: string[]
  ): Promise<void> {
    const modifiers = McpBrowserServer.modifierMask(mods);
    const named = McpBrowserServer.NAMED_KEYS[key];
    const isPrintable = named == null && [...key].length === 1;

    if (named == null && !isPrintable) {
      throw new Error(`Unsupported key: ${key}`);
    }

    // A view the user never clicked into is not focused, and input events to
    // it are silently dropped; assert focus or every keystroke goes nowhere.
    wc.focus();

    // A one-shot capture listener, so the check below is about this key.
    await this.evalJS(
      wc,
      `(function() {
      window.__abacusBotKeySeen = undefined;
      // Kept on window so the check below can take it off again: a key that
      // never arrives leaves the listener registered, and one press per failed
      // attempt accumulates on a page the agent keeps trying.
      if (window.__abacusBotKeyProbe) window.removeEventListener('keydown', window.__abacusBotKeyProbe, true);
      const probe = (e) => {
        window.__abacusBotKeySeen = e.key;
        window.removeEventListener('keydown', probe, true);
        window.__abacusBotKeyProbe = undefined;
      };
      window.__abacusBotKeyProbe = probe;
      window.addEventListener('keydown', probe, true);
    })()`
    );

    const base =
      named != null
        ? {
            key,
            code: named.code,
            windowsVirtualKeyCode: named.keyCode,
            nativeVirtualKeyCode: named.keyCode,
          }
        : { key, text: key, unmodifiedText: key };

    await this.cdp(wc, "Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers,
      ...base,
    });
    await this.cdp(wc, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers,
      ...base,
    });

    // Ask the page whether it saw the key; an unfocused view reports nothing
    // and the caller falls back to synthetic events.
    const delivered = await this.evalJS(
      wc,
      `(function() {
      const seen = window.__abacusBotKeySeen === ${JSON.stringify(key)};
      window.__abacusBotKeySeen = undefined;
      if (window.__abacusBotKeyProbe) {
        window.removeEventListener('keydown', window.__abacusBotKeyProbe, true);
        window.__abacusBotKeyProbe = undefined;
      }
      return seen;
    })()`
    ).catch(() => false);

    if (delivered !== true) throw new Error("Key event was not delivered");
  }

  /** How long an action gets for its consequences to land before they are reported. */
  private static readonly SETTLE_QUIET_MS = 300;
  private static readonly SETTLE_MAX_MS = 2_500;

  private async settle(
    wc: BrowserPage,
    maxMs = McpBrowserServer.SETTLE_MAX_MS
  ): Promise<void> {
    const deadline = Date.now() + maxMs;
    // A click that navigates destroys the page context mid-wait.
    while (wc.isLoading() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const remaining = Math.max(200, deadline - Date.now());
    await this.evalJS(
      wc,
      settleScript(McpBrowserServer.SETTLE_QUIET_MS, remaining)
    ).catch(() => undefined);
  }

  /** A fresh snapshot, with the session's refs replaced by it. */
  private async takeSnapshot(
    wc: BrowserPage,
    sessionId?: string
  ): Promise<{
    title: string;
    url: string;
    tree: SnapshotNode | null;
    refCount: number;
    visibleCount: number;
    offscreenCount: number;
    overlays?: SnapshotOverlay[];
  }> {
    const result = await this.readPage(wc, SNAPSHOT_BUILD_JS);
    // A reply that is not a snapshot must not wipe the refs the session holds.
    if (result == null || typeof result !== "object") {
      return {
        title: wc.getTitle(),
        url: wc.getURL(),
        tree: null,
        refCount: 0,
        visibleCount: 0,
        offscreenCount: 0,
      };
    }
    const state = this.snapshots.for(sessionId);
    let frameRefs = 0;
    if (result.tree != null) {
      state.refMap.clear();
      state.frameOf.clear();
      extractRefMap(result.tree, state.refMap);
      state.url = typeof result.url === "string" ? result.url : wc.getURL();
      await this.recordFields(wc, result.tree);
      for (const frame of await this.frameSnapshots(wc)) {
        const refs = new Map<string, string>();
        extractRefMap(frame.tree, refs);
        for (const [ref, selector] of refs) {
          state.refMap.set(ref, selector);
          state.frameOf.set(ref, frame.frameId);
        }
        frameRefs += refs.size;
        result.tree.children = [
          ...(result.tree.children ?? []),
          { tag: "frame", name: frame.origin ?? "", children: [frame.tree] },
        ];
      }
    }
    if (typeof result.title !== "string") result.title = wc.getTitle();
    if (typeof result.url !== "string") result.url = wc.getURL();
    if (typeof result.refCount !== "number")
      result.refCount = state.refMap.size;
    else result.refCount += frameRefs;
    if (typeof result.visibleCount !== "number")
      result.visibleCount = result.refCount;
    else result.visibleCount += frameRefs;
    if (typeof result.offscreenCount !== "number") result.offscreenCount = 0;
    if (!Array.isArray(result.overlays)) result.overlays = [];

    return result;
  }

  /** Numbers for the frames' refs (`@f2e5`), kept per frame so a frame's refs stay stable. */
  private readonly frameNumbers = new Map<string, number>();

  /**
   * The trees of the tab's cross-origin frames (a payment provider's card
   * fields), where the source can reach them; a frame that does not answer
   * in time is left out.
   */
  private async frameSnapshots(
    wc: BrowserPage
  ): Promise<
    Array<{ frameId: string; origin: string | null; tree: SnapshotNode }>
  > {
    const source = this.options.target?.();
    if (source?.frames == null || source.framePage == null || wc.frameId)
      return [];
    const snapshots: Array<{
      frameId: string;
      origin: string | null;
      tree: SnapshotNode;
    }> = [];
    for (const frame of source
      .frames(wc.id)
      .slice(0, McpBrowserServer.MAX_SNAPSHOT_FRAMES)) {
      const page = source.framePage(wc.id, frame.frameId);
      // A frame whose live origin cannot be read, or is Abacus.AI's, is left out.
      const origin = await this.liveOrigin(wc, frame.frameId);
      if (page == null || origin == null || this.isAbacus(origin)) continue;
      let number = this.frameNumbers.get(frame.frameId);
      if (number == null) {
        number = this.frameNumbers.size + 1;
        this.frameNumbers.set(frame.frameId, number);
      }
      const read = this.readPage(page, frameSnapshotScript(number)).catch(
        () => null
      );
      const result = await Promise.race([
        read,
        new Promise<null>((resolve) =>
          setTimeout(
            () => resolve(null),
            McpBrowserServer.FRAME_SNAPSHOT_MS
          ).unref?.()
        ),
      ]);
      if (result?.tree != null && typeof result.tree === "object") {
        await this.recordFields(page, result.tree as SnapshotNode);
        snapshots.push({
          frameId: frame.frameId,
          origin,
          tree: result.tree as SnapshotNode,
        });
      }
    }
    return snapshots;
  }

  /**
   * Records the document's inputs as they are when first seen (by backend
   * node id, read from the DOM, not by a script), for a vault fill to check
   * a field against what it was before anything the agent did.
   */
  private async recordFields(
    page: BrowserPage,
    tree: SnapshotNode
  ): Promise<void> {
    if (
      !flattenNodes(tree).some(
        (node) => node.tag === "input" || node.tag === "select"
      )
    )
      return;
    const document = (await this.cdp(page, "DOM.getDocument", {
      depth: -1,
    }).catch(() => null)) as { root?: DomNode } | null;
    if (document?.root == null) return;
    this.secretsOf(page).recordFields(page, factsFromDocument(document.root));
  }

  private static readonly MAX_SNAPSHOT_FRAMES = 4;
  private static readonly FRAME_SNAPSHOT_MS = 3_000;

  /**
   * The page a ref lives in: the tab's own, or the cross-origin frame its
   * snapshot found it in. Null when that frame is gone.
   */
  private pageForRef(
    wc: BrowserPage,
    ref: unknown,
    sessionId?: string
  ): BrowserPage | null {
    if (typeof ref !== "string") return wc;
    const frameId = this.snapshots.for(sessionId).frameOf.get(ref);
    if (frameId == null) return wc;
    return this.options.target?.()?.framePage?.(wc.id, frameId) ?? null;
  }

  private captureBefore(
    wc: BrowserPage,
    sessionId?: string
  ): { url: string; title: string; refs: Map<string, string> } {
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      refs: new Map(this.snapshots.for(sessionId).refMap),
    };
  }

  /** What an action did to the page: URL, new elements with refs, overlays. */
  private async reportChanges(
    wc: BrowserPage,
    sessionId: string | undefined,
    before: { url: string; title: string; refs: Map<string, string> }
  ): Promise<string> {
    await this.settle(wc);

    // The action opened a tab, and it is the session's active one now.
    const now = this.findView(sessionId);
    if (now != null && now.id !== wc.id) {
      const tabs = this.tabLine(now, sessionId);
      return this.arrival(
        now,
        sessionId,
        `New tab opened: now driving ${now.getURL()}` +
          (tabs != null ? `\n${tabs}` : "")
      );
    }

    let result: Awaited<ReturnType<McpBrowserServer["takeSnapshot"]>>;
    try {
      result = await this.takeSnapshot(wc, sessionId);
    } catch {
      return `Now at ${wc.getURL()}. The page is still loading; wait, then snapshot.`;
    }
    if (result.tree == null) return "";

    const lines: string[] = [];
    if (result.url !== before.url) lines.push(`Now at ${result.url}`);
    if (result.title !== before.title && result.title.length > 0)
      lines.push(`Title: ${result.title}`);

    const { added, removed } = diffRefs(before.refs, result.tree);
    const shown = added.slice(0, 15);
    if (shown.length > 0) {
      lines.push(
        `${added.length} new element${added.length === 1 ? "" : "s"}${added.length > shown.length ? ` (first ${shown.length})` : ""}:`
      );
      for (const node of shown)
        lines.push(formatTree({ ...node, children: undefined }, 1));
    }
    if (removed > 0)
      lines.push(`${removed} element${removed === 1 ? "" : "s"} gone`);

    const overlays = formatOverlays(result.overlays);
    if (overlays.length > 0) lines.push(overlays);
    if (result.url !== before.url) {
      const hint = await this.loginHint(wc, sessionId).catch(() => null);
      if (hint != null) lines.push(hint);
    }

    if (lines.length === 0)
      return "Nothing visible changed yet. If results were expected, use interact wait with text or url_pattern.";

    return `Changes:\n${lines.join("\n")}`;
  }

  /** What a page looks like on arrival: its clickable elements and any overlay. */
  private async arrival(
    wc: BrowserPage,
    sessionId: string | undefined,
    headline: string
  ): Promise<string> {
    const lines = [headline];
    const tip = recipeFor(wc.getURL());

    try {
      await this.settle(wc, 1_500);
      const result = await this.takeSnapshot(wc, sessionId);
      if (result.title.length > 0) lines.push(`Page: ${result.title}`);
      const overlays = formatOverlays(result.overlays);
      if (overlays.length > 0) lines.push(overlays);
      const compact = filterSnapshot(
        result.tree,
        { interactiveOnly: true },
        40
      );
      if (compact.count > 0) {
        lines.push(
          `${compact.count} interactive element${compact.count === 1 ? "" : "s"}${compact.count > 40 ? " (first 40)" : ""}:`
        );
        lines.push(compact.text);
        lines.push(
          'Act on these refs directly, or browser_snapshot with find:"..." for anything not listed.'
        );
      } else {
        lines.push(
          "No interactive elements yet. The page may still be loading. Use interact wait, then snapshot."
        );
      }
    } catch {
      lines.push("The page is still loading. Wait, then take a snapshot.");
    }

    const hint = await this.loginHint(wc, sessionId).catch(() => null);
    if (hint != null) lines.push(hint);
    if (tip != null) lines.push(`Tip for this site: ${tip}`);

    return lines.join("\n");
  }

  /**
   * Fill an autocomplete and choose from its dropdown in one call; typing
   * alone leaves such a field on its old value.
   */
  private async pick(
    wc: BrowserPage,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const text = typeof args.text === "string" ? args.text : "";
    if (text.trim().length === 0)
      return this.err('"text" is required for pick.');
    const resolved = this.target(args, sessionId);
    if (resolved.kind !== "selector")
      return this.err(
        this.refError(args, this.snapshots.for(sessionId).refMap.size)
      );
    const sel = resolved.selector;
    const label = this.label(args);

    if (await this.isSelect(wc, sel))
      return this.err(
        `${label} is a dropdown: choose its option with action "select".`
      );
    const before = this.captureBefore(wc, sessionId);
    await this.animateCursorToElement(wc, sel).catch(() => {});
    this.animateCursorClick();
    const filled = await this.evalJS(wc, fillScript(sel, text));
    if (filled?.status === "not_found")
      return this.err(this.notFoundError(args, sel));
    if (filled?.status !== "ok" && filled?.status !== "rejected") {
      return this.err(
        `${label} cannot be typed into (${filled?.status ?? "unknown"}). Take a snapshot and aim at the input itself.`
      );
    }
    // Many sites open suggestions on a keystroke, not a value assignment.
    await this.guardedPress(wc, wc, "ArrowDown", sessionId).catch(() => null);
    await this.settle(wc);

    let result: Awaited<ReturnType<McpBrowserServer["takeSnapshot"]>>;
    try {
      result = await this.takeSnapshot(wc, sessionId);
    } catch {
      return this.err(
        `Filled ${label}, but the page navigated before a suggestion could be chosen.`
      );
    }
    const { added } = diffRefs(before.refs, result.tree);
    const options = added.filter(
      (node) => node.ref != null && (node.name ?? "").trim().length > 0
    );
    const choice = chooseOption(options, text);

    if (choice?.selector != null) {
      const picked = await this.guardedClick(
        wc,
        wc,
        choice.selector,
        sessionId
      ).catch(() => null);
      if (picked != null && "refused" in picked)
        return this.err(picked.refused);
      const clicked = picked?.result;
      if (clicked?.status !== "ok") {
        return this.err(
          `Found suggestion "${choice.name}" but could not click it. Options seen: ${options
            .slice(0, 8)
            .map((node) => `${node.ref} "${node.name}"`)
            .join(", ")}`
        );
      }
    } else {
      // No dropdown surfaced: accept the highlighted suggestion, if any.
      const accepted = await this.guardedPress(
        wc,
        wc,
        "Enter",
        sessionId,
        undefined,
        {
          synthetic: false,
        }
      ).catch(() => null);
      if (accepted != null && "refused" in accepted)
        return this.err(accepted.refused);
    }

    await this.settle(wc);
    const value = String(
      (await this.readPage(wc, valueScript(sel)).catch(() => "")) ?? ""
    );
    const firstWord = (text.trim().split(/[\s,]+/)[0] ?? "").toLowerCase();
    const took =
      value.length > 0 &&
      (choice != null
        ? value.toLowerCase().includes(firstWord) ||
          (choice.name ?? "")
            .toLowerCase()
            .includes(value.toLowerCase().slice(0, 12))
        : value.toLowerCase().includes(firstWord));

    const changes = await this.reportChanges(wc, sessionId, before);
    const seen =
      options.length > 0
        ? ` Suggestions were: ${options
            .slice(0, 8)
            .map((node) => `${node.ref} "${node.name}"`)
            .join(", ")}.`
        : " No suggestion list appeared.";

    if (!took) {
      return this.err(
        `Typed "${text}" into ${label} but the field reads "${value}". The site did not accept it.${seen} ` +
          `Click the right suggestion by ref, or try a shorter text.\n${changes}`
      );
    }

    return this.ok(
      `Picked ${choice != null ? `"${choice.name}"` : "the highlighted suggestion"} for ${label}; the field now reads "${value}".\n${changes}`
    );
  }

  /** Close whatever is sitting on top of the page. */
  private async dismiss(
    wc: BrowserPage,
    sessionId?: string
  ): Promise<ToolResult> {
    const before = this.captureBefore(wc, sessionId);
    const result = await this.takeSnapshot(wc, sessionId);
    const overlays = result.overlays ?? [];
    if (overlays.length === 0)
      return this.err(
        "No dialog, banner or overlay is detected on top of the page. If something is in the way, snapshot and click its close button by ref."
      );

    const PREFER =
      /^(accept|agree|allow|got it|ok|okay|continue|i understand|close|dismiss|×|x|no thanks|not now|reject|decline|later)/i;
    const closed: string[] = [];
    for (const overlay of overlays) {
      const button =
        overlay.buttons.find((candidate) => PREFER.test(candidate.name)) ??
        overlay.buttons.find((candidate) =>
          /accept|agree|close|dismiss|ok|reject|decline/i.test(candidate.name)
        ) ??
        overlay.buttons[0];
      if (button == null) continue;
      const selector = this.snapshots.for(sessionId).refMap.get(button.ref);
      if (selector == null) continue;
      const clicked = await this.guardedClick(
        wc,
        wc,
        selector,
        sessionId
      ).catch(() => null);
      if (
        clicked != null &&
        "result" in clicked &&
        clicked.result?.status === "ok"
      )
        closed.push(`"${button.name}"`);
      await this.guardedPress(wc, wc, "Escape", sessionId, undefined, {
        synthetic: false,
      }).catch(() => null);
    }
    if (closed.length === 0)
      return this.err(
        `Could not click a button on the overlay. ${formatOverlays(overlays)}`
      );

    const changes = await this.reportChanges(wc, sessionId, before);

    return this.ok(`Dismissed ${closed.join(", ")}.\n${changes}`);
  }

  /**
   * `userGesture` runs the script as if the user acted: a click that opens a
   * tab (`window.open`, a `target=_blank` link) is otherwise popup-blocked.
   */
  private async evalJS(
    wc: BrowserPage,
    expression: string,
    options: { userGesture?: boolean } = {}
  ): Promise<any> {
    const { result, exceptionDetails } = await this.cdp(
      wc,
      "Runtime.evaluate",
      {
        // The fence is checked in the same evaluation: a document a
        // navigation brought onto an Abacus.AI host since the last check runs nothing.
        expression: `${fenceGuardExpression(abacusHostFence())},\n(${expression}\n)`,
        returnByValue: true,
        awaitPromise: true,
        ...(options.userGesture === true ? { userGesture: true } : {}),
      }
    );
    if (exceptionDetails) {
      throw new Error(
        exceptionDetails.exception?.description ??
          exceptionDetails.text ??
          "JS error"
      );
    }
    return result?.value;
  }

  /**
   * What this call is aimed at, against the last snapshot's refs. `stale-ref`
   * is distinct from `no-target`: an action with a targetless meaning must not
   * quietly act on a different element than the one the caller meant.
   */
  private target(
    args: Record<string, unknown>,
    sessionId?: string
  ): TargetResolution {
    return resolveTarget(args, this.snapshots.for(sessionId).refMap);
  }

  private emitCursorEvent(type: "mcp-cursor-move", x: number, y: number): void;
  private emitCursorEvent(type: "mcp-cursor-click" | "mcp-cursor-hide"): void;
  private emitCursorEvent(type: string, x?: number, y?: number): void {
    if (!this.presentsInApp()) return;
    const payload: Record<string, unknown> = {
      type,
      emittedAt: new Date().toISOString(),
    };
    if (x != null) payload.x = x;
    if (y != null) payload.y = y;
    emitHostEvent(payload as unknown as IpcEvent);
  }

  private async animateCursorToElement(
    wc: BrowserPage,
    sel: string
  ): Promise<void> {
    const center = await this.evalJS(wc, GET_ELEMENT_CENTER_JS(sel));
    if (center?.x != null && center?.y != null) {
      this.emitCursorEvent("mcp-cursor-move", center.x, center.y);
      await new Promise((r) => setTimeout(r, 220));
    }
  }

  private animateCursorClick(): void {
    this.emitCursorEvent("mcp-cursor-click");
  }

  private onNavigated(): void {
    // Every session's refs point at the one preview pane; all are invalidated.
    this.snapshots.clearAll();
    this.emitCursorEvent("mcp-cursor-hide");
  }

  protected async executeTool(
    name: string,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    try {
      // A run nobody is watching reads its one page and does nothing else.
      const held =
        sessionId != null
          ? (this.options.heldSession?.(sessionId) ?? null)
          : null;
      if (held != null) {
        const refusal = heldBrowserRefusal(name, args, held);
        if (refusal != null) return this.err(refusal);
        // A name that points inside is never opened, nor reloaded.
        if (
          name === "browser_navigate" &&
          held.watchUrl != null &&
          !(await watchHostIsPublic(held.watchUrl))
        )
          return this.err("The routine's page is not on a public address.");
      }
      // Pure-read tools skip the prompt; navigate/interact/execute stay gated.
      if (
        held == null &&
        this.options.requestPermission != null &&
        !isReadOnlyBrowserTool(name, args)
      ) {
        const summary = summarizeToolCall(name, args);
        const decision = await this.options.requestPermission(
          name,
          summary,
          sessionId
        );
        if (decision === "deny") {
          return this.err("Browser permission denied by user.");
        }
      }
      const act = (): Promise<ToolResult> => {
        switch (name) {
          case "browser_navigate":
            return this.executeNavigate(args, sessionId);
          case "browser_snapshot":
            return this.executeSnapshot(args, sessionId);
          case "browser_interact":
            return this.executeInteract(args, sessionId);
          case "browser_execute":
            return this.executeExecute(args, sessionId);
          case "browser_tabs":
            return this.executeTabs(args, sessionId);
          case VAULT_FILL_TOOL:
            return this.executeVaultFill(args, sessionId);
          case BROWSER_PAUSE_TOOL:
            return this.executePause(args, sessionId);
          case BROWSER_CHECKOUT_TOOL:
            return Promise.resolve(this.executeCheckout(args, sessionId));
          case TRAVELER_FILL_TOOL:
            return this.executeTravelerFill(args, sessionId);
          case "vault_items":
          case "vault_request":
          case "payment_approval":
          case "signin_approval":
            return this.options.vault == null
              ? Promise.resolve(this.err(VAULT_UNAVAILABLE))
              : this.options.vault.run(name, args, sessionId, {
                  topOrigin: async (session) => {
                    const wc = this.findView(session);
                    return wc == null ? null : this.liveOrigin(wc);
                  },
                  codePages: (session) => this.codePages(session),
                });
          default:
            return Promise.resolve(this.err(`Unknown tool: ${name}`));
        }
      };
      // Abacus.AI's own pages are the user's: the agent's browser never acts
      // on one, however it got there (a URL, a link, a script, a redirect).
      // Every browser call of a session runs in arrival order, one at a time,
      // whichever tab it lands on, so nothing (a script above all) runs while
      // a vault value is typed; a call its caller gave up on never starts.
      const call = { cancelled: false };
      const run = async (): Promise<ToolResult> => {
        if (!name.startsWith("browser_")) return act();
        const wc = this.findView(sessionId);
        // A script is on its way to this tab from the moment it is asked for.
        const scripting =
          wc != null && name === "browser_execute" ? this.secretsOf(wc) : null;
        scripting?.scriptArrived();
        const guarded = async (): Promise<ToolResult> => {
          if (call.cancelled)
            return this.err(`${name} was not run: it timed out while waiting.`);
          const refused = await this.abacusFence(name, args, sessionId);
          if (refused != null) return refused;
          if (held?.watchUrl != null && name === "browser_snapshot") {
            const page = this.findView(sessionId);
            if (page == null || !onWatchHost(page.getURL(), held.watchUrl))
              return this.err("The routine's page is not open.");
          }
          const result = await act();
          // Landed somewhere else (a redirect): leave before it is read.
          if (held?.watchUrl != null) {
            const page = this.findView(sessionId);
            if (page != null && !onWatchHost(page.getURL(), held.watchUrl)) {
              await page.loadURL("about:blank").catch(() => undefined);
              return this.err(
                "The page went to another site, so it was not read."
              );
            }
          }
          return (await this.leaveAbacusPage(sessionId)) ?? result;
        };
        try {
          return await this.inSessionOrder(sessionId ?? "", guarded);
        } finally {
          scripting?.scriptSettled();
        }
      };
      // A call that never returns takes the whole sub-agent run with it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          run(),
          new Promise<ToolResult>((resolve) => {
            timer = setTimeout(() => {
              // Still queued: it must not start for a caller that has gone.
              call.cancelled = true;
              resolve(
                this.err(
                  `${name} did not finish within ${this.callTimeout() / 1000}s. ` +
                    "The page may be unresponsive; take a snapshot to see where it is, or navigate again."
                )
              );
            }, this.callTimeout());
          }),
        ]);
      } finally {
        if (timer != null) clearTimeout(timer);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes(FENCE_ERROR)) {
        await this.leaveAbacusPage(sessionId);
        return this.err(ABACUS_REFUSAL);
      }
      return this.err(e instanceof Error ? e.message : String(e));
    }
  }

  /** Longest any one tool call may run; `wait` accepts up to two minutes itself. */
  private static readonly CALL_TIMEOUT_MS = 150_000;

  private ok(text: string): ToolResult {
    return { content: [{ type: "text", text }] };
  }
  private err(text: string): ToolResult {
    return { content: [{ type: "text", text }], isError: true };
  }

  private async executeNavigate(
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    // A url with no action is a goto; a small model drops the action often.
    const action =
      typeof args.action === "string"
        ? args.action
        : typeof args.url === "string"
          ? "goto"
          : "";
    switch (action) {
      case "goto": {
        const url = args.url as string;
        if (!url) return this.err('URL is required for "goto".');
        const refusal =
          navigationRefusal(url) ??
          (await this.guardNavigation("goto", url, sessionId));
        if (refusal != null) return this.err(refusal);
        const wc = await this.getWC(sessionId, url);
        if (!wc) return this.err(this.noBrowser(sessionId));
        return await this.navigateTo(wc, url, sessionId);
      }
      case "back": {
        const wc = await this.getWC(sessionId);
        if (!wc) return this.err(this.noBrowser(sessionId));
        // Otherwise goBack() silently does nothing and a move is reported.
        if (!wc.canGoBack()) return this.err("There is no page to go back to.");
        return await this.historyNavigate(
          wc,
          "back",
          () => wc.goBack(),
          sessionId
        );
      }
      case "forward": {
        const wc = await this.getWC(sessionId);
        if (!wc) return this.err(this.noBrowser(sessionId));
        if (!wc.canGoForward())
          return this.err("There is no page to go forward to.");
        const refusal = await this.guardNavigation("forward", null, sessionId);
        if (refusal != null) return this.err(refusal);
        return await this.historyNavigate(
          wc,
          "forward",
          () => wc.goForward(),
          sessionId
        );
      }
      case "reload": {
        const wc = await this.getWC(sessionId);
        if (!wc) return this.err(this.noBrowser(sessionId));
        const refusal = await this.guardNavigation("reload", null, sessionId);
        if (refusal != null) return this.err(refusal);
        return await this.historyNavigate(
          wc,
          "reload",
          () => wc.reload(),
          sessionId
        );
      }
      default:
        return this.err(
          `Unknown navigate action: ${action || "(none)"}. Use goto with a url, or back, forward, reload.`
        );
    }
  }

  private async executeSnapshot(
    rawArgs: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    // `find` reads as an action to a model that saw it in the description;
    // it is snapshot with a filter, so treat it as that rather than refuse.
    const args =
      rawArgs.action === "find"
        ? {
            ...rawArgs,
            action: "snapshot",
            find: rawArgs.find ?? rawArgs.text ?? rawArgs.selector ?? "",
          }
        : rawArgs;
    const action = (args.action as string) ?? "";
    const wc = await this.getWC(sessionId);
    if (!wc) return this.err(this.noBrowser(sessionId));

    switch (action) {
      case "snapshot": {
        const result = await this.takeSnapshot(wc, sessionId);
        if (!result?.tree || result.refCount === 0) {
          // The walker reads the light DOM, so web components and frames have
          // nothing for it, and querySelector cannot reach into either.
          const tabs = this.tabLine(wc, sessionId);
          return this.ok(
            `Page: ${result?.title ?? wc.getTitle()}\nURL: ${result?.url ?? wc.getURL()}\n` +
              (tabs != null ? `${tabs}\n` : "") +
              "\n" +
              "(no interactive elements found)\n" +
              'The page may still be loading. interact action:"wait" with text or url_pattern, then snapshot again.\n' +
              "If it stays empty the content is likely inside a shadow root or an iframe, which this snapshot " +
              "and plain document.querySelector both see through: reach it with browser_execute using " +
              "element.shadowRoot or the frame's contentDocument, or navigate straight to the frame URL."
          );
        }
        const lines: string[] = [];
        lines.push(`Page: ${result.title}`);
        lines.push(`URL: ${result.url}`);
        const tabs = this.tabLine(wc, sessionId);
        if (tabs != null) lines.push(tabs);
        const find = typeof args.find === "string" ? args.find.trim() : "";
        const interactiveOnly = args.interactive_only === true;
        if (find.length > 0 || interactiveOnly) {
          const filtered = filterSnapshot(result.tree, {
            find,
            interactiveOnly,
          });
          lines.push(
            find.length > 0
              ? `${filtered.count} element${filtered.count === 1 ? "" : "s"} matching "${find}":`
              : `${filtered.count} interactive elements:`
          );
          lines.push("");
          lines.push(
            filtered.count > 0
              ? filtered.text
              : "(none; try a shorter word, or snapshot without find to see the page)"
          );
        } else {
          lines.push(
            `Elements: ${result.visibleCount} visible, ${result.offscreenCount} offscreen (scroll to reach [offscreen] elements)`
          );
          lines.push("");
          lines.push(renderTree(result.tree).text);
        }
        const overlays = formatOverlays(result.overlays);
        if (overlays.length > 0) lines.push("", overlays);
        const hint = await this.loginHint(wc, sessionId).catch(() => null);
        if (hint != null) lines.push("", hint);
        lines.push("");
        lines.push(
          'Use @eN refs in browser_interact (e.g. ref:"@e1"). Refs stay valid while the element is on the page.'
        );

        return this.ok(lines.join("\n"));
      }

      case "extract": {
        const selector =
          typeof args.selector === "string" ? args.selector.trim() : "";
        if (selector.length === 0)
          return this.err(
            'extract needs a selector for the rows, e.g. selector:"li" or selector:"table".'
          );
        const fields: Record<string, string> = {};
        if (args.fields != null && typeof args.fields === "object") {
          for (const [name, value] of Object.entries(
            args.fields as Record<string, unknown>
          )) {
            if (typeof value === "string" && value.trim().length > 0)
              fields[name] = value;
          }
        }
        const limit = numericArg(args.limit, 25, { min: 1, max: 100 });
        let result: { status?: string; total?: number; rows?: unknown[] };
        try {
          result = await this.readPage(
            wc,
            extractScript(selector, fields, limit)
          );
        } catch (error) {
          if (error instanceof UnreadablePageError)
            return this.err(error.message);
          return this.err(
            `Invalid selector "${selector}": ${error instanceof Error ? error.message : String(error)}`
          );
        }
        if (result?.status !== "ok")
          return this.err(
            `Nothing matches "${selector}". Take a snapshot to see what the page has, then pick a selector from a real element.`
          );
        const rows = result.rows ?? [];
        const json = JSON.stringify(rows, null, 1);
        const body =
          json.length > 20_000
            ? `${json.slice(0, 20_000)}\n...(truncated)`
            : json;

        return this.ok(
          `${rows.length} of ${result.total ?? rows.length} rows matching "${selector}":\n${body}`
        );
      }

      case "screenshot": {
        // The description is all a text-only model gets.
        let summary = "";
        try {
          const raw = (await this.evalJS(wc, PAGE_SUMMARY_JS)) as PageSummary;
          summary = formatPageSummary(raw);
        } catch {
          summary = `Page: ${wc.getTitle()}\nURL: ${wc.getURL()}`;
        }
        const tabs = this.tabLine(wc, sessionId);
        if (tabs != null) summary = `${summary}\n${tabs}`;

        const image = await this.captureImage(wc);
        if (image == null) {
          return this.ok(
            `${summary}\n\n(No screenshot could be captured; the description above is what the page shows.)`
          );
        }
        fs.mkdirSync(TEMP_DIR, { recursive: true });
        pruneOldScreenshots();
        const filePath = path.join(
          TEMP_DIR,
          `screenshot-${Date.now()}.${image.mimeType === "image/png" ? "png" : "jpg"}`
        );
        fs.writeFileSync(filePath, Buffer.from(image.data, "base64"));
        const mediaId = this.keepAsMedia(image, sessionId);

        return {
          content: [
            { type: "image", data: image.data, mimeType: image.mimeType },
            {
              type: "text",
              text:
                `${summary}\n\nScreenshot saved to ${filePath}` +
                (mediaId != null ? `\nmedia id: ${mediaId}` : ""),
            },
          ],
        };
      }

      case "text": {
        const sel = (args.selector as string) ?? "body";
        const text = await this.evalJS(
          wc,
          `document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`
        );
        if (text == null) return this.err(`No element found: ${sel}`);
        return this.ok(
          typeof text === "string" && text.length > 20000
            ? text.slice(0, 20000) + "\n...(truncated)"
            : text
        );
      }

      case "url":
        return this.ok(wc.getURL());
      case "title":
        return this.ok(wc.getTitle());
      default:
        return this.err(
          `Unknown snapshot action: ${action || "(none)"}. Use snapshot (with find:"..." to filter), extract, text, screenshot, url or title.`
        );
    }
  }

  /** Actions that may open a tab: the page reacts to them as to the user's own. */
  private static readonly MAY_OPEN_TABS = new Set([
    "click",
    "press",
    "pick",
    "select",
  ]);

  /** Actions after which the page is expected to have changed. */
  private static readonly REPORTS_CHANGES = new Set([
    "click",
    "fill",
    "type",
    "select",
    "press",
    "check",
    "uncheck",
  ]);

  private async executeInteract(
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const action = (args.action as string) ?? "";
    const wc = await this.getWC(sessionId);
    if (!wc) return this.err(this.noBrowser(sessionId));
    // A tab that opens right after one of these may be this action's.
    if (sessionId != null && McpBrowserServer.MAY_OPEN_TABS.has(action))
      this.options.target?.()?.noteAction?.(sessionId);

    // A page-initiated navigation leaves the ref map on the old page.
    // Re-snapshot silently: refs are stable, and a missing one is reported by
    // the action itself.
    const snapshot = this.snapshots.for(sessionId);
    if (
      typeof args.ref === "string" &&
      snapshot.url != null &&
      wc.getURL() !== snapshot.url
    ) {
      const fresh = await this.takeSnapshot(wc, sessionId).catch(() => null);
      if (fresh?.tree == null) {
        snapshot.refMap.clear();
        snapshot.frameOf.clear();
        snapshot.url = null;
        return this.err(
          `The page has navigated since the last snapshot (now at ${wc.getURL()}), so its refs are stale. ` +
            'Run browser_snapshot action:"snapshot" to get fresh refs.'
        );
      }
      if (!snapshot.refMap.has(args.ref)) {
        const compact = filterSnapshot(
          fresh.tree,
          { interactiveOnly: true },
          25
        );
        return this.err(
          `The page has navigated to ${fresh.url} and ${args.ref} is not on it. Elements there now:\n${compact.text}`
        );
      }
    }

    if (action === "pick") return await this.pick(wc, args, sessionId);
    if (action === "dismiss") return await this.dismiss(wc, sessionId);

    const before = McpBrowserServer.REPORTS_CHANGES.has(action)
      ? this.captureBefore(wc, sessionId)
      : null;
    // A ref inside a cross-origin frame acts in that frame's own document.
    let target = this.pageForRef(wc, args.ref, sessionId);
    if (target == null)
      return this.err(
        `The frame ${String(args.ref)} was in has gone. Run browser_snapshot to see the page as it is now.`
      );
    let result = await this.interactStep(wc, target, args, sessionId);
    // The element was there at the snapshot and is not now: the page
    // re-rendered under a stable ref (refs key on the selector), so one fresh
    // snapshot usually brings it back. A model told only "take a snapshot"
    // spends two turns on what one retry does here.
    if (
      result.isError === true &&
      typeof args.ref === "string" &&
      McpBrowserServer.isVanished(result)
    ) {
      const fresh = await this.takeSnapshot(wc, sessionId).catch(() => null);
      target = this.pageForRef(wc, args.ref, sessionId);
      if (
        fresh?.tree != null &&
        snapshot.refMap.has(args.ref) &&
        target != null
      ) {
        // The retry is an activation of its own, checked again.
        const retried = await this.interactStep(wc, target, args, sessionId);
        if (retried.isError !== true) {
          const text = firstText(retried);
          result = this.ok(
            `(The page had re-rendered; refs were refreshed and the action retried.) ${text}`
          );
        }
      }
    }
    if (before == null || result.isError === true) return result;

    const changes = await this.reportChanges(wc, sessionId, before);
    const text = firstText(result);

    return this.ok(changes.length > 0 ? `${text}\n${changes}` : text);
  }

  /** One interact action on `wc` (the control's document); `top` is the tab's page. */
  private async interactStep(
    top: BrowserPage,
    wc: BrowserPage,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const action = (args.action as string) ?? "";
    const snapshot = this.snapshots.for(sessionId);

    switch (action) {
      case "click": {
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        // A link to an Abacus.AI page is never followed.
        const href = await this.evalJS(wc, linkTargetScript(sel)).catch(
          () => null
        );
        if (typeof href === "string" && this.isAbacus(href))
          return this.err(ABACUS_REFUSAL);
        const clicked = await this.guardedClick(
          top,
          wc,
          sel,
          sessionId,
          args.total_ref
        );
        if ("refused" in clicked) return this.err(clicked.refused);
        const result = clicked.result;
        if (result?.status === "not_found")
          return this.err(this.notFoundError(args, sel));
        if (result?.status === "disabled") {
          return this.err(
            `${this.label(args)} is disabled, so the click did nothing. ` +
              "Whatever the page needs before it enables the control has not happened yet."
          );
        }
        this.animateCursorClick();
        const detail = result?.text ? ` "${result.text.trim()}"` : "";
        return this.ok(
          `Clicked ${this.label(args)}${detail} at (${result?.x},${result?.y}).`
        );
      }

      case "fill": {
        const text = args.text as string;
        if (text == null) return this.err('"text" is required for fill.');
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        // A <select> is chosen through the guard, as select is.
        if (await this.isSelect(wc, sel))
          return this.interactStep(
            top,
            wc,
            { ...args, action: "select", value: text },
            sessionId
          );
        await this.animateCursorToElement(wc, sel).catch(() => {});
        this.animateCursorClick();
        // The native value setter is called on the element's own prototype;
        // HTMLInputElement's throws "Illegal invocation" on a contenteditable.
        const result = await this.evalJS(wc, fillScript(sel, text));
        if (result?.status === "not_found")
          return this.err(this.notFoundError(args, sel));
        if (result?.status === "not_fillable") {
          return this.err(
            `${this.label(args)} is a <${result.tag}>, which has no value to fill. ` +
              "Take a snapshot and pick an input, textarea, or contenteditable element."
          );
        }
        if (result?.status === "not_editable") {
          return this.err(
            `${this.label(args)} is disabled or read-only, so nothing was typed into it.`
          );
        }
        if (result?.status === "rejected") {
          return this.err(
            `Filled ${this.label(args)}, but the page reset its value; it is likely controlled by a framework ` +
              'that ignores programmatic input. Try interact action:"type", or press keys into it.'
          );
        }
        const preview = text.length > 30 ? text.slice(0, 27) + "..." : text;
        return this.ok(`Filled ${this.label(args)} with "${preview}".`);
      }

      case "type": {
        const text = args.text as string;
        if (text == null) return this.err('"text" is required for type.');
        // An expired ref is an error, not a reason to type into whatever is
        // focused.
        const resolved = this.target(args, sessionId);
        if (resolved.kind === "stale-ref")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.kind === "selector" ? resolved.selector : null;
        // A <select> is chosen through the guard, as select is.
        if (await this.isSelect(wc, sel))
          return sel != null
            ? this.interactStep(
                top,
                wc,
                { ...args, action: "select", value: text },
                sessionId
              )
            : this.err(
                'The focused element is a dropdown: choose its option with action "select" and its ref.'
              );
        const target = sel
          ? `document.querySelector(${JSON.stringify(sel)})`
          : "document.activeElement";
        if (sel) {
          await this.animateCursorToElement(wc, sel).catch(() => {});
          this.animateCursorClick();
        }
        const result = await this.evalJS(wc, typeScript(target, text));
        if (result?.status === "not_found") {
          return this.err(
            sel
              ? this.notFoundError(args, sel)
              : "Nothing is focused on the page, so there is no element to type into. Pass a ref from a snapshot."
          );
        }
        if (result?.status === "not_fillable") {
          return this.err(
            `${this.label(args)} is a <${result.tag}>, which has no value to type into. ` +
              "Take a snapshot and pick an input, textarea, or contenteditable element."
          );
        }
        if (result?.status === "not_editable") {
          return this.err(
            `${this.label(args)} is disabled or read-only, so nothing was typed into it.`
          );
        }
        if (result?.status === "rejected") {
          return this.err(
            `Typed into ${this.label(args)}, but the page reset its value; it is likely controlled by a ` +
              "framework that ignores programmatic input."
          );
        }
        return this.ok(`Typed into ${this.label(args)}.`);
      }

      case "select": {
        const resolved = this.target(args, sessionId);
        const value = args.value as string;
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        if (value == null) return this.err('"value" is required for select.');
        // Assigning an unmatched value to a <select> silently clears it, so the
        // element's own state decides and a miss lists what was there.
        const selected = await this.guardedSelect(
          top,
          wc,
          sel,
          value,
          sessionId
        );
        if ("refused" in selected) return this.err(selected.refused);
        const result = selected.result;
        if (result?.status === "not_found")
          return this.err(`No <select> found: ${this.label(args)}`);
        if (result?.status === "no_match") {
          const options = Array.isArray(result.options)
            ? result.options.join(", ")
            : "";
          return this.err(
            `No option "${value}" in ${this.label(args)}; nothing was selected.` +
              (options.length > 0 ? ` Available values: ${options}` : "")
          );
        }
        return this.ok(
          `Selected "${result?.selected ?? value}" in ${this.label(args)}.`
        );
      }

      case "hover": {
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        await this.animateCursorToElement(wc, sel).catch(() => {});
        const result = await this.evalJS(
          wc,
          `(function() {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return 'not_found';
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          return 'ok';
        })()`
        );
        if (result === "not_found")
          return this.err(this.notFoundError(args, sel));
        return this.ok(`Hovered over ${this.label(args)}.`);
      }

      case "scroll": {
        const direction = (args.direction as string) ?? "down";
        // Coerced, not cast: interpolated into the page source below.
        const amount = numericArg(args.amount, 500, {
          min: -100_000,
          max: 100_000,
        });
        const scrollTarget = this.target(args, sessionId);
        if (scrollTarget.kind === "stale-ref")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel =
          scrollTarget.kind === "selector" ? scrollTarget.selector : null;
        const dx =
          direction === "right" ? amount : direction === "left" ? -amount : 0;
        const dy =
          direction === "down" ? amount : direction === "up" ? -amount : 0;
        // Report the distance actually covered, so the tool can say there is
        // no more page left instead of an endless "scrolled 500px".
        const moved = await this.evalJS(
          wc,
          `(function(){
          const el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : "null"};
          const box = el || document.scrollingElement || document.documentElement;
          const beforeX = box.scrollLeft, beforeY = box.scrollTop;
          if (el) el.scrollBy(${dx}, ${dy}); else window.scrollBy(${dx}, ${dy});
          return { dx: box.scrollLeft - beforeX, dy: box.scrollTop - beforeY };
        })()`
        );
        const covered = Math.abs(moved?.dx ?? 0) + Math.abs(moved?.dy ?? 0);
        if (covered === 0) {
          return this.ok(
            `Scroll had no effect: ${sel ? this.label(args) : "the page"} is already at the ${direction} limit.`
          );
        }
        return this.ok(
          `Scrolled ${direction} ${covered}px. Take a new snapshot to see updated element positions.`
        );
      }

      case "scroll_into_view": {
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        const result = await this.evalJS(
          wc,
          `(function() {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return 'not_found';
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return 'ok';
        })()`
        );
        if (result === "not_found")
          return this.err(this.notFoundError(args, sel));
        await this.animateCursorToElement(wc, sel).catch(() => {});
        return this.ok(`Scrolled ${this.label(args)} into view.`);
      }

      case "focus": {
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        await this.animateCursorToElement(wc, sel).catch(() => {});
        // focus() on an unfocusable element is a no-op, and the next move is
        // usually to type into whatever was focused before.
        const result = await this.evalJS(
          wc,
          `(function() {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return 'not_found';
          el.focus();
          return document.activeElement === el ? 'ok' : 'not_focusable';
        })()`
        );
        if (result === "not_found")
          return this.err(this.notFoundError(args, sel));
        if (result === "not_focusable") {
          return this.err(
            `${this.label(args)} did not take focus: it is not a focusable element. ` +
              "Give it a tabindex, or aim at the input inside it."
          );
        }
        return this.ok(`Focused ${this.label(args)}.`);
      }

      case "check":
      case "uncheck": {
        const resolved = this.target(args, sessionId);
        if (resolved.kind !== "selector")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = resolved.selector;
        const want = action === "check";
        const checked = await this.guardedCheck(top, wc, sel, want, sessionId);
        if ("refused" in checked) return this.err(checked.refused);
        const result = checked.result;
        if (result === "not_found")
          return this.err(this.notFoundError(args, sel));
        if (result === "unchanged") {
          return this.err(
            `Clicked ${this.label(args)}, but it is still ${want ? "unchecked" : "checked"}. ` +
              "The control may be disabled or handled by a custom widget. Take a snapshot to check."
          );
        }
        return this.ok(
          `${want ? "Checked" : "Unchecked"} ${this.label(args)}.`
        );
      }

      case "press": {
        const key = (args.key as string) ?? (args.text as string);
        if (!key)
          return this.err(
            '"key" is required for press (e.g. "Enter", "Control+a").'
          );
        const { key: mainKey, modifiers: mods } = parseKeyCombo(key);
        // Copy, cut or paste could carry a filled value into a field that shows it.
        if (
          isClipboardCombo(mainKey, mods) &&
          (await this.secretsOf(wc).executeRefusal(wc)) != null
        )
          return this.err(
            "Refused: this page has a password, card or code field, so copy, cut and paste keys are not used on it."
          );

        const pressed = await this.guardedPress(
          top,
          wc,
          key,
          sessionId,
          args.total_ref
        );
        if ("refused" in pressed) return this.err(pressed.refused);
        return this.ok(`Pressed ${key}.`);
      }

      case "wait": {
        const timeout = numericArg(args.amount, 5000, { min: 0, max: 120_000 });
        // A stale ref must not fall through to a sleep reported as success.
        const waitTarget = this.target(args, sessionId);
        if (waitTarget.kind === "stale-ref")
          return this.err(this.refError(args, snapshot.refMap.size));
        const sel = waitTarget.kind === "selector" ? waitTarget.selector : null;
        const waitText = args.text as string | undefined;
        const urlPattern = args.url_pattern as string | undefined;

        if (sel) {
          const found = await this.evalJS(
            wc,
            `new Promise(r => {
            if (document.querySelector(${JSON.stringify(sel)})) { r(true); return; }
            const o = new MutationObserver(() => {
              if (document.querySelector(${JSON.stringify(sel)})) { o.disconnect(); r(true); }
            });
            o.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { o.disconnect(); r(false); }, ${timeout});
          })`
          );
          if (!found)
            return this.err(
              `Timed out waiting for element: ${this.label(args)}`
            );
          return this.ok(`Element appeared: ${this.label(args)}.`);
        }
        if (waitText) {
          const found = await this.evalJS(
            wc,
            `new Promise(r => {
            if (document.body.innerText.includes(${JSON.stringify(waitText)})) { r(true); return; }
            const o = new MutationObserver(() => {
              if (document.body.innerText.includes(${JSON.stringify(waitText)})) { o.disconnect(); r(true); }
            });
            o.observe(document.body, { childList: true, subtree: true, characterData: true });
            setTimeout(() => { o.disconnect(); r(false); }, ${timeout});
          })`
          );
          if (!found)
            return this.err(`Timed out waiting for text: "${waitText}"`);
          return this.ok(`Text appeared: "${waitText}".`);
        }
        if (urlPattern) {
          const regexSource = globToRegexSource(urlPattern);
          const found = await this.evalJS(
            wc,
            `new Promise(r => {
            const re = new RegExp(${JSON.stringify(regexSource)});
            if (re.test(location.href)) { r(true); return; }
            const id = setInterval(() => { if (re.test(location.href)) { clearInterval(id); r(true); } }, 100);
            setTimeout(() => { clearInterval(id); r(false); }, ${timeout});
          })`
          );
          if (!found)
            return this.err(`Timed out waiting for URL: ${urlPattern}`);
          return this.ok(`URL matched: ${urlPattern}.`);
        }
        const deadline = Date.now() + Math.min(timeout, 10_000);
        // Fixed polling intervals keep remote input out of timer durations.
        while (Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 10));
        return this.ok(`Waited ${timeout}ms.`);
      }

      default:
        return this.err(
          `Unknown interact action: ${action || "(none)"}. Use click, fill, pick, type, select, press, dismiss, check, uncheck, hover, focus, scroll, scroll_into_view or wait.`
        );
    }
  }

  private async executeExecute(
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const wc = await this.getWC(sessionId);
    if (!wc) return this.err(this.noBrowser(sessionId));
    const code = args.code as string;
    if (!code) return this.err('"code" is required.');
    const secrets = this.secretsOf(wc);
    const refusal = await secrets.executeRefusal(wc);
    if (refusal != null) return this.err(refusal);
    // A checkout with a payment provider's frame is where a total could be
    // forged next to card fields no script can reach: no scripts there.
    const page = await this.documentInfo(wc);
    if (page.frameOrigins.some((origin) => isPaymentFrameOrigin(origin)))
      return this.err(
        "This page has a payment provider's card form, so scripts cannot run on it. Use browser_snapshot and browser_interact instead."
      );
    if (page.key == null)
      return this.err(
        "The browser could not say which page this is, so no script runs on it. Snapshot and try again."
      );
    // Refused before it is noted: a script that never ran leaves the page fillable.
    const checkout = await this.guardExecute(wc, sessionId);
    if (checkout != null) return this.err(checkout);
    // From here the page may hold what a script put there (a listener, a
    // changed field, a forged total): nothing is filled into it any more.
    secrets.noteScript(page.key);

    // Models write `document.title` far more often than `return document.title`,
    // so an expression is tried as one first; only non-expressions fall
    // through to a statement body.
    const attempts = planExecuteAttempts(code);
    let lastError: unknown = null;

    for (const [index, body] of attempts.entries()) {
      try {
        const result = await this.evalJS(
          wc,
          `(async function() { ${body} })()`
        );
        const str =
          result !== undefined ? JSON.stringify(result, null, 2) : "undefined";

        return this.ok(
          str.length > 20000 ? str.slice(0, 20000) + "\n...(truncated)" : str
        );
      } catch (e) {
        // The page is on an Abacus.AI host: nothing ran, and the call is refused.
        if (e instanceof Error && e.message.includes(FENCE_ERROR)) throw e;
        lastError = e;

        // Only a parse failure means the wrapping guess was wrong; retrying on
        // anything else runs `el.click()` twice.
        if (index === attempts.length - 1 || !isSyntaxError(e)) break;
      }
    }

    return this.err(
      `JS Error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }

  // ── The Pay guard and the checkout ────────────────────────────────────
  //
  // Every activation (click, key that can activate, check, select, and the
  // clicks and keys inside pick and dismiss) runs through one of the guarded
  // primitives below, and each of them through `guardActivation` first;
  // navigation through `guardNavigation`, scripts through `guardExecute`.
  // The raw clickScript/checkScript/selectScript/dispatchTrustedKey are
  // called nowhere else (mcp-browser-guard.test.ts holds the file to that).

  /** Checkout state for sessions when no vault is attached; the vault keeps it otherwise. */
  private readonly ownSessions = new VaultSessions();

  private vaultSession(sessionId?: string): VaultSession {
    return (this.options.vault?.sessions ?? this.ownSessions).for(
      sessionId ?? ""
    );
  }

  /**
   * `expression` in an isolated world of `page`'s document: it shares the
   * page's DOM but none of its JavaScript, so a page script cannot answer for
   * it. Null when it could not run.
   */
  private async isolatedEval(
    page: BrowserPage,
    expression: string
  ): Promise<unknown> {
    try {
      const frameId = page.frameId ?? (await this.documentInfo(page)).frameId;
      if (frameId == null) return null;
      const world = (await this.cdp(page, "Page.createIsolatedWorld", {
        frameId,
        worldName: "abacusai-pay-guard",
      })) as { executionContextId?: unknown } | null;
      const contextId = world?.executionContextId;
      if (typeof contextId !== "number") return null;
      const response = (await this.cdp(page, "Runtime.evaluate", {
        expression,
        contextId,
        returnByValue: true,
      })) as {
        result?: { value?: unknown };
        exceptionDetails?: unknown;
      } | null;
      if (response == null || response.exceptionDetails != null) return null;
      return response.result?.value ?? null;
    } catch {
      return null;
    }
  }

  private async controlFacts(
    page: BrowserPage,
    script: string
  ): Promise<ControlFacts | null> {
    const value = (await this.isolatedEval(page, script)) as Partial<
      Record<keyof ControlFacts, unknown>
    > | null;
    if (
      value == null ||
      typeof value !== "object" ||
      typeof value.found !== "boolean" ||
      typeof value.kind !== "string" ||
      typeof value.url !== "string" ||
      typeof value.label !== "string" ||
      typeof value.attrs !== "string"
    )
      return null;
    const facts = value as ControlFacts;
    if (facts.cardFields) return facts;
    // The host's own facts count too: a page that strips a card field's
    // attributes after it was first seen (or filled) is still a card step.
    const known = await this.secretsOf(page)
      .hasCardField(page, cardField)
      .catch(() => null);
    return known == null ? null : { ...facts, cardFields: known };
  }

  /**
   * The checkout and approval as the guard reads them for one activation on
   * `top`'s tab; a document the facts show is a payment step is remembered as
   * one for the rest of the checkout.
   */
  private async guardState(
    top: BrowserPage,
    facts: ControlFacts | null,
    sessionId?: string
  ): Promise<{
    session: VaultSession;
    approval: PaymentApproval | null;
    state: GuardState;
  }> {
    const session = this.vaultSession(sessionId);
    const approval = this.options.vault?.approval(sessionId) ?? null;
    const topOrigin = originOf(top.getURL());
    const origins = [topOrigin, facts != null ? originOf(facts.url) : null];
    // The browser's own frame tree: a provider's card frame makes this a
    // payment step whatever the page's markup says.
    const { frameOrigins } = await this.documentInfo(top);
    if (
      (facts != null && looksLikePaymentStep(facts)) ||
      frameOrigins.some((origin) => isPaymentFrameOrigin(origin))
    )
      for (const origin of origins)
        if (origin != null) session.notePaymentStep(origin);
    const commit =
      approval != null ? session.committed.get(approval.id) : undefined;
    return {
      session,
      approval,
      state: {
        knownPaymentStep: origins.some((origin) =>
          session.isPaymentStep(origin)
        ),
        pastReview: session.checkout.pastReview(),
        bankStep: session.checkout.stage === "bank_otp",
        approval: {
          live: approval != null,
          // Asked of the live page: the site the approval binds is checked as it is now.
          coversSite:
            approval != null &&
            approvalCovers(approval.site, await this.liveOrigin(top)),
          paid: commit?.paid === true,
          reviewed: commit?.reviewed === true,
          bankSubmitted: commit?.bankSubmitted === true,
        },
      },
    };
  }

  /**
   * The one check every activation passes: null to let it happen, else why
   * not. A payment it lets through uses the approval up then and there.
   */
  private async guardActivation(
    top: BrowserPage,
    page: BrowserPage,
    activation: Activation,
    sessionId?: string,
    totalRef?: unknown
  ): Promise<string | null> {
    if (activation.action === "key" && !activatesControl(activation.key))
      return null;
    const script =
      activation.action === "key"
        ? controlFactsScript(activation.selector ?? null, {
            enter: !isSpaceKey(activation.key),
          })
        : controlFactsScript(activation.selector, {
            option: activation.action === "select" ? activation.option : null,
          });
    const facts = await this.controlFacts(page, script);
    const { session, approval, state } = await this.guardState(
      top,
      facts,
      sessionId
    );
    const verdict = activationVerdict(activation, facts, state);
    switch (verdict.kind) {
      case "allow":
        return null;
      case "refuse":
        return verdict.reason;
      case "bank":
      case "commit": {
        // Reserved now, with nothing awaited since the verdict: two
        // activations on one approval (in two tabs, say) cannot both pass.
        const record = session.committed.get(approval!.id) ?? {
          paid: false,
          reviewed: false,
          bankSubmitted: false,
        };
        const part =
          verdict.kind === "bank"
            ? "bankSubmitted"
            : verdict.tier === "pay"
              ? "paid"
              : "reviewed";
        if (record[part]) return USED_REFUSAL;
        record[part] = true;
        session.committed.set(approval!.id, record);
        if (verdict.kind === "bank") return null;
        const refusal = await this.anchoredTotalRefusal(
          top,
          session,
          approval!,
          totalRef,
          sessionId
        );
        // A refused commit spends nothing.
        if (refusal != null) record[part] = false;
        return refusal;
      }
    }
  }

  /**
   * The commit's total check: the element the browser anchored (at the
   * payment pause, or by the card fill), read again now. Null lets it go.
   */
  private async anchoredTotalRefusal(
    top: BrowserPage,
    session: VaultSession,
    approval: PaymentApproval,
    totalRef: unknown,
    sessionId?: string
  ): Promise<string | null> {
    const anchor = session.anchoredTotal;
    if (anchor == null) return TOTAL_NOT_ANCHORED;
    if (
      typeof totalRef === "string" &&
      !this.isAnchoredTotal(session, totalRef, sessionId)
    )
      return TOTAL_NOT_ANCHORED;
    const page =
      anchor.frameId == null
        ? top
        : (this.options.target?.()?.framePage?.(top.id, anchor.frameId) ??
          null);
    const text =
      page == null
        ? null
        : await this.isolatedEval(page, totalTextScript(anchor.selector));
    if (typeof text !== "string")
      return "Refused: the total the browser anchored is no longer on the page, so nothing is paid. Report where the checkout is.";
    return commitVerdict(readPageTotal(text), approval);
  }

  /** Whether `totalRef` names the element the session's total is anchored to. */
  private isAnchoredTotal(
    session: VaultSession,
    totalRef: string,
    sessionId?: string
  ): boolean {
    const anchor = session.anchoredTotal;
    const snapshot = this.snapshots.for(sessionId);
    return (
      anchor != null &&
      snapshot.refMap.get(totalRef) === anchor.selector &&
      (snapshot.frameOf.get(totalRef) ?? null) === anchor.frameId
    );
  }

  /** Anchors the total the browser read from `totalRef` for the session's next commit. */
  private anchorTotal(
    session: VaultSession,
    totalRef: string,
    sessionId?: string
  ): void {
    const snapshot = this.snapshots.for(sessionId);
    const selector = snapshot.refMap.get(totalRef);
    if (selector == null) return;
    session.anchoredTotal = {
      selector,
      frameId: snapshot.frameOf.get(totalRef) ?? null,
    };
  }

  /** The total `totalRef` shows, read in an isolated world; null when it shows none. */
  private async readTotalIsolated(
    top: BrowserPage,
    totalRef: string | undefined,
    sessionId?: string
  ): Promise<PageTotal | null> {
    if (totalRef == null) return null;
    const selector = this.snapshots.for(sessionId).refMap.get(totalRef);
    const page = this.pageForRef(top, totalRef, sessionId);
    if (selector == null || page == null) return null;
    const text = await this.isolatedEval(page, totalTextScript(selector));
    return typeof text === "string" ? readPageTotal(text) : null;
  }

  /** Whether the element (or, with no selector, the focused one) is a `<select>`, read in an isolated world. */
  private async isSelect(
    page: BrowserPage,
    selector: string | null
  ): Promise<boolean> {
    const target =
      selector == null
        ? "document.activeElement"
        : `document.querySelector(${JSON.stringify(selector)})`;
    const tag = await this.isolatedEval(
      page,
      `(function() { const el = ${target}; return el ? el.tagName : null; })()`
    );
    return tag === "SELECT";
  }

  private async guardedClick(
    top: BrowserPage,
    page: BrowserPage,
    selector: string,
    sessionId?: string,
    totalRef?: unknown
  ): Promise<{ refused: string } | { result: any }> {
    const refused = await this.guardActivation(
      top,
      page,
      { action: "click", selector },
      sessionId,
      totalRef
    );
    if (refused != null) return { refused };
    await this.animateCursorToElement(page, selector).catch(() => {});
    return {
      result: await this.evalJS(page, clickScript(selector), {
        userGesture: true,
      }),
    };
  }

  private async guardedCheck(
    top: BrowserPage,
    page: BrowserPage,
    selector: string,
    want: boolean,
    sessionId?: string
  ): Promise<{ refused: string } | { result: any }> {
    const refused = await this.guardActivation(
      top,
      page,
      { action: want ? "check" : "uncheck", selector },
      sessionId
    );
    if (refused != null) return { refused };
    await this.animateCursorToElement(page, selector).catch(() => {});
    this.animateCursorClick();
    return { result: await this.evalJS(page, checkScript(selector, want)) };
  }

  private async guardedSelect(
    top: BrowserPage,
    page: BrowserPage,
    selector: string,
    option: string,
    sessionId?: string
  ): Promise<{ refused: string } | { result: any }> {
    const refused = await this.guardActivation(
      top,
      page,
      { action: "select", selector, option },
      sessionId
    );
    if (refused != null) return { refused };
    await this.animateCursorToElement(page, selector).catch(() => {});
    this.animateCursorClick();
    return {
      result: await this.readPage(page, selectScript(selector, option)),
    };
  }

  /**
   * A key into the focused element, guarded when it can activate or submit.
   * Trusted through the debugger; with `synthetic`, page-level events when
   * the debugger cannot deliver it (and Enter then submits the form itself).
   */
  private async guardedPress(
    top: BrowserPage,
    page: BrowserPage,
    combo: string,
    sessionId?: string,
    totalRef?: unknown,
    options: { synthetic?: boolean } = {}
  ): Promise<{ refused: string } | { result: "trusted" | "synthetic" }> {
    const refused = await this.guardActivation(
      top,
      page,
      { action: "key", key: combo },
      sessionId,
      totalRef
    );
    if (refused != null) return { refused };
    const { key: mainKey, modifiers: mods } = parseKeyCombo(combo);
    // Through the debugger, so the key event is trusted and the default
    // action runs: a `new KeyboardEvent` reaches listeners, but Enter does
    // not submit and arrows do not move a listbox selection.
    try {
      await this.dispatchTrustedKey(page, mainKey, mods);
      return { result: "trusted" };
    } catch (error) {
      if (options.synthetic === false) throw error;
      // Debugger unavailable: the synthetic path is worse, but not nothing.
    }
    await this.evalJS(
      page,
      `(function() {
      const el = document.activeElement || document.body;
      const opts = {
        key: ${JSON.stringify(mainKey)},
        code: ${JSON.stringify(mainKey.length === 1 ? "Key" + mainKey.toUpperCase() : mainKey)},
        ctrlKey: ${mods.includes("control") || mods.includes("ctrl")},
        shiftKey: ${mods.includes("shift")},
        altKey: ${mods.includes("alt")},
        metaKey: ${mods.includes("meta") || mods.includes("command")},
        bubbles: true, cancelable: true,
      };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: opts.key, code: opts.code, bubbles: true }));
      if (${JSON.stringify(mainKey)} === 'Enter' && el.form) {
        el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
      }
    })()`
    );
    return { result: "synthetic" };
  }

  /** Null to let a navigation from the session's page happen, else why not. */
  private async guardNavigation(
    action: NavigationAction,
    to: string | null,
    sessionId?: string
  ): Promise<string | null> {
    const wc = this.findView(sessionId);
    if (wc == null) return null;
    const from = wc.getURL();
    if (originOf(from) == null) return null;
    const facts = await this.controlFacts(wc, pageFactsScript());
    const { state } = await this.guardState(wc, facts, sessionId);
    const strict =
      state.pastReview || state.knownPaymentStep
        ? true
        : facts == null
          ? null
          : looksLikePaymentStep(facts);
    return navigationVerdict({
      action,
      from,
      to,
      strict,
      approvalLive: state.approval.live && !state.approval.paid,
    });
  }

  /** Scripts do not run once a checkout is under way, or on a payment step. */
  private async guardExecute(
    wc: BrowserPage,
    sessionId?: string
  ): Promise<string | null> {
    if (this.vaultSession(sessionId).checkout.pastSearch())
      return EXECUTE_REFUSAL;
    // A live approval is a payment waiting to be made: no script makes it.
    if (this.options.vault?.approval(sessionId) != null) return EXECUTE_REFUSAL;
    if (originOf(wc.getURL()) == null) return null;
    const facts = await this.controlFacts(wc, pageFactsScript());
    if (facts == null) return EXECUTE_REFUSAL;
    // A page with a control that commits ("Buy now") could be bought from by a script's click.
    if (facts.commitControlOnPage) return COMMIT_PAGE_EXECUTE_REFUSAL;
    const { state } = await this.guardState(wc, facts, sessionId);
    return state.knownPaymentStep || looksLikePaymentStep(facts)
      ? EXECUTE_REFUSAL
      : null;
  }

  /** `browser_pause`: the run's stop, with what the browser itself reads of the page. */
  private async executePause(
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    if (sessionId == null)
      return this.err("A pause belongs to a conversation.");
    const parsed = parsePause(args);
    if (parsed.ok === false) return this.err(`Not paused: ${parsed.reason}`);
    const input = parsed.input;
    const session = this.vaultSession(sessionId);
    const target = session.checkout.pauseTarget(input.need);
    if (target.ok === false)
      return this.err(
        `Not paused: ${target.reason} Carry on with the task, or report what is in the way.`
      );
    const wc = this.findView(sessionId);
    const topOrigin = wc != null ? await this.liveOrigin(wc) : null;
    let amount: string | null = null;
    let currency: string | null = null;
    if (input.need === "payment") {
      if (wc == null) return this.err(this.noBrowser(sessionId));
      const facts = await this.controlFacts(wc, pageFactsScript());
      const { state } = await this.guardState(wc, facts, sessionId);
      if (
        facts == null ||
        !(state.knownPaymentStep || looksLikePaymentStep(facts))
      )
        return this.err(
          "Not paused: a payment stop is made on the page with the card form, and this page has none. " +
            "Go on to it (pick card as the payment method if the page asks), then pause there."
        );
      const total = await this.readTotalIsolated(
        wc,
        input.totalRef ?? undefined,
        sessionId
      );
      if (total == null)
        return this.err(
          "Not paused: total_ref does not show one total. Name the element with the order total and its currency, " +
            'e.g. "Total ₹1,234.00", from a fresh snapshot.'
        );
      const resolved =
        input.currency != null
          ? total.currencies.includes(input.currency)
            ? input.currency
            : null
          : total.currencies.length === 1
            ? total.currencies[0]!
            : null;
      if (resolved == null)
        return this.err(
          total.currencies.length === 0
            ? "Not paused: the total shows no currency. Name an element that shows it with its currency."
            : `Not paused: the total's currency could be ${total.currencies.join(", ")}; pass currency as the one the page means.`
        );
      amount = total.amount;
      currency = resolved;
      // The total the commit is checked against is this element, from now on.
      this.anchorTotal(session, input.totalRef!, sessionId);
    }
    const image =
      wc != null && SCREENSHOT_NEEDS.has(input.need)
        ? await this.captureImage(wc).catch(() => null)
        : null;
    const pause: CheckoutPause = {
      need: input.need,
      fields: input.fields,
      // The bare registrable domain ("akasaair.com"): what the user is told.
      site:
        topOrigin != null
          ? registrableDomain(new URL(topOrigin).hostname)
          : null,
      amount,
      currency,
      merchant: input.merchant,
      cvvRequired: input.cvvRequired,
      summary: await this.pauseSummary(input, session, wc),
      mediaId: image != null ? this.keepAsMedia(image, sessionId) : null,
    };
    const held = session.checkout.pause(pause);
    if (held.ok === false) return this.err(`Not paused: ${held.reason}`);
    return this.ok(
      "Paused for the user. Your run ends here and the page stays as it is; write nothing more.\n" +
        checkoutStateLine({ stage: held.stage, paused: pause })
    );
  }

  /**
   * What a stop tells the user. A login stop on the page where the saved
   * login would not fill leads with the browser's own reason, beside the
   * model's: a guessed cause alone sends the user after a problem that is
   * not there.
   */
  private async pauseSummary(
    input: { need: string; summary: string },
    session: VaultSession,
    wc: BrowserPage | null
  ): Promise<string> {
    const refusal = session.loginRefusal;
    if (input.need !== "login" || refusal == null || wc == null)
      return input.summary;
    const { key } = await this.documentInfo(wc);
    if (key == null || key !== refusal.documentKey) return input.summary;
    // The browser's reason first, so the bound keeps it; the model's words
    // after. Waiting on the user's approval is not a page problem: said as such.
    return pageText(
      refusal.awaitingApproval
        ? `${refusal.reason} Agent: ${input.summary}`
        : `The browser could not fill the saved login: ${refusal.reason} Agent: ${input.summary}`,
      400
    );
  }

  /** `browser_checkout`: the agent runtime's handle on the session's checkout. */
  private executeCheckout(
    args: Record<string, unknown>,
    sessionId?: string
  ): ToolResult {
    if (sessionId == null)
      return this.err("A checkout belongs to a conversation.");
    // Only the agent runtime holds the token: no model can move a checkout.
    const expected = this.options.checkoutToken;
    if (
      expected == null ||
      typeof args.token !== "string" ||
      !tokensMatch(args.token, expected)
    )
      return this.err("Refused: browser_checkout is the agent runtime's own.");
    const session = this.vaultSession(sessionId);
    const checkout = session.checkout;
    const line = (extra: Partial<CheckoutStateLine> = {}): string =>
      checkoutStateLine({
        stage: checkout.stage,
        paused: checkout.paused,
        ...extra,
      });
    switch (args.action) {
      case "start":
        checkout.start();
        // A tab still on a payment step keeps it guarded across runs.
        session.forgetPaymentSteps(
          originOf(this.findView(sessionId)?.getURL() ?? "")
        );
        session.anchoredTotal = null;
        session.checkoutSite = null;
        session.loginItem = loginItemOf(args);
        session.loginRefusal = null;
        return this.ok(line());
      case "resume": {
        const paused = checkout.paused;
        const resumed = checkout.resume(
          this.options.vault?.approval(sessionId) ?? null
        );
        if (resumed.ok === false)
          return this.err(`${resumed.reason}\n${line()}`);
        // A login saved while the run waited comes with the resume, and a
        // refusal from before the user stepped in is not this run's reason.
        session.loginItem = loginItemOf(args) ?? session.loginItem;
        session.loginRefusal = null;
        // The user answered a details stop that named its site: saved
        // travelers fill on that site, and on no other, from here.
        if (
          args.answered === true &&
          paused?.need === "details" &&
          paused.site != null
        )
          session.checkoutSite = paused.site;
        return this.ok(line({ approved: resumed.approved }));
      }
      case "hold": {
        const held = checkout.pause({
          need: "user",
          fields: [],
          site: null,
          amount: null,
          currency: null,
          merchant: null,
          cvvRequired: false,
          summary: pageText(args.summary, 400),
          mediaId: null,
        });
        if (held.ok === false) return this.err(`${held.reason}\n${line()}`);
        return this.ok(line());
      }
      case "finish": {
        const ends: readonly RunEnd[] = [
          "completed",
          "turn-limit",
          "timeout",
          "error",
          "provider-error",
          "aborted",
        ];
        if (!ends.includes(args.end as RunEnd))
          return this.err(`end is one of ${ends.join(", ")}.`);
        checkout.finish(args.end as RunEnd);
        return this.ok(line());
      }
      case "abandon":
        checkout.abandon();
        return this.ok(line());
      case "state":
        return this.ok(line());
      default:
        return this.err("Unknown checkout action.");
    }
  }

  /**
   * `browser_traveler_fill`: a saved traveler's passport number typed into a
   * field of the page itself (never a frame), under the same checks as a
   * vault fill: an https page, the field focused in its own document with the
   * same origin right before typing, the value dropped after, the field
   * marked secret. Only in the user's own conversations.
   */
  private async executeTravelerFill(
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    if (sessionId == null || this.options.isOwnerSession?.(sessionId) !== true)
      return this.err(
        "Saved travelers are filled only in the user's own conversations."
      );
    const travelerId =
      typeof args.traveler_id === "string" ? args.traveler_id.trim() : "";
    const field = typeof args.field === "string" ? args.field : "";
    const ref = typeof args.ref === "string" ? args.ref : "";
    if (!TRAVELER_FILL_FIELDS.includes(field))
      return this.err(`field is one of ${TRAVELER_FILL_FIELDS.join(", ")}.`);
    const traveler = readTravelers(abacusBotHome()).find(
      (item) => item.id === travelerId
    );
    const value = traveler?.passport?.number ?? "";
    if (value.length === 0)
      return this.err(`No passport is saved for traveler ${travelerId}.`);

    const wc = await this.getWC(sessionId);
    if (!wc) return this.err(this.noBrowser(sessionId));
    const snapshot = this.snapshots.for(sessionId);
    if (snapshot.url != null && wc.getURL() !== snapshot.url)
      return this.err(
        `The page has navigated since the last snapshot (now at ${wc.getURL()}). ` +
          'Run browser_snapshot action:"snapshot" and use the field\'s fresh ref.'
      );
    const selector = snapshot.refMap.get(ref);
    if (selector == null)
      return this.err(this.refError(args, snapshot.refMap.size));
    if (snapshot.frameOf.get(ref) != null)
      return this.err(
        "Refused: a passport number is typed only into the page itself, not into a frame inside it."
      );
    const topOrigin = await this.liveOrigin(wc);
    if (topOrigin == null || !topOrigin.startsWith("https://"))
      return this.err(
        "Refused: a passport number is typed only into an https page."
      );
    // Only into the checkout under way, on its own site, once it is at the details.
    const session = this.vaultSession(sessionId);
    if (
      !TRAVELER_FILL_STAGES.has(session.checkout.stage) ||
      session.checkoutSite == null ||
      !onSite(new URL(topOrigin).hostname, session.checkoutSite)
    )
      return this.err(
        "Refused: a passport number is typed only into the booking under way, on its own site, from its traveler " +
          'details on. Stop with browser_pause need:"details" on that form first.'
      );
    // The same rules as a vault fill: a page a script ran on takes nothing.
    const { key: documentKey } = await this.documentInfo(wc);
    if (documentKey == null)
      return this.err(
        "The browser could not say which page this is, so nothing was filled. Snapshot and try again."
      );
    const secrets = this.secretsOf(wc);
    if (secrets.scriptPending() || secrets.scriptRan(documentKey))
      return this.err(
        "Refused: a script ran on this page since it loaded, so nothing is filled into it. " +
          "Reload the page, snapshot, and fill again without running scripts."
      );
    try {
      const located = (await this.cdp(wc, "Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        returnByValue: false,
        objectGroup: VAULT_OBJECT_GROUP,
      }).catch(() => null)) as { result?: { objectId?: string } } | null;
      const node = located?.result?.objectId;
      if (node == null) return this.err(this.notFoundError(args, selector));
      const live = (await this.callOn(wc, node, LIVE_FIELD_FUNCTION)) as {
        connected?: boolean;
        editable?: boolean;
        facts?: FieldFacts;
      } | null;
      if (live?.connected !== true)
        return this.err(this.notFoundError(args, selector));
      // The field as first seen and as it is now must both name a passport or ID number.
      const described = (await this.cdp(wc, "DOM.describeNode", {
        objectId: node,
      }).catch(() => null)) as { node?: { backendNodeId?: number } } | null;
      const backendNodeId = described?.node?.backendNodeId;
      const first =
        backendNodeId == null ? null : secrets.firstFacts(wc, backendNodeId);
      if (
        live.editable !== true ||
        first == null ||
        live.facts == null ||
        !passportField(first) ||
        !passportField(live.facts)
      )
        return this.err(
          `Refused: ${ref} is not clearly the passport or ID number field (its name, label or placeholder says ` +
            "so), so nothing was filled. Snapshot and pick that field."
        );
      // Hidden and locked before the value is here, as a vault fill is.
      if (!(await secrets.markFilledNode(wc, node).catch(() => false)))
        return this.err(
          `${ref} could not be marked as a secret field, so nothing was filled. Snapshot and try again.`
        );
      const outcome = await this.typeVaultValue(
        wc,
        wc,
        node,
        value,
        topOrigin,
        topOrigin,
        documentKey
      );
      if (outcome === "aborted")
        return this.err(
          `Stopped before typing: the page under ${ref} changed. Nothing was typed. Snapshot and try again.`
        );
      return outcome === "typed"
        ? this.ok(`Filled the passport number into ${ref} (hidden).`)
        : this.err(
            `${ref} did not take the passport number cleanly; it was hidden. Snapshot and check the form.`
          );
    } finally {
      await this.cdp(wc, "Runtime.releaseObjectGroup", {
        objectGroup: VAULT_OBJECT_GROUP,
      }).catch(() => undefined);
    }
  }

  /** An element the snapshot had and the page no longer has. */
  private static isVanished(result: ToolResult): boolean {
    const text = firstText(result);

    return text.includes("not found on the page");
  }

  private label(args: Record<string, unknown>): string {
    return (args.ref as string) ?? (args.selector as string) ?? "(no target)";
  }

  /** Each session's browser calls, in arrival order: the last one's settling, which the next waits for. */
  private readonly sessionQueues = new Map<string, Promise<void>>();

  /**
   * How much longer than a call may run a stuck call holds its session's
   * queue, from its start: long enough for the calls that arrived behind it
   * within this time to time out first.
   */
  private static readonly QUEUE_GRACE_MS = 5_000;

  private callTimeout(): number {
    return this.options.timeouts?.callMs ?? McpBrowserServer.CALL_TIMEOUT_MS;
  }

  /**
   * Runs `work` once every call the session made before it has settled. By
   * session, not by tab: a call resolves its tab when it runs, so a tab
   * switch cannot put two of the session's calls on its tabs at once. A call
   * that never settles holds the queue for a call's timeout plus a grace,
   * counted from when it starts; the calls that arrived behind it within the
   * grace of its start time out first, are cancelled and never start.
   */
  private async inSessionOrder<T>(
    key: string,
    work: () => Promise<T>
  ): Promise<T> {
    const before = this.sessionQueues.get(key) ?? Promise.resolve();
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const mine = before.then(() => {
      started();
      return work();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The hold runs from the work's start, not its arrival: a call that
    // waited in the queue still gets its full time once it runs.
    const settled = start
      .then(() =>
        Promise.race([
          mine.then(
            () => undefined,
            () => undefined
          ),
          new Promise<void>((resolve) => {
            timer = setTimeout(
              resolve,
              this.callTimeout() + McpBrowserServer.QUEUE_GRACE_MS
            );
            timer.unref?.();
          }),
        ])
      )
      .finally(() => clearTimeout(timer));
    this.sessionQueues.set(key, settled);
    try {
      return await mine;
    } finally {
      if (this.sessionQueues.get(key) === settled)
        this.sessionQueues.delete(key);
    }
  }
  /** Pages already told never to load anything from Abacus.AI. */
  private readonly abacusBlocked = new WeakSet<BrowserPage>();

  /**
   * The documents of the session's active tab (its page, then its
   * cross-origin frames) that hold a field a one-time code goes into, by
   * live origin; a bank's code is bound to one of them.
   */
  private async codePages(
    sessionId: string
  ): Promise<Array<{ origin: string; top: boolean }>> {
    const wc = this.findView(sessionId);
    if (wc == null) return [];
    const source = this.options.target?.();
    const documents: Array<{ page: BrowserPage; frameId: string | null }> = [
      { page: wc, frameId: null },
      ...(source?.frames?.(wc.id) ?? []).flatMap((frame) => {
        const page = source?.framePage?.(wc.id, frame.frameId);
        return page == null ? [] : [{ page, frameId: frame.frameId }];
      }),
    ];
    const found: Array<{ origin: string; top: boolean }> = [];
    for (const { page, frameId } of documents) {
      const origin = await this.liveOrigin(wc, frameId ?? undefined);
      if (origin == null || this.isAbacus(origin)) continue;
      const inputs = await this.readPage(
        page,
        DOCUMENT_INPUT_FACTS_SCRIPT
      ).catch(() => null);
      // The fill's own rule: a page counts only if a code could go into one of its fields.
      if (Array.isArray(inputs) && hasCodeField(inputs as FieldFacts[]))
        found.push({ origin, top: frameId == null });
    }
    return found;
  }

  /** Whether `url` is on one of Abacus.AI's hosts (see `abacusHostFence`). */
  private isAbacus(url: string | null): boolean {
    return isFencedUrl(url, abacusHostFence());
  }

  /**
   * Why a call may not run, checked before it does: it would open an
   * Abacus.AI page, run a script naming one, or act on a tab that is on one
   * now (a script's timer may have taken it there); such a tab is left for a
   * blank page. The page is also told, once, never to load anything from an
   * Abacus.AI host, so neither a script's fetch nor a navigation reaches one.
   */
  private async abacusFence(
    name: string,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult | null> {
    if (
      name === "browser_navigate" &&
      typeof args.url === "string" &&
      (args.action == null || args.action === "goto") &&
      this.isAbacus(args.url)
    )
      return this.err(ABACUS_REFUSAL);
    if (name === "browser_execute" && typeof args.code === "string") {
      const fence = abacusHostFence();
      const code = args.code.toLowerCase();
      if (
        [...fence.exact, ...fence.suffixes].some((host) =>
          code.includes(host.replace(/^\./, ""))
        )
      )
        return this.err(ABACUS_REFUSAL);
    }
    const wc = this.findView(sessionId);
    if (wc == null) return null;
    // A page that cannot be told to block them is not driven at all.
    if (!(await this.blockAbacus(wc)))
      return this.err(
        "This page could not be set up safely (the browser refused a setting), so nothing was done on it. " +
          "Navigate again, or open the page in a new tab."
      );
    const left = await this.leaveAbacusPage(sessionId);
    if (left != null) return left;
    // Acting on the page: its live origin, not the last reported URL.
    if (name !== "browser_snapshot" && name !== "browser_tabs") {
      const live = await this.liveOrigin(wc);
      if (live != null && this.isAbacus(live)) {
        await wc.loadURL("about:blank").catch(() => undefined);
        return this.err(ABACUS_REFUSAL);
      }
    }
    return null;
  }

  /**
   * Tells the page never to load anything from an Abacus.AI host; remembered
   * only once the browser took it. False when it would not.
   */
  private async blockAbacus(wc: BrowserPage): Promise<boolean> {
    if (this.abacusBlocked.has(wc)) return true;
    await this.cdp(wc, "Network.enable").catch(() => undefined);
    const set = await this.cdp(wc, "Network.setBlockedURLs", {
      urls: fenceBlockPatterns(abacusHostFence()),
    }).then(
      () => true,
      () => false
    );
    if (set) this.abacusBlocked.add(wc);
    return set;
  }

  /**
   * A call that ended on an Abacus.AI page (a redirect, a script, history)
   * leaves it for a blank page at once and is refused; null when it did not.
   */
  private async leaveAbacusPage(
    sessionId?: string
  ): Promise<ToolResult | null> {
    const wc = this.findView(sessionId);
    if (wc == null || !this.isAbacus(wc.getURL())) return null;
    await wc.loadURL("about:blank").catch(() => undefined);
    return this.err(ABACUS_REFUSAL);
  }

  /**
   * The page's main document, as a key that changes with every new document
   * (its loader; null when the browser cannot say), and the origins of its
   * frames, read from the browser now.
   */
  private async documentInfo(wc: BrowserPage): Promise<{
    key: string | null;
    frameId: string | null;
    frameOrigins: string[];
  }> {
    const tree = (await this.cdp(wc, "Page.getFrameTree").catch(
      () => null
    )) as { frameTree?: FrameTreeNode } | null;
    const origins: string[] = [];
    const walk = (node: FrameTreeNode | undefined): void => {
      for (const child of node?.childFrames ?? []) {
        const origin = child.frame?.securityOrigin ?? child.frame?.url ?? "";
        if (origin.length > 0) origins.push(origin);
        walk(child);
      }
    };
    walk(tree?.frameTree);
    for (const frame of this.options.target?.()?.frames?.(wc.id) ?? [])
      if (frame.origin != null) origins.push(frame.origin);
    const loader = tree?.frameTree?.frame?.loaderId;
    const frameId = tree?.frameTree?.frame?.id;
    return {
      // Null when the browser cannot say which document it is: callers refuse.
      key: typeof loader === "string" && loader.length > 0 ? loader : null,
      frameId:
        typeof frameId === "string" && frameId.length > 0 ? frameId : null,
      frameOrigins: origins,
    };
  }

  /**
   * The live origin of the page, or of one of its frames, evaluated in that
   * document now; null when it cannot say or the origin is opaque.
   */
  private async liveOrigin(
    wc: BrowserPage,
    frameId?: string
  ): Promise<string | null> {
    const source = this.options.target?.();
    if (source?.liveOrigin != null) return source.liveOrigin(wc.id, frameId);
    // The built-in view has no frames of its own to name; its page is asked directly.
    if (frameId != null) return null;
    // Asked as it is: this is what the fence checks, so it is not fenced itself.
    const evaluated = (await this.cdp(wc, "Runtime.evaluate", {
      expression: "location.origin",
      returnByValue: true,
    }).catch(() => null)) as { result?: { value?: unknown } } | null;
    const origin = evaluated?.result?.value;
    return typeof origin === "string" && origin !== "null" ? origin : null;
  }

  /**
   * Types one saved vault value into the field `ref` names, if it is that
   * value's kind of field. The origin the vault is told is the live page's
   * (or frame's), never an argument; a card's amount is the total the page
   * shows, read here from `total_ref`. The field is marked secret and the
   * tab locked before the value is asked for; it is typed only if, in one
   * evaluation right before, the field's document still has the planned
   * origins and the field has the focus, then dropped. The model is told
   * only that it was filled.
   */
  private async executeVaultFill(
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const vault = this.options.vault;
    if (vault == null) return this.err(VAULT_UNAVAILABLE);
    const itemId = typeof args.item_id === "string" ? args.item_id.trim() : "";
    const field = typeof args.field === "string" ? args.field : "";
    const ref = typeof args.ref === "string" ? args.ref : "";
    if (itemId.length === 0) return this.err("item_id is required.");
    if (field === "login") return this.executeLoginFill(itemId, sessionId);
    if (!(FILL_KINDS as readonly string[]).includes(field))
      return this.err(`field is one of login, ${FILL_KINDS.join(", ")}.`);
    const kind = field as FillKind;

    const wc = await this.getWC(sessionId);
    if (!wc) return this.err(this.noBrowser(sessionId));
    const snapshot = this.snapshots.for(sessionId);
    if (snapshot.url != null && wc.getURL() !== snapshot.url)
      return this.err(
        `The page has navigated since the last snapshot (now at ${wc.getURL()}). ` +
          'Run browser_snapshot action:"snapshot" and use the field\'s fresh ref.'
      );
    const selector = snapshot.refMap.get(ref);
    if (selector == null)
      return this.err(this.refError(args, snapshot.refMap.size));
    const frameId = snapshot.frameOf.get(ref) ?? null;
    const page = this.pageForRef(wc, ref, sessionId);
    if (page == null)
      return this.err(
        `The frame ${ref} was in has gone. Run browser_snapshot to see the page as it is now.`
      );

    // A script that ran on this document (or runs now) could be listening
    // for the value, have changed the field, or have written the total.
    const { key: documentKey } = await this.documentInfo(wc);
    if (documentKey == null)
      return this.err(
        "The browser could not say which page this is, so nothing was filled. Snapshot and try again."
      );
    if (
      this.secretsOf(wc).scriptPending() ||
      this.secretsOf(wc).scriptRan(documentKey)
    )
      return this.err(
        "Refused: a script ran on this page since it loaded, so nothing is filled into it. " +
          "Reload the page, snapshot, and fill again without running scripts."
      );
    const card = !["username", "password", "code"].includes(kind);
    const total = card
      ? await this.readTotal(wc, args.total_ref, sessionId)
      : null;
    // A card fill whose total the plan checked anchors that total for the Pay click.
    const anchorAfterPlan =
      total != null && typeof args.total_ref === "string"
        ? args.total_ref
        : null;
    const topOrigin = await this.liveOrigin(wc);
    const frameOrigin =
      frameId != null ? await this.liveOrigin(wc, frameId) : null;
    if (frameOrigin != null && this.isAbacus(frameOrigin))
      return this.err(ABACUS_REFUSAL);
    const plan = planFill({
      itemId,
      field: kind,
      topOrigin,
      frameOrigin,
      inFrame: frameId != null,
      approval: vault.approval(sessionId),
      signin: vault.signin(sessionId),
      pageTotal: total,
    });
    if (plan.ok === false) {
      // A login stop on this page says it waits on the user, not that the page failed.
      if (plan.awaitingApproval === true)
        this.vaultSession(sessionId).loginRefusal = {
          reason: plan.error,
          documentKey,
          awaitingApproval: true,
        };
      return this.err(plan.error);
    }
    // The plan checked this total against the approval. Anchored already (at
    // the payment pause), it must be that same element; otherwise it becomes
    // the one the Pay click re-reads.
    if (anchorAfterPlan != null) {
      const session = this.vaultSession(sessionId);
      if (session.anchoredTotal == null)
        this.anchorTotal(session, anchorAfterPlan, sessionId);
      else if (!this.isAnchoredTotal(session, anchorAfterPlan, sessionId))
        return this.err(TOTAL_NOT_ANCHORED);
    }
    // Taken now, before anything waits, so a second fill of this field is refused.
    for (const one of fieldsOf(kind)) plan.uses?.add(one);
    // The vault fields the vault handed over: spent, whatever happens next.
    const handed = new Set<VaultField>();
    const secrets = this.secretsOf(wc);

    try {
      // The node itself, held from here on: a field the page swaps out is not typed into.
      const located = (await this.cdp(page, "Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        returnByValue: false,
        objectGroup: VAULT_OBJECT_GROUP,
      }).catch(() => null)) as { result?: { objectId?: string } } | null;
      const node = located?.result?.objectId;
      if (node == null) return this.err(this.notFoundError(args, selector));
      const live = (await this.callOn(page, node, LIVE_FIELD_FUNCTION)) as {
        connected?: boolean;
        editable?: boolean;
        facts?: FieldFacts;
      } | null;
      if (live?.connected !== true)
        return this.err(this.notFoundError(args, selector));
      if (live.editable !== true)
        return this.err(
          `${ref} is disabled or read-only, so nothing was filled.`
        );
      // The field as first seen, before anything the agent did, and as it is now: both must fit.
      const described = (await this.cdp(page, "DOM.describeNode", {
        objectId: node,
      }).catch(() => null)) as { node?: { backendNodeId?: number } } | null;
      const backendNodeId = described?.node?.backendNodeId;
      const first =
        backendNodeId == null ? null : secrets.firstFacts(page, backendNodeId);
      if (first == null)
        return this.err(
          `${ref} was not on the page when it was last read, so it is not known what kind of field it is. Snapshot and fill again.`
        );
      const inPaymentFrame =
        frameId != null && isPaymentFrameOrigin(frameOrigin);
      if (
        live.facts == null ||
        !fieldKindAllowed(kind, first, inPaymentFrame) ||
        !fieldKindAllowed(kind, live.facts, inPaymentFrame)
      )
        return this.err(
          `Refused: ${ref} is not a field a ${field} goes into. ` +
            (field === "password"
              ? "A password goes only into a password field."
              : field === "username"
                ? "A username goes only into the sign-in form's username or email field."
                : field === "code"
                  ? "A code goes only into the one-time code field."
                  : kind === "card_exp"
                    ? "card_exp goes only into a single expiry field (MM/YY); for separate month and year fields use card_exp_month and card_exp_year."
                    : kind === "card_exp_month" || kind === "card_exp_year"
                      ? "An expiry month or year goes only into the card's expiry month or year field."
                      : kind === "cardholder_name"
                        ? "The cardholder name goes only into the card's name-on-card field."
                        : "A card number or CVV goes only into the checkout's card fields.") +
            " Snapshot and pick that field."
        );
      // A code goes into a field marked for one, or the page's only code-like field.
      if (field === "code") {
        const inputs = await this.readPage(
          page,
          DOCUMENT_INPUT_FACTS_SCRIPT
        ).catch(() => null);
        if (
          !Array.isArray(inputs) ||
          !codeFieldAllowed(live.facts, inputs as FieldFacts[]) ||
          !codeFieldAllowed(first, inputs as FieldFacts[])
        )
          return this.err(
            `Refused: ${ref} is not clearly the one-time code field (it is not marked as one, and the page has ` +
              "other fields like it, or it reads as a postcode or PIN). Report what the page asks for."
          );
      }
      // Hidden and locked before any value exists here: from now on the
      // field reads as hidden and the tab runs no scripts until it navigates.
      // A card fill also makes the field a card field for the Pay guard.
      if (card && backendNodeId != null)
        secrets.noteCardFill(page, backendNodeId);
      if (!(await secrets.markFilledNode(page, node).catch(() => false)))
        return this.err(
          `${ref} could not be marked as a secret field, so nothing was filled. Snapshot and try again.`
        );

      const expiryKind =
        kind === "card_exp" ||
        kind === "card_exp_month" ||
        kind === "card_exp_year"
          ? kind
          : null;
      // Shaped by length alone, so a field no form fits is refused before the vault is asked.
      if (
        expiryKind != null &&
        live.facts.tag !== "select" &&
        formatExpiry(expiryKind, { month: "12", year: "2030" }, live.facts) ==
          null
      )
        return this.err(
          `${ref} takes no usual form of a card expiry (its length allows none of MM/YY, MMYY or MM/YYYY). ` +
            'Do not type one yourself; stop with browser_pause need:"user" so the user completes it.'
        );
      // Every vault field the kind is made of, before anything is typed.
      const values = new Map<VaultField, string>();
      for (const one of fieldsOf(kind)) {
        const fetched = await vault.client.fill({
          itemId,
          field: one,
          ...plan.request,
        });
        if (fetched.ok === false) {
          // What the vault does not have (an older server, or not saved) is left to the user.
          const missing =
            CARD_DETAILS.has(one) &&
            (fetched.notFound === true || fieldUnsupported(fetched.error, one));
          return this.err(
            fetched.unavailable
              ? VAULT_UNAVAILABLE
              : missing
                ? CARD_DETAIL_UNSUPPORTED
                : values.size > 0
                  ? `The vault gave part of the ${field} but not the rest (${fetched.error}), so nothing was typed. ` +
                    'Do not type it yourself; stop with browser_pause need:"user" so the user completes it.'
                  : `The vault did not fill it: ${fetched.error}`
          );
        }
        handed.add(one);
        values.set(one, fetched.value);
      }
      const expiry = {
        month: values.get("card_exp_month") ?? "",
        year: values.get("card_exp_year") ?? "",
      };
      const select = live.facts.tag === "select";
      if (select && kind !== "card_exp_month" && kind !== "card_exp_year")
        return this.err(`${ref} is a list, not a field to type into.`);
      if (select) {
        const picked = await this.pickVaultOption(
          wc,
          page,
          node,
          selectCandidates(kind as "card_exp_month" | "card_exp_year", expiry),
          plan.documentOrigin,
          topOrigin!,
          documentKey
        );
        return picked === "picked"
          ? this.ok(`Chose the ${field} in ${ref} (hidden).`)
          : this.err(
              picked === "aborted"
                ? `Stopped before choosing: the page under ${ref} changed. Nothing was chosen. Snapshot and try again.`
                : `${ref} has no option for the card's ${field === "card_exp_month" ? "month" : "year"}. Do not choose one yourself; report what the list offers.`
            );
      }
      const value =
        expiryKind != null
          ? formatExpiry(expiryKind, expiry, live.facts)!
          : values.get(kind as VaultField)!;
      const outcome = await this.typeVaultValue(
        wc,
        page,
        node,
        value,
        plan.documentOrigin,
        topOrigin!,
        documentKey
      );
      if (outcome === "aborted")
        return this.err(
          `Stopped before typing: the page under ${ref} changed (it navigated or the field lost focus). ` +
            "Nothing was typed. Snapshot and check where the page is before trying again."
        );
      if (outcome === "moved")
        return this.err(
          `The focus left ${ref} while typing, so the ${field} may have gone into another field; that field was cleared ` +
            "and hidden. Snapshot and check the form before trying again."
        );
      if (outcome === "failed")
        return this.err(
          `${ref} did not take the value. Do not retry in a loop: snapshot to see the field, and report if it will not accept typing.`
        );
      const took = await this.callOn(
        page,
        node,
        "function() { return String(this.value || '').length > 0; }"
      );
      if (took === true) this.vaultSession(sessionId).loginRefusal = null;
      return took === true
        ? this.ok(`Filled ${field} into ${ref} (hidden).`)
        : this.err(
            `${ref} still looks empty after the ${field} was typed; the page may have replaced the field. Snapshot and check.`
          );
    } finally {
      // Not spent unless the vault handed the value over.
      // Only what the vault handed over is spent; the rest can be filled again.
      for (const one of fieldsOf(kind))
        if (!handed.has(one)) plan.uses?.delete(one);
      await this.cdp(page, "Runtime.releaseObjectGroup", {
        objectGroup: VAULT_OBJECT_GROUP,
      }).catch(() => undefined);
    }
  }

  /**
   * `browser_vault_fill field:"login"`: the saved login typed into the sign-in
   * form the host finds itself, from each document's DOM rather than the
   * snapshot: the one form with one password field and its username field,
   * or on a username-first step the one username field. Each field passes the
   * checks a fill by ref does (its kind as first seen and as it is now, the
   * plan's origins, no script on the page, the focus right before typing).
   * Why it did not fill is kept for a login stop on the same page.
   */
  private async executeLoginFill(
    // The model's item_id is not used: the login is the allowed sign-in's.
    _itemId: string,
    sessionId?: string
  ): Promise<ToolResult> {
    const session = this.vaultSession(sessionId);
    let documentKey: string | null = null;
    const refuse = (reason: string, awaitingApproval = false): ToolResult => {
      session.loginRefusal = { reason, documentKey, awaitingApproval };
      return this.err(reason);
    };
    const wc = await this.getWC(sessionId);
    if (!wc) return refuse(this.noBrowser(sessionId));
    documentKey = (await this.documentInfo(wc)).key;
    if (documentKey == null)
      return refuse(
        "The browser could not say which page this is, so nothing was filled. Snapshot and try again."
      );
    const secrets = this.secretsOf(wc);
    if (secrets.scriptPending() || secrets.scriptRan(documentKey))
      return refuse(
        "Refused: a script ran on this page since it loaded, so nothing is filled into it. " +
          "Reload the page, snapshot, and fill again without running scripts."
      );
    const topOrigin = await this.liveOrigin(wc);
    // The login is the one the user allowed a sign-in with, never an id the
    // model typed; an item whose sites the vault names must be for this page.
    const signin = session.allowedSignin();
    // No sign-in allowed: that is the reason, before any item or site one.
    if (signin == null) return refuse(NO_SIGNIN_REASON, true);
    const loginItemId = signin.item;
    const sites = await this.loginSites(loginItemId, sessionId);
    const host = httpsHost(topOrigin);
    if (
      sites != null &&
      sites.length > 0 &&
      host != null &&
      !sites.some((site) => onSite(host, site))
    )
      return refuse(
        `Refused: the saved login ${loginItemId} is for ${sites.join(", ")}, and this page is ${host}. ` +
          "Nothing was filled. Go to that site's sign-in page."
      );

    // The tab's own document first, then the cross-origin frames it can reach.
    const documents: Array<{
      page: BrowserPage;
      frameId: string | null;
      frameOrigin: string | null;
    }> = [{ page: wc, frameId: null, frameOrigin: null }];
    const source = this.options.target?.();
    for (const frame of (source?.frames?.(wc.id) ?? []).slice(
      0,
      McpBrowserServer.MAX_SNAPSHOT_FRAMES
    )) {
      const page = source?.framePage?.(wc.id, frame.frameId) ?? null;
      const origin = await this.liveOrigin(wc, frame.frameId);
      if (page == null || origin == null || this.isAbacus(origin)) continue;
      documents.push({ page, frameId: frame.frameId, frameOrigin: origin });
    }

    try {
      const candidates: Array<LoginCandidate<string>> = [];
      const counts = { inputs: 0, unusable: 0 };
      for (const [index, { page }] of documents.entries()) {
        const dom = (await this.cdp(page, "DOM.getDocument", {
          depth: -1,
        }).catch(() => null)) as { root?: DomNode } | null;
        if (dom?.root == null) continue;
        const facts = factsFromDocument(dom.root);
        // Seen now for the first time if no snapshot saw it: no script has run here.
        secrets.recordFields(page, facts);
        for (const backendNodeId of facts.keys()) {
          const first = secrets.firstFacts(page, backendNodeId);
          if (first == null || !LOGIN_TEXT_ENTRY.has(first.type)) continue;
          counts.inputs += 1;
          const kind = fieldKindAllowed("password", first, false)
            ? "password"
            : fieldKindAllowed("username", first, false)
              ? "username"
              : null;
          if (kind == null) continue;
          const resolved = (await this.cdp(page, "DOM.resolveNode", {
            backendNodeId,
            objectGroup: VAULT_OBJECT_GROUP,
          }).catch(() => null)) as { object?: { objectId?: string } } | null;
          const objectId = resolved?.object?.objectId;
          if (objectId == null) continue;
          const live = (await this.callOn(
            page,
            objectId,
            LOGIN_FIELD_FUNCTION
          )) as {
            connected?: boolean;
            editable?: boolean;
            shown?: boolean;
            form?: number;
            facts?: FieldFacts;
          } | null;
          if (
            live?.connected !== true ||
            live.facts == null ||
            !fieldKindAllowed(kind, live.facts, false)
          )
            continue;
          if (live.shown !== true || live.editable !== true) {
            counts.unusable += 1;
            continue;
          }
          candidates.push({
            handle: objectId,
            document: index,
            form: typeof live.form === "number" ? live.form : -1,
            kind,
            facts: live.facts,
          });
        }
      }

      const choice = chooseLoginFields(candidates, counts);
      if (choice.ok === false) return refuse(choice.error);
      // Abacus.AI's own frames were left out of `documents` above.
      const { page, frameId, frameOrigin } = documents[choice.document]!;
      // This document's refs, to name the fields and the button in the result.
      const snapshot = this.snapshots.for(sessionId);
      const pairs = [...snapshot.refMap].filter(
        ([ref]) => (snapshot.frameOf.get(ref) ?? null) === frameId
      );
      const refOf = async (objectId: string): Promise<string | null> => {
        const ref = await this.callOn(page, objectId, REF_OF_FUNCTION, [pairs]);
        return typeof ref === "string" ? ref : null;
      };

      // What the form's button and the page say it is, before anything is typed.
      const anchor = choice.password ?? choice.username!;
      const context = (await this.callOn(page, anchor, LOGIN_CONTEXT_FUNCTION, [
        pairs,
      ])) as {
        submit?: { ref?: unknown; label?: unknown } | null;
        page?: unknown;
      } | null;
      const submit =
        context?.submit != null
          ? {
              ref:
                typeof context.submit.ref === "string"
                  ? context.submit.ref
                  : null,
              label: pageText(context.submit.label, 200),
            }
          : null;
      const purpose = loginPurpose({
        label: submit?.label ?? null,
        page: typeof context?.page === "string" ? context.page : "",
        usernameOnly: choice.password == null,
      });
      if (purpose.ok === false) return refuse(purpose.error);

      const filled: { username: string | null; password: string | null } = {
        username: null,
        password: null,
      };
      // A username filled under this sign-in whose password was not (it
      // failed before the vault handed it over, or the site asks again on
      // its password step) is left as it is: the retry fills the password.
      const usernameKept =
        choice.password != null &&
        signin.used.has("username") &&
        !signin.used.has("password");
      for (const field of ["username", "password"] as const) {
        const node = choice[field];
        if (node == null) continue;
        if (field === "username" && usernameKept) continue;
        const name = fieldName(await refOf(node), field);
        const failure = await this.fillLoginField({
          wc,
          page,
          node,
          itemId: loginItemId,
          field,
          sessionId,
          topOrigin,
          frameId,
          frameOrigin,
          documentKey,
        });
        if (failure != null)
          return refuse(
            filled.username != null
              ? `The username was filled into ${filled.username}, but the password was not: ${failure.reason}`
              : failure.reason,
            failure.awaitingApproval
          );
        filled[field] = name;
      }

      session.loginRefusal = null;
      return this.ok(
        loginFilledText({
          ...filled,
          usernameKept,
          // A button that does not read as signing in is never named as the next click.
          submit: submitName(purpose.nameButton ? submit : null),
        })
      );
    } finally {
      for (const { page } of documents)
        await this.cdp(page, "Runtime.releaseObjectGroup", {
          objectGroup: VAULT_OBJECT_GROUP,
        }).catch(() => undefined);
    }
  }

  /**
   * One field of a login fill, held as `node`: planned for its own document,
   * marked secret before the value exists here, typed, and checked. Null when
   * it took the value; otherwise why not (and whether it only waits on the
   * user's sign-in approval), with nothing typed elsewhere.
   */
  private async fillLoginField(input: {
    wc: BrowserPage;
    page: BrowserPage;
    node: string;
    itemId: string;
    field: "username" | "password";
    sessionId: string | undefined;
    topOrigin: string | null;
    frameId: string | null;
    frameOrigin: string | null;
    documentKey: string;
  }): Promise<LoginFieldFailure | null> {
    const { field } = input;
    const vault = this.options.vault!;
    const plan = planFill({
      itemId: input.itemId,
      field,
      topOrigin: input.topOrigin,
      frameOrigin: input.frameOrigin,
      inFrame: input.frameId != null,
      approval: vault.approval(input.sessionId),
      signin: vault.signin(input.sessionId),
      pageTotal: null,
    });
    if (plan.ok === false)
      return {
        reason: plan.error,
        awaitingApproval: plan.awaitingApproval === true,
      };
    // Taken now, as a fill by ref takes it: a value filled once under an
    // approval is not filled again, and is given back if the vault never
    // handed it over.
    plan.uses?.add(field);
    let delivered = false;
    try {
      return await this.typeLoginValue(input, plan, () => {
        delivered = true;
      });
    } finally {
      if (!delivered) plan.uses?.delete(field);
    }
  }

  /** The marking, fetching and typing of one login field under its plan. */
  private async typeLoginValue(
    input: {
      wc: BrowserPage;
      page: BrowserPage;
      node: string;
      itemId: string;
      field: "username" | "password";
      topOrigin: string | null;
      documentKey: string;
    },
    plan: Extract<ReturnType<typeof planFill>, { ok: true }>,
    handedOver: () => void
  ): Promise<LoginFieldFailure | null> {
    const failed = (reason: string): LoginFieldFailure => ({
      reason,
      awaitingApproval: false,
    });
    const { wc, page, node, field } = input;
    const vault = this.options.vault!;
    const secrets = this.secretsOf(wc);
    if (!(await secrets.markFilledNode(page, node).catch(() => false)))
      return failed(
        `the ${field} field could not be marked as a secret field, so nothing was typed into it. Snapshot and try again.`
      );
    const fetched = await vault.client.fill({
      itemId: input.itemId,
      field,
      ...plan.request,
    });
    if (fetched.ok === false)
      return failed(
        fetched.unavailable
          ? VAULT_UNAVAILABLE
          : `The vault did not fill it: ${fetched.error}`
      );
    handedOver();
    const outcome = await this.typeVaultValue(
      wc,
      page,
      node,
      fetched.value,
      plan.documentOrigin,
      input.topOrigin!,
      input.documentKey
    );
    if (outcome === "aborted")
      return failed(
        `Stopped before typing the ${field}: the page changed (it navigated or the field lost focus). Snapshot and check where the page is.`
      );
    if (outcome === "moved")
      return failed(
        `The focus left the ${field} field while typing, so the value may have gone into another field; that field was cleared and hidden. Snapshot and check the form.`
      );
    if (outcome === "failed")
      return failed(
        `The ${field} field did not take the value. Do not retry in a loop: snapshot, and report if it will not accept typing.`
      );
    const took = await this.callOn(
      page,
      node,
      "function() { return String(this.value || '').length > 0; }"
    );
    return took === true
      ? null
      : failed(
          `The ${field} field still looks empty after typing; the page may have replaced it. Snapshot and check.`
        );
  }

  /**
   * The sites a saved login is for, as the vault lists them; null when the
   * vault cannot say. Kept on the session for the run's login; a failed read
   * is not asked again for a minute, so a snapshot never waits on it.
   */
  private async loginSites(
    itemId: string,
    sessionId?: string
  ): Promise<string[] | null> {
    const vault = this.options.vault;
    if (vault == null) return null;
    const login = this.vaultSession(sessionId).loginItem;
    const kept = login?.itemId === itemId ? login : null;
    if (kept?.sites != null) return kept.sites;
    if (kept != null && Date.now() < kept.retryAt) return null;
    const items = await vault.client.listItems();
    if (items.ok === false) {
      if (kept != null) kept.retryAt = Date.now() + LOGIN_SITES_RETRY_MS;
      return null;
    }
    const sites = (
      items.value.items.find((item) => item.itemId === itemId)?.sites ?? []
    ).filter((site) => /^[a-z0-9.-]{1,253}$/i.test(site));
    if (kept != null) kept.sites = sites;
    return sites;
  }

  /**
   * A line for a page on the site of the saved login the run was handed, when
   * the page shows a sign-in field: so the run uses the vault rather than
   * stopping. Null otherwise, or when the vault cannot say the login's sites.
   */
  private async loginHint(
    wc: BrowserPage,
    sessionId?: string
  ): Promise<string | null> {
    if (this.options.vault == null || sessionId == null) return null;
    const login = this.vaultSession(sessionId).loginItem;
    if (login == null) return null;
    const host = httpsHost(await this.liveOrigin(wc));
    if (host == null) return null;
    const sites = await this.loginSites(login.itemId, sessionId);
    const site = sites?.find((each) => onSite(host, each));
    if (site == null) return null;
    if ((await this.readPage(wc, LOGIN_FORM_PRESENT_SCRIPT)) !== true)
      return null;
    return (
      `A saved login for ${site} can be filled here: browser_vault_fill item_id:"${login.itemId}" field:"login" ` +
      "(the browser finds the username and password fields itself)."
    );
  }

  /** A function run on a remote object of `page`; its value, or null when it failed. */
  private async callOn(
    page: BrowserPage,
    objectId: string,
    functionDeclaration: string,
    args?: unknown[]
  ): Promise<any> {
    const response = (await this.cdp(page, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      ...(args != null ? { arguments: args.map((value) => ({ value })) } : {}),
      returnByValue: true,
    }).catch(() => null)) as {
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    } | null;
    if (response == null || response.exceptionDetails != null) return null;
    return response.result?.value ?? null;
  }

  /**
   * The checkout total the element `totalRef` shows, read here; null when no
   * ref was given or it does not show one total.
   */
  private async readTotal(
    wc: BrowserPage,
    totalRef: unknown,
    sessionId?: string
  ): Promise<PageTotal | null> {
    if (typeof totalRef !== "string") return null;
    const selector = this.snapshots.for(sessionId).refMap.get(totalRef);
    const page = this.pageForRef(wc, totalRef, sessionId);
    if (selector == null || page == null) return null;
    const text = await this.readPage(page, totalTextScript(selector)).catch(
      () => null
    );
    return typeof text === "string" ? readPageTotal(text) : null;
  }

  /**
   * Chooses the option of the select `node` that is one of `candidates`,
   * under the same checks as typing: the same document, no script on it,
   * the node focused in its document with the planned origins.
   */
  private async pickVaultOption(
    wc: BrowserPage,
    page: BrowserPage,
    node: string,
    candidates: string[],
    documentOrigin: string,
    topOrigin: string,
    documentKey: string
  ): Promise<"picked" | "aborted" | "none"> {
    page.focus();
    const now = await this.documentInfo(wc);
    if (now.key !== documentKey || this.secretsOf(wc).scriptRan(documentKey))
      return "aborted";
    await this.cdp(wc, "Emulation.setFocusEmulationEnabled", {
      enabled: true,
    }).catch(() => undefined);
    const armed = await this.callOn(page, node, ARM_FUNCTION);
    if (
      armed?.focused !== true ||
      armed.origin !== documentOrigin ||
      armed.top !== topOrigin
    )
      return "aborted";
    const response = (await this.cdp(page, "Runtime.callFunctionOn", {
      objectId: node,
      functionDeclaration: SELECT_OPTION_FUNCTION,
      arguments: [{ value: candidates }],
      returnByValue: true,
    }).catch(() => null)) as { result?: { value?: unknown } } | null;
    return response?.result?.value === true ? "picked" : "none";
  }

  /**
   * Types `value` into the node and lets go of it. "aborted": nothing was
   * typed, since the node's document no longer had the planned origins, or
   * the node (in a focused document) did not have the focus. "moved": the
   * focus left the node while typing; whatever took the text, in whichever
   * of the tab's documents has the focus, was cleared and marked filled.
   */
  private async typeVaultValue(
    wc: BrowserPage,
    page: BrowserPage,
    node: string,
    value: string,
    documentOrigin: string,
    topOrigin: string,
    documentKey: string
  ): Promise<"typed" | "aborted" | "moved" | "failed"> {
    page.focus();
    // Still the same document, and still no script on it (the tab's calls run
    // one at a time, so none can start between this and the typing).
    const now = await this.documentInfo(wc);
    if (now.key !== documentKey || this.secretsOf(wc).scriptRan(documentKey))
      return "aborted";
    // A hidden or headless page reports no focus at all; this makes it report the real one.
    await this.cdp(wc, "Emulation.setFocusEmulationEnabled", {
      enabled: true,
    }).catch(() => undefined);
    const armed = await this.callOn(page, node, ARM_FUNCTION);
    if (
      armed?.focused !== true ||
      armed.origin !== documentOrigin ||
      armed.top !== topOrigin
    )
      return "aborted";
    try {
      await this.cdp(page, "Input.insertText", { text: value });
    } catch {
      // The browser's reason is not passed on: it says nothing safe to repeat.
      return "failed";
    }
    if ((await this.callOn(page, node, STILL_FOCUSED_FUNCTION)) === true)
      return "typed";
    await this.clearFocused(wc);
    return "moved";
  }

  /** Empties and hides whatever has the focus in any of the tab's documents. */
  private async clearFocused(wc: BrowserPage): Promise<void> {
    const source = this.options.target?.();
    const documents: BrowserPage[] = [
      wc,
      ...(source?.frames?.(wc.id) ?? []).flatMap(
        (frame) => source?.framePage?.(wc.id, frame.frameId) ?? []
      ),
    ];
    for (const document of documents) {
      const focused = (await this.cdp(document, "Runtime.evaluate", {
        expression: "document.hasFocus() ? document.activeElement : null",
        returnByValue: false,
        objectGroup: VAULT_OBJECT_GROUP,
      }).catch(() => null)) as { result?: { objectId?: string } } | null;
      const other = focused?.result?.objectId;
      if (other == null) continue;
      await this.callOn(document, other, CLEAR_FUNCTION);
      await this.secretsOf(wc)
        .markFilledNode(document, other)
        .catch(() => false);
      await this.cdp(document, "Runtime.releaseObjectGroup", {
        objectGroup: VAULT_OBJECT_GROUP,
      }).catch(() => undefined);
    }
  }

  private refError(args: Record<string, unknown>, loaded: number): string {
    if (args.ref) {
      return (
        `Ref ${args.ref} not found in current ref map (${loaded} refs loaded). ` +
        'Refs expire after any page change or navigation. Run browser_snapshot action:"snapshot" to get fresh refs.'
      );
    }
    return 'A ref is required. Run browser_snapshot action:"snapshot" first, then use an @eN ref from the output.';
  }

  private notFoundError(args: Record<string, unknown>, sel: string): string {
    const ref = args.ref as string | undefined;
    if (ref) {
      return (
        `Element for ${ref} not found on the page (selector: ${sel}). ` +
        'The page may have changed since the last snapshot. Run browser_snapshot action:"snapshot" to get fresh refs.'
      );
    }
    return `Element not found: ${sel}. The page DOM may have changed. Take a new snapshot and use @eN refs instead of CSS selectors.`;
  }
}
