import { Store } from "@tanstack/react-store";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PermissionList, type ChatRuntime } from "#next/features/chat";
import { descriptor } from "#next/features/chat/fixtures/builders";
import { emptyThreadState } from "#next/features/chat/store/thread-store";
import type { PermissionRequest } from "#shared/agent-types";

afterEach(() => vi.restoreAllMocks());
it("R6-T18 a new permission lineage resets question progress and answers", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(560);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(560);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(16);
  const question = (header: string, label: string) => ({
    header,
    question: header,
    multiSelect: false,
    options: [{ label, description: "" }],
  });
  const request: PermissionRequest = {
    type: "ask_user_question",
    tool: { id: "q", name: "ask_user_question", type: "function", input: {} },
    displayName: "Question",
    questions: [question("First", "One"), question("Second", "Two")],
  };
  const state = emptyThreadState();
  state.permissions.items = [
    descriptor(request, { id: "same", incarnation: "old" }),
  ];
  const thread = new Store(state);
  const respondPermission = vi.fn(async (..._args: unknown[]) => undefined);
  const hostStore = new Store({ store: thread });
  const runtime = {
    session: () => ({ hostStore }),
    respondPermission,
  } as unknown as ChatRuntime;
  const view = render(
    <PermissionList
      variant="notch"
      runtime={runtime}
      threadId="t-1"
      maxHeight={169}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "One" }));
  expect(screen.getByRole("button", { name: "Two" })).toBeTruthy();
  act(() =>
    thread.setState((s) => ({
      ...s,
      permissions: {
        ...s.permissions,
        items: [
          descriptor(
            {
              type: "ask_user_question",
              tool: {
                id: "q",
                name: "ask_user_question",
                type: "function",
                input: {},
              },
              displayName: "Question",
              questions: [question("New", "Fresh")],
            },
            { id: "same", incarnation: "new" }
          ),
        ],
      },
    }))
  );
  fireEvent.click(screen.getByRole("button", { name: "Fresh" }));
  expect(respondPermission).toHaveBeenCalledTimes(1);
  expect(respondPermission.mock.calls[0]?.[2]).toEqual({
    type: "question_answers",
    answers: { question_0: "Fresh" },
  });
  view.unmount();
});
