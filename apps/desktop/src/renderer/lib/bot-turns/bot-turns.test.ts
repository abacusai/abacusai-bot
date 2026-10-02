/**
 * R3-T19 (pure half): the bot skin's turn rules over live and migrated
 * UIMessages. Deliverables port the old `deliverables.test.ts` cases;
 * reactions port `message-reactions.test.tsx` and the hold/suppress rule of
 * `bot-message-list.tsx`; turn visibility is per turn (review r2 #3/#4/#6).
 */
import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, it } from "vitest";

import { turnDeliverables } from "./deliverables";
import { gapStamp, QUIET_GAP_MS, stampLabel } from "./gap-stamp";
import { turnReaction } from "./reactions";
import { botThreadView, spokenParts, turnIsSilent, turnsOf } from "./turns";

type Part = UIMessage["parts"][number];
let seq = 0;

const liveTool = (
  name: string,
  input: Record<string, unknown>,
  result: {
    content?: string;
    state?: "complete" | "error";
    rejected?: boolean;
    outcome?: "denied" | "cancelled";
  } | null = {}
): Part[] => {
  const id = `call-${(seq += 1)}`;
  const call = {
    type: "tool-call",
    id,
    name,
    arguments: JSON.stringify(input),
    input,
    state: "complete",
  } as unknown as Part;
  if (result == null) return [{ ...call, state: "input-streaming" } as Part];
  return [
    call,
    {
      type: "tool-result",
      toolCallId: id,
      content: JSON.stringify({
        text: result.content ?? "",
        rejected: result.rejected ?? false,
      }),
      state: result.state ?? "complete",
      ...(result.outcome != null ? { outcome: result.outcome } : {}),
    } as unknown as Part,
  ];
};

/** C.3 shape: arguments only, the legacy output as content, segment ids. */
const migratedTool = (
  name: string,
  input: Record<string, unknown>,
  content: string,
  status: "success" | "rejected" = "success"
): Part[] => {
  const id = `m-${(seq += 1)}`;
  return [
    {
      type: "tool-call",
      id,
      name,
      arguments: JSON.stringify(input),
      state: status === "success" ? "complete" : "approval-responded",
      metadata: { abacus: { segmentId: `seg-${id}`, status } },
    } as unknown as Part,
    {
      type: "tool-result",
      toolCallId: id,
      content,
      state: status === "success" ? "complete" : "error",
      ...(status === "rejected" ? { outcome: "denied" } : {}),
      metadata: { abacus: {} },
    } as unknown as Part,
  ];
};

const text = (content: string): Part => ({ type: "text", content }) as Part;

const assistant = (parts: Part[], at?: string): UIMessage => ({
  id: `a-${(seq += 1)}`,
  role: "assistant",
  parts,
  ...(at != null ? { createdAt: new Date(at) } : {}),
});
const user = (content = "Hello", at?: string): UIMessage => ({
  id: `u-${(seq += 1)}`,
  role: "user",
  parts: [text(content)],
  ...(at != null ? { createdAt: new Date(at) } : {}),
});

const turn = (...tools: Part[][]): UIMessage[] => [
  assistant([text("On it."), ...tools.flat(), text("Done.")]),
];

describe("deliverables: a declared handover", () => {
  it("is the list, in the agent's order, with its labels", () => {
    expect(
      turnDeliverables(
        turn(
          liveTool("write", { file_path: "/w/scratch.pdf" }),
          liveTool("agent-tools_present_deliverable", {
            items: [
              { path: "/w/report.docx", label: "Q3 report" },
              { path: "http://localhost:5173" },
            ],
          })
        )
      )
    ).toEqual([
      { path: "/w/report.docx", label: "Q3 report", isUrl: false },
      { path: "http://localhost:5173", isUrl: true },
    ]);
  });

  it("shows what the tool accepted, not everything the model listed", () => {
    expect(
      turnDeliverables(
        turn(
          liveTool(
            "agent-tools_present_deliverable",
            {
              items: [
                { path: "/w/report.md", label: "Morning Brief" },
                { path: "/w/a@b.com_c@d.com", label: "placeholder" },
              ],
            },
            {
              content:
                "- [Morning Brief](file:///w/report.md)\n\nNot presented: /w/a@b.com_c@d.com\n\n[artifact] /w/report.md",
            }
          )
        )
      )
    ).toEqual([{ path: "/w/report.md", label: "Morning Brief", isUrl: false }]);
  });

  it("counts for nothing when rejected, denied or still running", () => {
    expect(
      turnDeliverables(
        turn(
          liveTool(
            "present_deliverable",
            { items: [{ path: "/w/a.pdf" }] },
            { rejected: true }
          ),
          liveTool(
            "present_deliverable",
            { items: [{ path: "/w/b.pdf" }] },
            null
          ),
          liveTool(
            "write",
            { file_path: "/w/c.pdf" },
            { state: "error", outcome: "denied" }
          )
        )
      )
    ).toEqual([]);
  });
});

