import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const { PersonaLearnedDialog } = await import("./persona-learned-dialog");

type Listener = (event: {
  type: string;
  text?: string;
  percent?: number;
}) => void;
let listener: Listener | null = null;
const forgetMemory = vi.fn(async () => ({
  memory: [],
  user: [],
  remember: [],
}));
const entry =
  "**Email persona (from my sent mail):**\nShort, direct, signs off with Best.";

const byId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

beforeEach(() => {
  listener = null;
  navigate.mockClear();
  forgetMemory.mockClear();
  Object.assign(window, {
    api: {
      agent: {
        onEvent: (fn: Listener) => {
          listener = fn;
          return () => undefined;
        },
        listMemories: async () => ({
          memory: [],
          user: ["Likes blue", entry],
          remember: [],
        }),
        forgetMemory,
      },
    },
  });
});
afterEach(cleanup);

describe("the persona dialog", () => {
  it("holds the screen with the progress while the run is going, then steps aside at 100", () => {
    render((<PersonaLearnedDialog />) as JSX.Element);
    act(() => listener!({ type: "user-persona-progress", percent: 0 }));
    expect(byId("persona-generating")).not.toBeNull();
    act(() => listener!({ type: "user-persona-progress", percent: 42 }));
    expect(byId("persona-generating-percent")?.textContent).toBe(
      "persona.generatingPercent"
    );
    act(() => listener!({ type: "user-persona-progress", percent: 100 }));
    expect(byId("persona-generating")).toBeNull();
  });

  it("says so when the run gives up", () => {
    render((<PersonaLearnedDialog />) as JSX.Element);
    act(() => listener!({ type: "user-persona-progress", percent: -1 }));
    expect(byId("persona-failed")).not.toBeNull();
    fireEvent.click(byId("persona-failed-ok")!);
    expect(byId("persona-failed")).toBeNull();
  });

  it("stays hidden until the persona lands, then shows it", () => {
    render((<PersonaLearnedDialog />) as JSX.Element);
    expect(byId("persona-learned")).toBeNull();
    act(() =>
      listener!({ type: "user-persona-learned", text: "Short, direct." })
    );
    expect(byId("persona-learned-text")?.textContent).toBe("Short, direct.");
    fireEvent.click(byId("persona-learned-ok")!);
    expect(byId("persona-learned")).toBeNull();
  });

  it("forgets exactly the persona entry, by its position", async () => {
    render((<PersonaLearnedDialog />) as JSX.Element);
    act(() =>
      listener!({ type: "user-persona-learned", text: "Short, direct." })
    );
    fireEvent.click(byId("persona-learned-forget")!);
    await waitFor(() =>
      expect(forgetMemory).toHaveBeenCalledWith({
        target: "user",
        index: 1,
        entry,
      })
    );
    expect(byId("persona-learned")).toBeNull();
  });

  it("edit goes to the memory page", () => {
    render((<PersonaLearnedDialog />) as JSX.Element);
    act(() => listener!({ type: "user-persona-learned", text: "x" }));
    fireEvent.click(byId("persona-learned-edit")!);
    expect(navigate).toHaveBeenCalledWith({ to: "/settings/memory" });
  });
});
