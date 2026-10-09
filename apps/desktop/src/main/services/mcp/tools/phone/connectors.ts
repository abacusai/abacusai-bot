import { PHONE_CONNECTABLE_SERVICES } from "@abacus-ai/agent/tool-policy";
import { CONNECTORS } from "@abacus-ai/connectors/registry";

import { fetchAbacusAccount, onFreePlan } from "../../../providers/abacus";
import {
  type BillingPlan,
  fetchBillingPlan,
} from "../../../providers/abacus-upgrade";
import type { ConnectOutcome, DisconnectOutcome } from "../connect-outcome";
import type { ToolHost, ToolResult } from "../definition";
import type { PhoneToolDefinition } from "./definition";

/** What a WhatsApp user can connect from their chat: the phone's account services. */
const CONNECTABLE = CONNECTORS.filter(
  (item) =>
    item.kind === "platform" &&
    PHONE_CONNECTABLE_SERVICES.includes(item.service)
);

const options = (items: ReadonlyArray<{ id: string; name: string }>): string =>
  items
    .filter((item) => CONNECTABLE.some((connector) => connector.id === item.id))
    .map((item) => `${item.name} (${item.id})`)
    .join(", ");

/** A chat app or tool server: nothing the WhatsApp chat can connect or use. */
const cannotUse = (host: Pick<ToolHost, "ok">, name: string): ToolResult =>
  host.ok(
    `${name} cannot be connected or used from WhatsApp. Say so plainly in one short line, and do whatever part ` +
      "of the task does not need it."
  );

/** What the phone's model is told about an ask. */
export function phoneConnectResult(
  host: Pick<ToolHost, "ok" | "err">,
  outcome: ConnectOutcome
): ToolResult {
  switch (outcome.code) {
    case "no_connectors":
      return host.ok(
        "Connecting services is not available right now. Say so plainly, and do whatever part of the task does not need one."
      );
    case "list":
      return host.ok(
        [
          "The user's services you can connect from this chat:",
          "",
          ...outcome.entries
            .filter(
              ({ connector, status }) =>
                CONNECTABLE.includes(connector) ||
                (connector.kind === "platform" && status.state === "connected")
            )
            .map(({ connector, status }) => {
              const account =
                status.account != null && status.account.length > 0
                  ? ` as ${status.account}`
                  : "";
              return `${connector.id}  ${connector.name}  ${
                status.state === "connected"
                  ? `connected${account}`
                  : "not connected: ask for it with this tool"
              }`;
            }),
          "",
          "A connected one's tools are already in your tool list: use those, and do not guess a tool name. The account",
          'it is connected as is the user\'s own: it is who "me" and "myself" mean, so do not ask them for it.',
          "Any other service cannot be connected from this chat. If the user asks for one, call this tool with it",
          "and follow its answer.",
        ].join("\n")
      );
    case "ambiguous":
      return host.ok(
        `"${outcome.asked}" matches more than one service: ${options(outcome.options)}. Ask again with one of those.`
      );
    case "unknown":
      return host.ok(
        `There is no service called "${outcome.asked}" that can be connected from this chat. These can: ${options(outcome.options)}.`
      );
    case "connected":
      if (outcome.kind !== "platform") return cannotUse(host, outcome.name);
      return host.ok(
        `${outcome.name} is already connected${outcome.account != null ? ` as ${outcome.account}` : ""}. ` +
          "Its tools are in your tool list: use them. There is nothing to ask the user for, and that account is who " +
          'they mean by "me".'
      );
    case "unavailable":
      return host.ok(
        `${outcome.name} cannot be connected right now${
          outcome.reason === "not-offered"
            ? ": the user's Abacus.AI account does not offer it"
            : ""
        }. Say so plainly, and do whatever part of the task does not need it.`
      );
    case "not_here":
      return host.ok(
        `${outcome.name} cannot be connected from WhatsApp. No link was made: send none, and promise no date. ` +
          "Say so plainly in one short line, in the user's language, and do whatever part of the task does not need it."
      );
    case "no_link":
      return cannotUse(host, outcome.name);
    case "reconnect":
      return host.ok(
        [
          `The account already has ${outcome.names.join(", ")} connected with every permission, though your tool list ` +
            "may not have caught up yet. If their tools are in your list, use them and send nothing. Only if they are " +
            "missing or fail for lack of access, send the user this link to reconnect:",
          outcome.url,
          "",
          "Put it in a message of its own with one short line in the user's language, saying it reconnects the account. " +
            "Copy it exactly. This call does not wait: you will be told when the reconnect lands.",
        ].join("\n")
      );
    case "link": {
      const covered = outcome.asking.join(", ");
      return host.ok(
        [
          ...(outcome.already.length > 0
            ? [
                `${outcome.already.join(", ")} ${outcome.already.length > 1 ? "are" : "is"} already connected. ` +
                  `This link asks only for ${covered}.`,
              ]
            : []),
          `Send the user this link to connect ${covered}:`,
          outcome.url,
          "",
          "Put it in a message of its own with one short line in the user's language. Copy it exactly; never shorten " +
            "or reword it. It opens the provider's own sign-in." +
            (outcome.asking.length > 1
              ? " The sign-in may show a checkbox for each; what is left unticked is not connected."
              : ""),
          "This call does not wait. Carry on with whatever does not need it. You will be told when it is connected, and " +
            "its tools are in your tool list then. Until then do not send the link again unless the user asks for it.",
        ].join("\n")
      );
    }
  }
}

