/**
 * The round-trip behind the `connect_connector` tool: the agent loop stays
 * suspended in the call until the user connects, declines, or the hop fails.
 * The model gets a sentence back, never a tool error, which would only invite
 * a retry of a declined ask. Every ask is filed under its conversation, and
 * only that conversation can list, answer or release it.
 */
import type {
  ConnectorRequest,
  IpcEvent,
  RespondConnectorRequest,
} from "#shared/contracts";
import type { ConversationKey } from "#shared/conversation-scope";

type EmitEvent = (event: IpcEvent) => void;

/** Who a just-connected connector is connected as, when the platform says. */
type DescribeAccount = (connectorId: string) => Promise<string | null>;

/**
 * Started when an ask goes up, awaited when it is answered "connected": have
 * the connector's tools reached the session that asked? "Its tools are in
 * your tool list now" was said the moment the account attached, while the
 * tools arrived with the next refresh, and the model answered in between
 * that it could not see them.
 */
export type WatchToolsArrival = (input: {
  connectorId: string;
  callerSession: string;
}) => () => Promise<"arrived" | "pending">;

/** What the model reads when the tools have not landed by the time it is told. */
export const TOOLS_PENDING_HINT =
  "Its tools are being added to your tool list now and will be announced in this " +
  "conversation the moment they land. Wait for that note before calling one; " +
  "do not report that you lack them, and never guess a name.";

/** What the tool call resolves to, in the model's own reading. */
export const CONNECTOR_OUTCOME_TEXT: Record<
  RespondConnectorRequest["outcome"],
  (label: string, detail?: string, connectedHint?: string) => string
> = {
  // Two things the model does not otherwise learn: what just became usable
  // (it guesses tool names otherwise), and that the attached account is "me".
  connected: (label, account, connectedHint) =>
    `${label} is connected now${
      account != null && account.length > 0 ? `, as ${account}` : ""
    }. Carry on with what you were doing. Do not ask again${
      account != null && account.length > 0
        ? `, and do not ask the user who they are on ${label}: that account is who they mean by "me"`
        : ""
    }. ${
      connectedHint ??
      "Its tools are in your tool list now. Call one you can actually see, never a name you have guessed at."
    }`,
  declined: (label) =>
    `The user did not connect ${label}. Do not ask again in this turn: say what you cannot do without it, and offer whatever part of the task does not need it.`,
  failed: (label, error) =>
    `Connecting ${label} failed${error != null && error.length > 0 ? `: ${error}` : ""}. Tell the user, and offer whatever part of the task does not need it.`,
};

export class ConnectorGate {
  /** Asks the agent is blocked on, keyed by request id. */
  private readonly pending = new Map<
    string,
    {
      connectorId: string;
      label: string;
      request: ConnectorRequest;
      /** What became usable on connect, when it is not MCP tools. */
      connectedHint?: string;
      /** Whether the tools reached the asking session; see WatchToolsArrival. */
      toolsArrived?: () => Promise<"arrived" | "pending">;
      resolve: (outcome: string) => void;
    }
  >();

  constructor(
    private readonly emitEvent: EmitEvent,
    private readonly describeAccount?: DescribeAccount,
    private readonly watchToolsArrival?: WatchToolsArrival
  ) {}

  /**
   * One conversation's asks still waiting. The Connect card is fed by a
   * one-shot event, so on mount it re-reads this list to pick the wait up.
   */
  listPending(conversationKey: ConversationKey): ConnectorRequest[] {
    return [...this.pending.values()]
      .filter((entry) => entry.request.conversationKey === conversationKey)
      .map((entry) => entry.request);
  }

  /**
   * Put a Connect button in front of the user and block until they answer.
   * Resolves with the sentence the model should read, not a status code.
   */
  async ask(input: {
    connectorId: string;
    label: string;
    reason?: string;
    /** The conversation that asked. See ConnectorRequest.conversationKey. */
    conversationKey: ConversationKey;
    /** The sentence for the model on connect, when it is not "tools are in your list". */
    connectedHint?: string;
    /** The agent session that asked, so the answer can wait for its tools. */
    callerSession?: string;
  }): Promise<string> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Started now: what the session had before the connect is the baseline.
    const toolsArrived =
      this.watchToolsArrival != null &&
      input.callerSession != null &&
      input.connectedHint == null
        ? this.watchToolsArrival({
            connectorId: input.connectorId,
            callerSession: input.callerSession,
          })
        : undefined;

    const request: ConnectorRequest = {
      requestId,
      connectorId: input.connectorId,
      label: input.label,
      conversationKey: input.conversationKey,
      ...(input.reason != null && input.reason.length > 0
        ? { reason: input.reason }
        : {}),
    };

    return await new Promise<string>((resolve) => {
      this.pending.set(requestId, {
        connectorId: input.connectorId,
        label: input.label,
        request,
        ...(input.connectedHint != null
          ? { connectedHint: input.connectedHint }
          : {}),
        ...(toolsArrived != null ? { toolsArrived } : {}),
        resolve,
      });
      this.emitEvent({
        type: "connector-request",
        request,
        emittedAt: new Date().toISOString(),
      });
    });
  }

  /**
   * Resolve one ask from the conversation it was filed under; another key is
   * ignored. Async only for the connected case, which asks the platform who
   * the connector attached as so the model does not ask the user.
   */
  async respond(request: RespondConnectorRequest): Promise<void> {
    const waiting = this.pending.get(request.requestId);

    if (waiting == null) return;
    if (waiting.request.conversationKey !== request.conversationKey) return;

    this.pending.delete(request.requestId);
    const detail =
      request.outcome === "connected"
        ? ((this.describeAccount != null
            ? await this.describeAccount(waiting.connectorId).catch(() => null)
            : null) ?? undefined)
        : request.error;
    const text = (hint: string | undefined): string =>
      CONNECTOR_OUTCOME_TEXT[request.outcome](waiting.label, detail, hint);

    // The card is cleared now; the model's answer may still wait for the
    // tools, off this call, so the click that answered is not held with it.
    if (request.outcome === "connected" && waiting.toolsArrived != null) {
      void waiting
        .toolsArrived()
        .catch(() => "pending" as const)
        .then((arrival) =>
          waiting.resolve(
            text(
              arrival === "pending" ? TOOLS_PENDING_HINT : waiting.connectedHint
            )
          )
        );
    } else {
      waiting.resolve(text(waiting.connectedHint));
    }
    this.emitEvent({
      type: "connector-cleared",
      requestId: request.requestId,
      emittedAt: new Date().toISOString(),
    });
  }

  /**
   * Release one conversation's asks with the reason the model should read: a
   * stopped turn must not leave a tool call suspended or its card on screen.
   */
  release(conversationKey: ConversationKey, reason: string): void {
    for (const [requestId, waiting] of this.pending) {
      if (waiting.request.conversationKey !== conversationKey) continue;
      this.pending.delete(requestId);
      waiting.resolve(reason);
      this.emitEvent({
        type: "connector-cleared",
        requestId,
        emittedAt: new Date().toISOString(),
      });
    }
  }
}
