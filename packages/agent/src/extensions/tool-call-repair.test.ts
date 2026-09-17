import { fakePi, type FakeTool } from "@abacus-ai/test-support/fake-pi";
/**
 * Recovering a tool call the model wrote as text.
 *
 * The reproducer: a small local qwen2.5-coder answers "hi" with a ```json fence
 * holding `{"name": "delegate_task", "arguments": {...}}` and never makes a
 * native call. The nudge in output-repair asks it to re-issue the call, the
 * model writes the same text again, and after the budget runs out the user is
 * left with raw JSON in the chat. This extension converts that text into a
 * real toolCall block via pi's message_end replacement hook, so the agent
 * loop executes it as if the call had been native.
 */
import { describe, expect, it } from "vitest";

import { default as toolCallRepair } from "./tool-call-repair.js";

const stubTool = (name: string): FakeTool => ({
  name,
  description: name,
  parameters: {},
  async execute() {
    return { content: [{ type: "text", text: "" }] };
  },
});

function withRepair(toolNames = ["delegate_task", "read", "web_search"]) {
  const pi = fakePi();
  for (const name of toolNames)
    (pi.api as { registerTool(t: FakeTool): void }).registerTool(
      stubTool(name)
    );
  toolCallRepair(pi.api as never);

  return pi;
}

interface Replaced {
  message: {
    role: string;
    stopReason?: string;
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      arguments?: Record<string, unknown>;
    }>;
  };
}

const assistant = (text: string, stopReason = "stop") => ({
  message: {
    role: "assistant",
    stopReason,
    content: [{ type: "text", text }],
  },
});

const QWEN_FENCE =
  '```json\n{\n  "name": "delegate_task",\n  "arguments": {\n    "task": "Analyze the AndroidApps directory"\n  }\n}\n```';

async function repair(pi: ReturnType<typeof withRepair>, event: unknown) {
  return (await pi.fire("message_end", event)) as Replaced | undefined;
}

describe("shapes that convert", () => {
  it("converts the fenced JSON call from the bug report", async () => {
    const pi = withRepair();
    const result = await repair(pi, assistant(QWEN_FENCE));

    expect(result).toBeDefined();
    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.name).toBe("delegate_task");
    expect(call?.arguments).toEqual({
      task: "Analyze the AndroidApps directory",
    });
    expect(result?.message.stopReason).toBe("toolUse");
  });

  it("converts a bare unfenced JSON object", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant('{"name": "read", "arguments": {"path": "a.ts"}}')
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.name).toBe("read");
    expect(call?.arguments).toEqual({ path: "a.ts" });
  });

  it("converts qwen's <tool_call> tag form", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(
        '<tool_call>\n{"name": "web_search", "arguments": {"query": "x"}}\n</tool_call>'
      )
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.name).toBe("web_search");
  });

  it("accepts OpenAI's nested function shape with string-encoded arguments", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(
        '{"function": {"name": "read", "arguments": "{\\"path\\": \\"b.ts\\"}"}}'
      )
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.name).toBe("read");
    expect(call?.arguments).toEqual({ path: "b.ts" });
  });

  it("converts Mistral's [TOOL_CALLS] marker and array body", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(
        '[TOOL_CALLS] [{"name": "read", "arguments": {"path": "a.ts"}}]'
      )
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.name).toBe("read");
    expect(call?.arguments).toEqual({ path: "a.ts" });
  });

  it("converts every call in an array, each with its own id", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(
        '[{"name": "read", "arguments": {"path": "a.ts"}}, {"name": "web_search", "arguments": {"query": "x"}}]'
      )
    );

    const calls =
      result?.message.content.filter((b) => b.type === "toolCall") ?? [];
    expect(calls.map((c) => c.name)).toEqual(["read", "web_search"]);
    expect(calls[0]?.id).not.toBe(calls[1]?.id);
  });

  it("unwraps an OpenAI-style tool_calls envelope", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(
        '{"tool_calls": [{"function": {"name": "read", "arguments": {"path": "c.ts"}}}]}'
      )
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.name).toBe("read");
  });

  it("converts Gemma's tool_code fence, unwrapping print()", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(
        '```tool_code\nprint(web_search(query="weather in SF", limit=3))\n```'
      )
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.name).toBe("web_search");
    expect(call?.arguments).toEqual({ query: "weather in SF", limit: 3 });
  });

  it("converts Llama 3.2's bare pythonic list with python literals", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(
        "[read(path='a.ts', follow=True), web_search(query=\"x\", filters={'site': 'gh'})]"
      )
    );

    const calls =
      result?.message.content.filter((b) => b.type === "toolCall") ?? [];
    expect(calls.map((c) => c.name)).toEqual(["read", "web_search"]);
    expect(calls[0]?.arguments).toEqual({ path: "a.ts", follow: true });
    expect(calls[1]?.arguments).toEqual({
      query: "x",
      filters: { site: "gh" },
    });
  });

  it("converts Llama 3.1's <|python_tag|> dotted .call form", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant('<|python_tag|>web_search.call(query="latest node lts")')
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.name).toBe("web_search");
    expect(call?.arguments).toEqual({ query: "latest node lts" });
  });

  it("converts Granite's <|tool_call|> marker with a JSON array body", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(
        '<|tool_call|>[{"name": "read", "arguments": {"path": "g.ts"}}]'
      )
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.name).toBe("read");
  });

  it("resolves a namespaced pythonic name to the roster tool", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant('```tool_code\nfunctions.read(path="n.ts")\n```')
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.name).toBe("read");
  });

  it("treats missing arguments as an empty object", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant('```json\n{"name": "read"}\n```')
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.arguments).toEqual({});
  });

  it("keeps the prose that preceded the call", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(`I'll delegate this.\n\n${QWEN_FENCE}`)
    );

    const [text, call] = result?.message.content ?? [];
    expect(text?.type).toBe("text");
    expect(text?.text).toBe("I'll delegate this.");
    expect(call?.type).toBe("toolCall");
  });

  it("gives each recovered call a fresh id", async () => {
    const pi = withRepair();
    const a = await repair(pi, assistant(QWEN_FENCE));
    const b = await repair(pi, assistant(QWEN_FENCE));

    const idOf = (r: Replaced | undefined) =>
      r?.message.content.find((c) => c.type === "toolCall")?.id;
    expect(idOf(a)).toBeDefined();
    expect(idOf(a)).not.toBe(idOf(b));
  });
});