/** The upgrades on offer, from the platform's own offer: prices, credits, features and links. */
const offerLines = (billing: BillingPlan): string[] =>
  billing.upgrades.flatMap((upgrade) => {
    const credits = billing.plans.find(
      (plan) => plan.plan === upgrade.plan
    )?.creditsPerMonth;
    return [
      `${upgrade.planName}: ${upgrade.priceText}` +
        (credits != null
          ? `, ${Math.round(credits).toLocaleString("en-US")} credits a month`
          : "") +
        (upgrade.url != null ? `, link: ${upgrade.url}` : ""),
      ...upgrade.features.map((feature) => `  - ${feature}`),
    ];
  });

/**
 * A service the phone does not connect. On the free plan it is the upgrade's
 * moment, from the platform's own offer; a paid user is pointed to the
 * ChatLLM app, where a connection made reaches the phone too.
 */
export function phoneNotHereResult(
  host: Pick<ToolHost, "ok">,
  name: string,
  plan: { free: false } | { free: true; billing: BillingPlan | null }
): ToolResult {
  const noLink = `${name} cannot be connected from WhatsApp, and no link was made for it: send none, and promise no date.`;
  if (!plan.free)
    return host.ok(
      [
        noLink,
        "Tell the user plainly in one short message, in their language: it cannot be connected from WhatsApp, and if",
        "they connect it in the ChatLLM app, you can use it for them here too. Do not pitch an upgrade. Then do",
        `whatever part of the task does not need ${name}.`,
      ].join("\n")
    );
  const billing = plan.billing;
  const offer =
    billing == null || billing.upgrades.length === 0
      ? [
          "The upgrade offer cannot be read here: call billing_plan with upgrade: true for its prices and link, and",
          "use those.",
        ]
      : [
          "The offer, the only prices, credits and features you may give:",
          ...offerLines(billing),
          billing.upgradeInMobileApp
            ? "Their plan is billed through the app store: they upgrade in the mobile app, under Settings. Say so instead of a link."
            : "Give each link exactly as written, on its own line.",
        ];
  return host.ok(
    [
      noLink,
      "",
      "The user is on the free plan. Tell them, in their language and as one WhatsApp message, that connecting",
      `${name} is not part of the free plan on WhatsApp, then pitch the upgrade. Upgrading also gives them the ChatLLM`,
      "app on their phone, where they can:",
      "  - connect Slack, Outlook, Jira and many more apps, which you can then use for them here on WhatsApp too;",
      "  - build and deploy apps, mobile apps included;",
      "  - generate images and video;",
      "  - use the top models.",
      "",
      ...offer,
      "",
      "Never invent a price, a feature or a link. Give this full pitch at most once in this conversation: if you",
      `already gave it, say in one short line that connecting ${name} comes with an upgrade, and point back to the`,
      `upgrade link. Then do whatever part of the task does not need ${name}.`,
    ].join("\n")
  );
}

