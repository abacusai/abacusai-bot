import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/**
 * The new-bot dialog: name, persona, instructions and, under more
 * options, a description and scheduled check-ins that become a routine on
 * the bot.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createBot = vi.fn(async (input: Record<string, unknown>) => ({
  id: "bot-1",
  name: String(input.name ?? ""),
}));
const createRoutine = vi.fn(async (input: Record<string, unknown>) => input);
const onCreated = vi.fn();

vi.mock("react-i18next", () => {
  const t = (key: string, values?: Record<string, string>): string =>
    values == null ? key : `${key} ${JSON.stringify(values)}`;
  const translation = { t, i18n: { language: "en-US" } };
  return { useTranslation: () => translation };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("../../hooks/use-bots", () => ({
  useCreateBotMutation: () => ({ mutateAsync: createBot }),
  useUpdateBotMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../hooks/use-routines", () => ({
  useCreateRoutineMutation: () => ({ mutateAsync: createRoutine }),
  useRoutinesQuery: () => ({ data: [] }),
  useUpdateRoutineMutation: () => ({ mutateAsync: vi.fn() }),
  useRemoveRoutineMutation: () => ({ mutateAsync: vi.fn() }),
}));

const { defaultAvatarColor } = await import("#shared/bots");
const { NewBotDialog, NAME_ONLY_MISSION, CHECK_IN_PROMPT } =
  await import("./new-bot-dialog");

(window as unknown as { api: unknown }).api = {
  agent: {
    listModels: async () => [],
    announceBotChange: async () => undefined,
  },
};

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);
  return node;
};

const type = (id: string, value: string): void => {
  fireEvent.change(byId(id), { target: { value } });
};

const pressCreate = (): void => {
  const button = [...byId("new-bot-dialog").querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "bots.create"
  );
  if (button == null) throw new Error("no Create button");
  fireEvent.click(button);
};

beforeEach(() => {
  vi.clearAllMocks();
  render(
    (
      <QueryClientProvider client={new QueryClient()}>
        <NewBotDialog
          isOpen
          initialName="Research Buddy"
          onClose={() => {}}
          onCreated={onCreated}
        />
      </QueryClientProvider>
    ) as JSX.Element
  );
});

describe("making a bot", () => {
  it("carries the name over, and stores persona and instructions apart", async () => {
    expect((byId("new-bot-name-input") as HTMLInputElement).value).toBe(
      "Research Buddy"
    );
    type("new-bot-persona-input", "Dry wit, calls me boss");
    type("new-bot-instructions-input", "Track topics I mention.");
    pressCreate();

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createBot.mock.calls[0]?.[0]).toMatchObject({
      name: "Research Buddy",
      persona: "Dry wit, calls me boss",
      description: "Track topics I mention.",
      title: "",
    });
    expect(createRoutine).not.toHaveBeenCalled();
  });

  it("gives a bot with no instructions the find-your-lane mission", async () => {
    pressCreate();

    await waitFor(() => expect(createBot).toHaveBeenCalled());
    expect(createBot.mock.calls[0]?.[0]).toMatchObject({
      description: NAME_ONLY_MISSION,
    });
  });

  it("turns a scheduled check-in into a routine on the bot", async () => {
    fireEvent.click(byId("new-bot-more-toggle"));
    type("new-bot-description-input", "Keeps track of my research topics");
    fireEvent.change(byId("new-bot-check-in-select"), {
      target: { value: "weekdays" },
    });
    pressCreate();

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createBot.mock.calls[0]?.[0]).toMatchObject({
      title: "Keeps track of my research topics",
    });
    expect(createRoutine).toHaveBeenCalledTimes(1);
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      botId: "bot-1",
      schedule: "0 9 * * 1-5",
      prompt: CHECK_IN_PROMPT,
    });
  });

  it("asks for a time once the check-in has one, and none while it is off or hourly", () => {
    fireEvent.click(byId("new-bot-more-toggle"));
    expect(
      document.querySelector('[data-id="new-bot-check-in-time-input"]')
    ).toBeNull();

    fireEvent.change(byId("new-bot-check-in-select"), {
      target: { value: "hourly" },
    });
    expect(
      document.querySelector('[data-id="new-bot-check-in-time-input"]')
    ).toBeNull();

    fireEvent.change(byId("new-bot-check-in-select"), {
      target: { value: "daily" },
    });
    expect(byId("new-bot-check-in-time-input")).toBeTruthy();
    expect(
      document.querySelector('[data-id="new-bot-check-in-weekday-select"]')
    ).toBeNull();
  });

  it("fires a daily check-in at the time picked", async () => {
    fireEvent.click(byId("new-bot-more-toggle"));
    fireEvent.change(byId("new-bot-check-in-select"), {
      target: { value: "daily" },
    });
    fireEvent.change(byId("new-bot-check-in-time-input"), {
      target: { value: "18:30" },
    });
    pressCreate();

    await waitFor(() => expect(createRoutine).toHaveBeenCalled());
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      schedule: "30 18 * * *",
    });
  });

  it("fires a weekly check-in on the day and at the time picked", async () => {
    // Weekly used to mean Monday at nine, with nothing on screen saying so.
    fireEvent.click(byId("new-bot-more-toggle"));
    fireEvent.change(byId("new-bot-check-in-select"), {
      target: { value: "weekly" },
    });
    fireEvent.change(byId("new-bot-check-in-weekday-select"), {
      target: { value: "3" },
    });
    fireEvent.change(byId("new-bot-check-in-time-input"), {
      target: { value: "08:15" },
    });
    pressCreate();

    await waitFor(() => expect(createRoutine).toHaveBeenCalled());
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      schedule: "15 8 * * 3",
    });
  });

  it("gives a scratch bot the face its name would get, and a picked one when picked", async () => {
    // What is on screen is what the bot gets: no hidden default.
    type("new-bot-name-input", "Scout");
    fireEvent.click(byId("new-bot-avatar-edit"));
    await waitFor(() => byId("new-bot-avatar-picker"));
    fireEvent.click(
      byId("new-bot-avatar-picker").querySelector(
        '[aria-label$=" pill"]'
      ) as HTMLElement
    );
    pressCreate();

    await waitFor(() => expect(createBot).toHaveBeenCalled());
    expect(createBot.mock.calls[0]?.[0]).toMatchObject({
      name: "Scout",
      avatarShape: "pill",
      avatarColor: defaultAvatarColor("Scout"),
    });
  });
});

describe("the header", () => {
  it("takes a caller's own title, for the bot made during onboarding", () => {
    render(
      (
        <QueryClientProvider client={new QueryClient()}>
          <NewBotDialog
            isOpen
            title="firstBot.title"
            onClose={() => {}}
            onCreated={onCreated}
          />
        </QueryClientProvider>
      ) as JSX.Element
    );

    // The beforeEach dialog is on screen too; this is the one just rendered.
    const dialogs = [
      ...document.querySelectorAll('[data-id="new-bot-dialog"]'),
    ];
    const text = dialogs.at(-1)?.textContent ?? "";
    expect(text).toContain("firstBot.title");
    expect(text).not.toContain("bots.newDialog.title");
  });
});