describe("deliverables: writes the agent never named", () => {
  it("shows the documents and not the code", () => {
    expect(
      turnDeliverables(
        turn(
          liveTool("write", { file_path: "src/app.ts" }),
          liveTool("edit", { file_path: "/w/README.md" }),
          liveTool("write", { file_path: "/w/out/summary.docx" }),
          liveTool("write", { file_path: "/w/todo.md" })
        )
      ).map((item) => item.path)
    ).toEqual(["/w/README.md", "/w/out/summary.docx"]);
  });

  it("knows what the component and media tools built", () => {
    expect(
      turnDeliverables(
        turn(
          liveTool("agent-tools_ppt", { output_path: "/w/deck.html" }),
          liveTool("agent-tools_design", { output_dir: "/w/brand" }),
          liveTool(
            "agent-tools_image_generate",
            { prompt: "a cat" },
            { content: "Saved.\n[artifact] /media/cat.png" }
          )
        )
      ).map((item) => item.path)
    ).toEqual(["/w/deck.pdf", "/w/brand/canvas.html", "/media/cat.png"]);
  });

  it("lists a path once however many times it was written", () => {
    expect(
      turnDeliverables(
        turn(
          liveTool("write", { file_path: "/w/report.md" }),
          liveTool("edit", { file_path: "/w/report.md" })
        )
      )
    ).toHaveLength(1);
  });

  it("reads migrated parts the same way", () => {
    expect(
      turnDeliverables([
        assistant([
          ...migratedTool("write", { file_path: "/w/a.md" }, "ok"),
          ...migratedTool("write", { file_path: "/w/b.md" }, "", "rejected"),
        ]),
      ]).map((item) => item.path)
    ).toEqual(["/w/a.md"]);
  });

  it("an empty presentation does not hide a valid write (live and migrated)", () => {
    const live = [
      assistant([
        ...liveTool("write", { file_path: "/w/brief.pdf" }),
        ...liveTool("present_deliverable", { items: [] }),
      ]),
    ];
    const migrated = [
      assistant([
        ...migratedTool("write", { file_path: "/w/brief.pdf" }, "ok"),
        ...migratedTool("present_deliverable", { items: [] }, "Nothing."),
      ]),
    ];
    expect(turnDeliverables(live).map((d) => d.path)).toEqual(["/w/brief.pdf"]);
    expect(turnDeliverables(migrated).map((d) => d.path)).toEqual([
      "/w/brief.pdf",
    ]);
  });
});

describe("reactions", () => {
  const react = (emoji: string, result?: Parameters<typeof liveTool>[2]) =>
    assistant(
      liveTool(
        "react_to_message",
        { emoji },
        result === undefined ? { content: JSON.stringify({ emoji }) } : result
      )
    );

  it("a successful call is the reaction", () => {
    expect(turnReaction([react("❤️")])).toBe("❤️");
  });
  it("migrated results carry the emoji in their content", () => {
    expect(
      turnReaction([
        assistant(
          migratedTool(
            "react_to_message",
            { emoji: "🎉" },
            JSON.stringify({ emoji: "🎉" })
          )
        ),
      ])
    ).toBe("🎉");
  });
  it("pending, failed, rejected and invalid reactions count for nothing", () => {
    expect(turnReaction([react("👍", null)])).toBeNull();
    expect(turnReaction([react("👍", { state: "error" })])).toBeNull();
    expect(
      turnReaction([react("👍", { content: '{"emoji":"👍"}', rejected: true })])
    ).toBeNull();
    expect(turnReaction([react("not an emoji")])).toBeNull();
  });
});