/** The user's plan, read only when a service the phone does not connect is asked for. */
const planForUpgrade = async (): Promise<
  { free: false } | { free: true; billing: BillingPlan | null }
> =>
  onFreePlan(await fetchAbacusAccount())
    ? { free: true, billing: await fetchBillingPlan(true) }
    : { free: false };

/** What the phone's model is told about a disconnect. */
export function phoneDisconnectResult(
  host: Pick<ToolHost, "ok" | "err">,
  outcome: DisconnectOutcome
): ToolResult {
  switch (outcome.code) {
    case "required":
      return host.err('A service is required, e.g. "googlecalendar".');
    case "ambiguous":
      return host.ok(
        `"${outcome.asked}" matches more than one service: ${options(outcome.options)}. Ask again with one of those.`
      );
    case "unknown":
      return host.err(
        `There is no service called "${outcome.asked}". Call connect_connector with no arguments for the list.`
      );
    case "platform_off":
      return host.ok(
        `${outcome.name} cannot be disconnected from WhatsApp, and nothing was changed. Say so plainly.`
      );
    case "no_messaging":
    case "no_connectors":
      return host.ok(
        "Disconnecting is not available right now, and nothing was changed. Say so plainly."
      );
    case "not_connected":
      return host.ok(
        `${outcome.name} is not connected: nothing was disconnected.`
      );
    case "failed":
      return host.ok(
        "The disconnect did not go through, and nothing was changed. Say so plainly; trying again later may work."
      );
    case "disconnected":
      return host.ok(
        `${outcome.name} is disconnected. Its tools are gone from your tool list; connect_connector reconnects it ` +
          "if the user wants it again."
      );
  }
}

export const PHONE_CONNECTORS_TOOLS: PhoneToolDefinition[] = [
  {
    surface: "phone",
    name: "connect_connector",
    toolsets: ["connectors"],
    description: [
      "Get one of the user's services connected from this chat, without ending or holding the turn. The services:",
      `${CONNECTABLE.map((item) => item.name).join(", ")}. Asked for any other, call it anyway with that service:`,
      "its answer says what to tell the user. One the user already connected elsewhere works here too.",
      "",
      "Call it with no arguments to see each one, connected or not, and the account behind each connected one: that",
      'account is who the user means by "me", so read it here instead of asking. Call it with a service to ask for',
      "that one. It answers at once with a link to send the user (one Google sign-in covers Gmail, Drive and",
      "Calendar). Carry on meanwhile; you are told when it is connected, and its tools are in your tool list then.",
      "",
      "When the task plainly needs a missing service, call this right away: the link is the question. Do not ask",
      "permission first, and do not end the turn saying something is missing without having sent the link.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description:
            'The service to ask for, e.g. "gmail". Omit to list them.',
        },
        reason: {
          type: "string",
          description: "One line on why you need it.",
        },
      },
    },
    run: async (host, args, callerSession) => {
      const outcome = await host.connectConnectorOutcome(args, callerSession, {
        card: false,
        services: PHONE_CONNECTABLE_SERVICES,
      });
      return outcome.code === "not_here"
        ? phoneNotHereResult(host, outcome.name, await planForUpgrade())
        : phoneConnectResult(host, outcome);
    },
  },
  {
    surface: "phone",
    name: "disconnect_connector",
    toolsets: ["connectors"],
    description: [
      "Disconnect one of the user's services (Gmail, Google Calendar, Drive, ...) when they ask for that. Only on",
      "their explicit request, never on your own judgement. It undoes cleanly: connect_connector reconnects it.",
      "Before disconnecting something a routine of yours depends on, say what will break.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: 'The service to disconnect, e.g. "googlecalendar".',
        },
      },
      required: ["service"],
    },
    run: async (host, args) =>
      phoneDisconnectResult(
        host,
        await host.disconnectConnectorOutcome(args, { chatApps: false })
      ),
  },
];
