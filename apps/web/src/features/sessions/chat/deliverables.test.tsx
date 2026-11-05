import type { UIMessage } from "@tanstack/ai-client";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { latestPresented } from "#renderer/lib/bot-turns/deliverables";
import { i18n, initI18n } from "#renderer/lib/i18n";

import {
  deliverablesAfter,
  rowEndIndex,
  sessionDeliverablesCard,
} from "./deliverables";

// Share reads the account, which these cards are not mounted under here.
vi.mock("#renderer/components/share/share-row-button", () => ({
  ShareRowButton: () => null,
}));

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en-US");
});

const user = (id: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", content: "hi" }] }) as UIMessage;
const writer = (id: string, path: string): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: `c-${id}`,
        name: "write",
        arguments: JSON.stringify({ file_path: path }),
        input: { file_path: path },
        state: "complete",
        output: { text: "ok" },
      },
      {
        type: "tool-result",
        toolCallId: `c-${id}`,
        content: JSON.stringify({ text: "ok" }),
        state: "complete",
      },
    ],
  }) as unknown as UIMessage;

describe("deliverablesAfter", () => {
  const messages = [
    user("u"),
    writer("a1", "/w/report.md"),
    writer("a2", "/w/x.ts"),
  ];

  it("shows on the turn's last assistant message only", () => {
    expect(deliverablesAfter(messages, 1, false)).toBeNull();
    expect(deliverablesAfter(messages, 2, false)?.map((i) => i.path)).toEqual([
      "/w/report.md",
    ]);
  });

  it("holds the card while the turn is still running", () => {
    expect(deliverablesAfter(messages, 2, true)).toBeNull();
    expect(deliverablesAfter([...messages, user("u2")], 2, true)?.length).toBe(
      1
    );
  });

  it("opens a relative file resolved against the workspace", () => {
    const onOpenFile = vi.fn();
    render(
      sessionDeliverablesCard([{ path: "report.md", isUrl: false }], {
        workspaceRoot: "/w",
        onOpenFile,
        onOpenUrl: vi.fn(),
        onOpenExternal: vi.fn(),
      })
    );
    fireEvent.click(screen.getByText("report.md"));
    expect(onOpenFile).toHaveBeenCalledWith("/w/report.md");
  });
});

describe("rowEndIndex", () => {
  it("reaches the carrier folded into a coalesced host row", () => {
    const messages = [
      user("u"),
      writer("a1", "/w/a.ts"),
      writer("a2", "/w/r.md"),
    ];
    const host = {
      ...messages[1]!,
      metadata: { abacus: { coalescedIds: ["a2"] } },
    } as UIMessage;
    const at = rowEndIndex(host, { messages, index: 1 });
    expect(at).toBe(2);
    expect(deliverablesAfter(messages, at, false)?.length).toBe(1);
    expect(rowEndIndex(messages[1]!, { messages, index: 1 })).toBe(1);
  });
});

describe("latestPresented", () => {
  const presenter = (id: string, path: string): UIMessage =>
    ({
      id,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: `c-${id}`,
          name: "present_deliverable",
          arguments: JSON.stringify({ items: [{ path }] }),
          input: { items: [{ path }] },
          state: "complete",
          output: { text: "ok" },
        },
        {
          type: "tool-result",
          toolCallId: `c-${id}`,
          content: JSON.stringify({ text: "ok" }),
          state: "complete",
        },
      ],
    }) as unknown as UIMessage;
  const spoke = (id: string): UIMessage =>
    ({
      id,
      role: "assistant",
      parts: [{ type: "text", content: "" }],
    }) as UIMessage;

  it("takes the latest turn's handover, not an earlier turn's", () => {
    const paths = latestPresented([
      user("u1"),
      presenter("a1", "/w/old.pdf"),
      user("u2"),
      writer("a2", "/w/draft.md"),
      presenter("a3", "http://localhost:5173"),
    ]).map((item) => item.path);
    expect(paths).toEqual(["http://localhost:5173"]);
  });

  it("looks past a retry that died before running any tool", () => {
    expect(
      latestPresented([
        user("u1"),
        presenter("a1", "/w/site/index.html"),
        user("u2"),
        spoke("a2"),
        user("u3"),
      ]).map((item) => item.path)
    ).toEqual(["/w/site/index.html"]);
  });

  it("is empty when the turn that worked handed nothing over", () => {
    expect(
      latestPresented([
        user("u1"),
        presenter("a1", "/w/old.pdf"),
        user("u2"),
        writer("a2", "/w/x.ts"),
      ])
    ).toEqual([]);
    expect(latestPresented([user("u1")])).toEqual([]);
  });
});
