/**
 * A model provider on 127.0.0.1 for testing the real agent end to end,
 * including its tool registry, permission gate, prompts, and output streams.
 * It speaks the OpenAI-compatible protocol used by custom providers, so tests
 * configure it the same way as a real provider.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

/** One request the agent made, as a test wants to read it. */
export interface RecordedCall {
  /** Tool names offered to the model: the roster the session built. */
  tools: string[];
  messages: Array<{ role: string; content: unknown }>;
  /** Text of the user messages, in order — what the model was actually asked. */
  userText: string[];
}

/** What the fake model does with one request. */
/** A reply, or a promise of one — a test may hold a request until something else lands. */
export type Responder = (
  call: RecordedCall,
  index: number
) => Reply | Promise<Reply>;

export type Reply =
  | { say: string }
  /** Text and a call together, which is what a narrating model sends. */
  | { say?: string; call: { name: string; args: Record<string, unknown> } }
  /** A provider error, as a status and the body a provider would send with it. */
  | { fail: { status: number; message: string } }
  /**
   * A stream that opens, says this much, and then never sends another byte
   * or closes — the shape of a connection the server has finished with but
   * the client is still waiting on.
   */
  | { stall: { say?: string } };

/** Text of a message whether the content is a string or a block array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) =>
      block != null && typeof block === "object" && "text" in block
        ? String((block as { text: unknown }).text ?? "")
        : ""
    )
    .join("");
}

export class FakeProvider {
  readonly calls: RecordedCall[] = [];
  /** Responses left open by a `stall` reply, closed with the server. */
  private readonly stalled: http.ServerResponse[] = [];
  private responder: Responder = () => ({ say: "ok" });

  private constructor(
    private readonly server: http.Server,
    readonly port: number
  ) {}

  static async start(): Promise<FakeProvider> {
    const server = http.createServer((request, response) => {
      let body = "";

      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => provider.handle(request, response, body));
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );

    const provider = new FakeProvider(
      server,
      (server.address() as AddressInfo).port
    );

    return provider;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  /** How the model answers. Called once per request, with the call index. */
  script(responder: Responder): void {
    this.responder = responder;
  }

  /** Plays a fixed list of replies, then stops talking. */
  scriptSequence(replies: Reply[]): void {
    this.script((_call, index) => replies[index] ?? { say: "done" });
  }

  /** The first request the agent made — the one carrying the user's prompt. */
  get firstCall(): RecordedCall | undefined {
    return this.calls[0];
  }

  async close(): Promise<void> {
    // server.close waits for open responses; a stalled one would wait forever.
    for (const response of this.stalled.splice(0)) response.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    body: string
  ): Promise<void> {
    if ((request.url ?? "").endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fake-1" }] }));

      return;
    }

    const parsed = JSON.parse(body || "{}") as {
      tools?: Array<{ function?: { name?: string }; name?: string }>;
      messages?: Array<{ role: string; content: unknown }>;
    };
    const messages = parsed.messages ?? [];
    const call: RecordedCall = {
      tools: (parsed.tools ?? []).map(
        (tool) => tool.function?.name ?? tool.name ?? ""
      ),
      messages,
      userText: messages
        .filter((message) => message.role === "user")
        .map((message) => textOf(message.content)),
    };

    const index = this.calls.length;
    this.calls.push(call);

    const reply = await this.responder(call, index);

    if ("fail" in reply) {
      response.writeHead(reply.fail.status, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ error: { message: reply.fail.message } }));

      return;
    }

    // Always streamed: pi asks for a stream, and a non-streamed answer to a
    // streaming request fails with "Stream ended without finish_reason".
    response.writeHead(200, { "content-type": "text/event-stream" });

    const frame = (delta: unknown, finish?: string): void => {
      response.write(
        `data: ${JSON.stringify({
          id: "chunk-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "fake-1",
          choices: [{ index: 0, delta, finish_reason: finish ?? null }],
        })}\n\n`
      );
    };

    frame({ role: "assistant", content: "" });

    if ("stall" in reply) {
      if (reply.stall.say != null && reply.stall.say.length > 0)
        frame({ content: reply.stall.say });
      // Held open on purpose; the caller's abort is what ends it.
      this.stalled.push(response);

      return;
    }

    if ("call" in reply) {
      if (reply.say != null && reply.say.length > 0)
        frame({ content: reply.say });

      frame({
        tool_calls: [
          {
            index: 0,
            id: `call-${index}`,
            type: "function",
            function: {
              name: reply.call.name,
              arguments: JSON.stringify(reply.call.args),
            },
          },
        ],
      });
      frame({}, "tool_calls");
    } else {
      frame({ content: reply.say });
      frame({}, "stop");
    }

    response.write("data: [DONE]\n\n");
    response.end();
  }
}

/** The config.json that points a session at this provider and nothing else. */
export function fakeProviderConfig(provider: FakeProvider): string {
  return JSON.stringify(
    {
      defaultModel: "fake/fake-1",
      customProviders: [
        {
          id: "fake",
          baseUrl: provider.baseUrl,
          apiKey: "test-key",
          models: [{ id: "fake-1", contextWindow: 131072 }],
        },
      ],
    },
    null,
    2
  );
}
