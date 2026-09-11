/**
 * Editing a bot is the create form with the bot in it.
 *
 * The edit dialog used to be a different form — other labels, no check-ins —
 * so a bot given a schedule at creation could never be shown it again. Now
 * both are one form: the same fields under the same ids, the bot's own
 * check-in read back off Routines, and the bot's chat told once when an
 * edit changes what it is for.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => {
  // One stable object: the dialog's reset effect keys on `t`, and a fresh
  // function per render would reset the form on every keystroke.
  const translation = { t: (key: string) => key, i18n: { language: "en-US" } };
  return { useTranslation: () => translation };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const bot = {
  id: "bot-1",
  name: "WhatsApp Bot",
  title: "WhatsApp Assistant",
  description: "Handle WhatsApp",
  persona: "Brisk",
  model: null,
  avatarColor: "#3b82f6",
  avatarShape: "squircle",
};

const updateBot = vi.fn(
  async (input: { id: string; changes: Record<string, unknown> }) => ({
    ...bot,
    ...input.changes,
  })
);
const createRoutine = vi.fn(async (input: Record<string, unknown>) => input);
const updateRoutine = vi.fn(async (input: Record<string, unknown>) => input);
const removeRoutine = vi.fn(async () => undefined);
const routines = vi.hoisted(() => ({ data: [] as unknown[] }));

vi.mock("../../hooks/use-bots", () => ({
  useCreateBotMutation: () => ({ mutateAsync: vi.fn() }),
  useUpdateBotMutation: () => ({ mutateAsync: updateBot }),
}));
vi.mock("../../hooks/use-routines", () => ({
  useRoutinesQuery: () => routines,
  useCreateRoutineMutation: () => ({ mutateAsync: createRoutine }),
  useUpdateRoutineMutation: () => ({ mutateAsync: updateRoutine }),
  useRemoveRoutineMutation: () => ({ mutateAsync: removeRoutine }),
}));

const announceBotChange = vi.fn(async () => undefined);
(window as unknown as { api: unknown }).api = {
  agent: { listModels: async () => [], announceBotChange },
};

const { BotDialog } = await import("./bot-dialog");
const { CHECK_IN_PROMPT } = await import("./new-bot-dialog");

const onClose = vi.fn();

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);
  return node;
};

const mount = (): void => {
  render(
    (
      <QueryClientProvider client={new QueryClient()}>
        <BotDialog isOpen bot={bot as never} onClose={onClose} />
      </QueryClientProvider>
    ) as JSX.Element
  );
};

const pressSave = (): void => {
  fireEvent.click(screen.getByText("bots.save"));
};

beforeEach(() => {
  vi.clearAllMocks();
  routines.data = [];
});

describe("editing a bot", () => {
  it("is the create form with the bot's values in it", () => {
    mount();

    expect(screen.getByText("bots.editTitle")).toBeTruthy();
    expect((byId("new-bot-name-input") as HTMLInputElement).value).toBe(
      "WhatsApp Bot"
    );
    expect((byId("new-bot-persona-input") as HTMLTextAreaElement).value).toBe(
      "Brisk"
    );
    expect(
      (byId("new-bot-instructions-input") as HTMLTextAreaElement).value
    ).toBe("Handle WhatsApp");
    fireEvent.click(byId("new-bot-more-toggle"));
    expect((byId("new-bot-description-input") as HTMLInputElement).value).toBe(
      "WhatsApp Assistant"
    );
    expect(byId("new-bot-check-in-select")).toBeTruthy();
    expect(byId("new-bot-model-select")).toBeTruthy();
  });

  it("saves and closes, and tells the chat when the mission changed", async () => {
    mount();
    fireEvent.change(byId("new-bot-instructions-input"), {
      target: { value: "Handle WhatsApp and Telegram" },
    });
    pressSave();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateBot).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "bot-1",
        changes: expect.objectContaining({
          description: "Handle WhatsApp and Telegram",
        }),
      })
    );
    expect(announceBotChange).toHaveBeenCalledWith("bot-1", { mission: true });
  });

  it("says nothing to the chat for a rename", async () => {
    mount();
    fireEvent.change(byId("new-bot-name-input"), {
      target: { value: "WA Bot" },
    });
    pressSave();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(announceBotChange).not.toHaveBeenCalled();
  });

  it("reads the bot's check-in back, and changes it in place", async () => {
    routines.data = [
      {
        id: "job-1",
        botId: "bot-1",
        prompt: CHECK_IN_PROMPT,
        schedule: "30 8 * * 1-5",
      },
    ];
    mount();
    fireEvent.click(byId("new-bot-more-toggle"));
    await waitFor(() =>
      expect((byId("new-bot-check-in-select") as HTMLSelectElement).value).toBe(
        "weekdays"
      )
    );
    expect(
      (byId("new-bot-check-in-time-input") as HTMLInputElement).value
    ).toBe("08:30");

    fireEvent.change(byId("new-bot-check-in-select"), {
      target: { value: "daily" },
    });
    pressSave();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateRoutine).toHaveBeenCalledWith({
      id: "job-1",
      changes: { schedule: "30 8 * * *", enabled: true },
    });
    expect(createRoutine).not.toHaveBeenCalled();
    expect(announceBotChange).toHaveBeenCalledWith("bot-1", {
      checkIn: "every day at 08:30",
    });
  });

  it("removes the check-in when it is switched off", async () => {
    routines.data = [
      {
        id: "job-1",
        botId: "bot-1",
        prompt: CHECK_IN_PROMPT,
        schedule: "0 9 * * *",
      },
    ];
    mount();
    fireEvent.click(byId("new-bot-more-toggle"));
    await waitFor(() =>
      expect((byId("new-bot-check-in-select") as HTMLSelectElement).value).toBe(
        "daily"
      )
    );
    fireEvent.change(byId("new-bot-check-in-select"), {
      target: { value: "off" },
    });
    pressSave();

    await waitFor(() => expect(removeRoutine).toHaveBeenCalledWith("job-1"));
    expect(announceBotChange).toHaveBeenCalledWith("bot-1", { checkIn: "off" });
  });

  it("leaves an untouched check-in alone", async () => {
    routines.data = [
      {
        id: "job-1",
        botId: "bot-1",
        prompt: CHECK_IN_PROMPT,
        schedule: "0 9 * * *",
      },
    ];
    mount();
    pressSave();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateRoutine).not.toHaveBeenCalled();
    expect(removeRoutine).not.toHaveBeenCalled();
  });
});