describe("turns and visibility", () => {
  it("groups assistant messages between user messages", () => {
    const messages = [
      user(),
      assistant([text("a")]),
      assistant([text("b")]),
      user(),
    ];
    expect(turnsOf(messages)).toEqual([
      { userIndex: 0, assistantIndices: [1, 2] },
      { userIndex: 3, assistantIndices: [] },
    ]);
  });

  it("spoken parts are text, notices and sub-agents only", () => {
    expect(
      spokenParts(
        assistant([
          text("  "),
          { type: "thinking", content: "hm" } as Part,
          {
            type: "text",
            content: "Out of credits",
            metadata: { abacus: { kind: "notification" } },
          } as Part,
          {
            type: "text",
            content: "x",
            metadata: { abacus: { kind: "collapsible" } },
          } as Part,
          { type: "subagent", subagent: {} } as unknown as Part,
        ])
      ).map((part) => part.kind)
    ).toEqual(["notice", "subagent"]);
  });

  it("a tool-only turn is silent; one that made a file is not", () => {
    expect(turnIsSilent([assistant(liveTool("bash", { command: "ls" }))])).toBe(
      true
    );
    expect(
      turnIsSilent([assistant(liveTool("write", { file_path: "/w/a.pdf" }))])
    ).toBe(false);
  });

  it("a delegation turn with only a sub-agent part is visible", () => {
    const messages = [
      user(),
      assistant([{ type: "subagent", subagent: {} } as unknown as Part]),
    ];
    expect(botThreadView(messages, false)[1]!.hidden).toBe(false);
  });

  it("a two-message run shows one card with the presented list, after the last shown message", () => {
    const messages = [
      user(),
      assistant([
        text("Writing it."),
        ...liveTool("write", { file_path: "/w/draft.md" }),
      ]),
      assistant([
        ...liveTool("present_deliverable", {
          items: [{ path: "/w/final.pdf", label: "Final" }],
        }),
        text("Here it is."),
      ]),
    ];
    const views = botThreadView(messages, false);
    expect(views[1]!.deliverables).toBeNull();
    expect(views[2]!.deliverables).toEqual([
      { path: "/w/final.pdf", label: "Final", isUrl: false },
    ]);
  });

  it("a card after a tool-only last message keeps that message", () => {
    const messages = [
      user(),
      assistant([text("On it.")]),
      assistant(liveTool("write", { file_path: "/w/r.pdf" })),
    ];
    const views = botThreadView(messages, false);
    expect(views[1]!.deliverables).toHaveLength(1);
    expect(views[2]!.hidden).toBe(true);
  });

  it("drops a silent turn entirely", () => {
    const messages = [user(), assistant(liveTool("bash", { command: "ls" }))];
    expect(botThreadView(messages, false)[1]!.hidden).toBe(true);
  });

  it("badges the user message and drops the equal emoji reply", () => {
    const messages = [
      user(),
      assistant(
        liveTool(
          "react_to_message",
          { emoji: "❤️" },
          {
            content: JSON.stringify({ emoji: "❤️" }),
          }
        )
      ),
      assistant([text(" ❤️ ")]),
    ];
    const views = botThreadView(messages, false);
    expect(views[0]!.reaction).toBe("❤️");
    expect(views[2]!.hidden).toBe(true);
  });

  it("an emoji-only reply without a reaction stays a bubble", () => {
    const messages = [user(), assistant([text("👍")])];
    expect(botThreadView(messages, false)[1]!.hidden).toBe(false);
  });

  it("holds a trailing emoji of the live turn, then releases it", () => {
    const messages = [user(), assistant([text("👍")])];
    expect(botThreadView(messages, true)[1]!.hidden).toBe(true);
    expect(botThreadView(messages, false)[1]!.hidden).toBe(false);
    expect(botThreadView(messages, true)[1]!.live).toBe(true);
  });

  it("stamps after a quiet gap inside a day, never twice with a day separator", () => {
    const messages = [
      user("a", "2026-10-01T09:00:00"),
      assistant([text("b")], "2026-10-01T09:01:00"),
      user("c", "2026-10-01T09:30:00"),
      user("d", "2026-10-02T09:30:00"),
    ];
    const views = botThreadView(messages, false);
    expect(views.map((view) => view.stampBefore != null)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });
});

describe("gap stamps", () => {
  it("needs 15 minutes within one day", () => {
    const at = new Date("2026-10-01T10:00:00");
    expect(gapStamp(null, at)).toBe(false);
    expect(gapStamp(new Date(at.getTime() - QUIET_GAP_MS + 1), at)).toBe(false);
    expect(gapStamp(new Date(at.getTime() - QUIET_GAP_MS), at)).toBe(true);
  });
  it("labels yesterday and today", () => {
    const now = new Date("2026-10-02T12:00:00");
    expect(
      stampLabel(new Date("2026-10-01T09:41:00"), now, "en-US", "Yesterday")
    ).toMatch(/^Yesterday 9:41/);
    expect(
      stampLabel(new Date("2026-10-02T09:41:00"), now, "en-US", "Y")
    ).toMatch(/^9:41/);
  });
});