describe("shapes that must NOT convert", () => {
  it("leaves a call to a tool that does not exist for the nudge", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant('```json\n{"name": "no_such_tool", "arguments": {}}\n```')
    );

    expect(result).toBeUndefined();
  });

  it("leaves a JSON example that prose talks past", async () => {
    // A call followed by more text reads like documentation. Executing an
    // example the model was *explaining* would be far worse than nudging.
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(`${QWEN_FENCE}\n\nThat is how you would call the tool.`)
    );

    expect(result).toBeUndefined();
  });

  it("leaves a message that already made a native call", async () => {
    const pi = withRepair();
    const result = await repair(pi, {
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: QWEN_FENCE },
          { type: "toolCall", id: "c1", name: "read", arguments: {} },
        ],
      },
    });

    expect(result).toBeUndefined();
  });

  it("leaves errored and aborted messages alone", async () => {
    const pi = withRepair();
    expect(await repair(pi, assistant(QWEN_FENCE, "error"))).toBeUndefined();
    expect(await repair(pi, assistant(QWEN_FENCE, "aborted"))).toBeUndefined();
  });

  it("ignores non-assistant messages and plain prose", async () => {
    const pi = withRepair();
    expect(
      await repair(pi, {
        message: {
          role: "user",
          content: [{ type: "text", text: QWEN_FENCE }],
        },
      })
    ).toBeUndefined();
    expect(
      await repair(pi, assistant("Hello! How can I help?"))
    ).toBeUndefined();
  });

  it("never executes a plain python fence — that is code for the user", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant('```python\nread(path="a.ts")\n```')
    );

    expect(result).toBeUndefined();
  });

  it("refuses pythonic calls with positional or expression arguments", async () => {
    // A positional argument has no parameter name to map to, and an
    // expression means this is code, not a call.
    const pi = withRepair();
    expect(
      await repair(pi, assistant('```tool_code\nread("a.ts")\n```'))
    ).toBeUndefined();
    expect(
      await repair(pi, assistant("```tool_code\nread(path=base + ext)\n```"))
    ).toBeUndefined();
  });

  it("refuses a batch where any call is invalid", async () => {
    // Executing half a batch would leave the model believing the rest ran.
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(
        '[{"name": "read", "arguments": {}}, {"name": "no_such_tool", "arguments": {}}]'
      )
    );

    expect(result).toBeUndefined();
  });

  it("ignores JSON that is not a tool call", async () => {
    const pi = withRepair();
    expect(
      await repair(pi, assistant('```json\n{"answer": 42}\n```'))
    ).toBeUndefined();
    expect(
      await repair(pi, assistant('```json\n{"name": "Alice", "age": 30}\n```'))
    ).toBeUndefined();
  });
});

describe("unicode escapes in pythonic strings", () => {
  it("decodes \\uXXXX, including surrogate pairs, instead of corrupting them", async () => {
    // The old escape handling dropped the backslash and kept "uXXXX", so the
    // argument silently arrived corrupted.
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(
        '```tool_code\nweb_search(query="caf\\u00e9 \\ud83d\\ude00")\n```'
      )
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.arguments).toEqual({ query: "caf\u00e9 \u{1f600}" });
  });

  it("refuses a malformed \\u escape rather than guessing", async () => {
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant('```tool_code\nread(path="\\uZZZZ")\n```')
    );

    expect(result).toBeUndefined();
  });
});

describe("examples at the end of the message", () => {
  it("leaves a fence whose lead-in announces an example", async () => {
    // "Nothing follows it" is not enough on its own: a message can END with
    // the example it was explaining, and executing that is far worse than
    // nudging.
    const pi = withRepair();

    for (const leadIn of [
      "You would call the tool like this:",
      "For example:",
      "You could use:",
    ]) {
      expect(
        await repair(pi, assistant(`${leadIn}\n\n${QWEN_FENCE}`))
      ).toBeUndefined();
    }
  });

  it("still converts a trailing call with an ordinary lead-in", async () => {
    // A colon alone is how models narrate a real call; only example phrasing
    // may decline it.
    const pi = withRepair();
    const result = await repair(
      pi,
      assistant(`I'll delegate this now:\n\n${QWEN_FENCE}`)
    );

    const call = result?.message.content.find((b) => b.type === "toolCall");
    expect(call?.name).toBe("delegate_task");
  });
});
