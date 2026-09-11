/**
 * A stand-in for pi's ExtensionAPI, so extensions can be tested without a
 * model, a provider, or a running session. Implements only what the extensions
 * use: a hook missing here fails loudly on `undefined` rather than passing
 * against a pretend implementation.
 */
export interface FakePi {
  /** The object handed to the extension under test. */
  api: unknown;
  /** Dispatch one event to every handler registered for it, in order. */
  fire(event: string, payload: unknown, ctx?: unknown): Promise<unknown>;
  tools: Map<string, FakeTool>;
  /**
   * Messages pushed with `sendMessage`, with their options: `triggerTurn` is
   * the difference between telling the agent something and merely filing it.
   */
  messages: Array<{
    customType?: string;
    content?: unknown;
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }>;
  entries: Array<{ customType: string; data: unknown }>;
  notifications: Array<{ text: string; level?: string }>;
}

export interface FakeTool {
  name: string;
  description: string;
  parameters: unknown;
  /** Present when the tool draws its own call row in the TUI. */
  renderCall?: (args: unknown, theme: unknown, context: unknown) => unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    // Tools that touch the filesystem read `cwd` off the context pi passes as
    // the fifth argument, so a test driving one has to supply it.
    ctx?: { cwd: string }
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    details?: unknown;
    isError?: boolean;
  }>;
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

export function fakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, FakeTool>();
  const messages: FakePi["messages"] = [];
  const entries: FakePi["entries"] = [];
  const notifications: FakePi["notifications"] = [];

  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: FakeTool) {
      tools.set(tool.name, tool);
    },
    /** Every tool the model can see. Registration is the only way in, as in pi. */
    getAllTools() {
      return [...tools.values()];
    },
    sendMessage(
      message: { customType?: string; content?: unknown },
      options?: { triggerTurn?: boolean; deliverAs?: string }
    ) {
      messages.push({ ...message, ...(options != null ? { options } : {}) });
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    // Present so an extension that registers one does not crash; nothing in
    // the suite asserts on them yet.
    registerCommand() {
      return undefined;
    },
    registerShortcut() {
      return undefined;
    },
  };

  const defaultCtx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify(text: string, level?: string) {
        notifications.push({ text, level });
      },
    },
    abort() {
      return undefined;
    },
  };

  return {
    api,
    tools,
    messages,
    entries,
    notifications,
    async fire(event, payload, ctx = defaultCtx) {
      let last: unknown;
      for (const handler of handlers.get(event) ?? []) {
        const result = await handler(payload, ctx);
        // pi treats the last non-undefined return as the handler's answer.
        if (result !== undefined) last = result;
      }

      return last;
    },
  };
}

/** A tool result event shaped the way pi emits one. */
export function toolResult(
  toolName: string,
  text: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    toolName,
    toolCallId: "call-1",
    isError: false,
    input: {},
    content: [{ type: "text", text }],
    ...overrides,
  };
}
