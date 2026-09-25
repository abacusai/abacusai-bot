/**
 * The routine dialog's schedule picker: presets in, cron out.
 *
 * The store only ever sees a cron string, so the one thing worth pinning is
 * that each control the user touches lands in the expression that gets
 * saved, and that opening an existing routine puts those controls back
 * where they were.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// One stable `t`: the dialog re-seeds its fields when `t` changes, as the
// real i18next instance only does on a language switch.
vi.mock("react-i18next", () => {
  const t = (key: string, options?: Record<string, string>): string =>
    options == null ? key : `${key} ${JSON.stringify(options)}`;
  const translation = { t, i18n: { language: "en-US" } };
  return { useTranslation: () => translation };
});

import type { RoutineCreateInput, RoutineListItem } from "#shared/routines";

const { RoutinesPanel } = await import("./routines-panel");
const { useWorkspaceStore } = await import("../../stores/code-store");

const routine = (overrides: Partial<RoutineListItem>): RoutineListItem => ({
  id: "r1",
  name: "Standup notes",
  schedule: "30 8 * * 1-5",
  runAt: null,
  webhookToken: null,
  prompt: "Summarise yesterday.",
  workspaceId: null,
  botId: null,
  enabled: true,
  createdAt: 0,
  lastRunAt: null,
  lastResult: null,
  runs: [],
  nextRunAt: null,
  webhookUrl: null,
  webhookPublicPending: false,
  botName: null,
  ...overrides,
});

const listRoutines = vi.fn(async (): Promise<RoutineListItem[]> => []);
const createRoutine = vi.fn(async (_input: RoutineCreateInput) =>
  routine({ id: "r-new" })
);
const runRoutine = vi.fn(async () => {});
const updateRoutine = vi.fn(async () => routine({}));
const listBots = vi.fn(async (): Promise<{ id: string; name: string }[]> => []);
const openFolderDialog = vi.fn(async () => "/code/new");
const addWorkspace = vi.fn(async (_path: string, _flag: boolean) => ({
  success: true,
  workspaceId: "ws-new",
}));
const getMetadata = vi.fn(async () => ({
  workspaces: [
    { id: "ws-1", path: "/code/abacusai-bot", status: "active", kind: null },
    // A routine's own folder is a place for runs to stand, not a project.
    {
      id: "ws-r",
      path: "/home/.routines/r1",
      status: "active",
      kind: "routine",
    },
  ],
}));
const getMessagingSnapshot = vi.fn(async () => ({ autoReplies: [] }));

const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

const mount = async (): Promise<void> => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    (
      <QueryClientProvider client={client}>
        <RoutinesPanel />
      </QueryClientProvider>
    ) as JSX.Element
  );
  await waitFor(() => expect(byId("new-routine-btn")).toBeTruthy());
};

const openNew = async (): Promise<void> => {
  fireEvent.click(byId("new-routine-btn")!);
  await waitFor(() => expect(byId("routine-preset-group")).toBeTruthy());
  fireEvent.change(byId("routine-prompt-input")!, {
    target: { value: "Do the thing." },
  });
};

const pressCreate = (): void => {
  const dialog = byId("routine-dialog") ?? document.body;
  const button = [...dialog.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "routines.create"
  );
  expect(button).toBeTruthy();
  fireEvent.click(button!);
};

beforeEach(() => {
  listRoutines.mockReset().mockResolvedValue([]);
  listBots.mockReset().mockResolvedValue([]);
  createRoutine.mockClear();
  updateRoutine.mockClear();
  (globalThis.window as unknown as { api: unknown }).api = {
    openFolderDialog,
    agent: {
      listRoutines,
      createRoutine,
      updateRoutine,
      runRoutine,
      removeRoutine: vi.fn(),
      listBots,
      getMetadata,
      addWorkspace,
      getMessagingSnapshot,
      decideMessagingPairing: vi.fn(),
    },
  };
});

describe("the schedule picker", () => {
  it("defaults a new routine to daily at nine", async () => {
    await mount();
    await openNew();

    expect(byId("routine-preset-daily")?.getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(byId("routine-cron-input")).toBeNull();
    pressCreate();

    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      schedule: "0 9 * * *",
      webhook: false,
    });
  });

  it("composes the time into the cron for weekdays", async () => {
    await mount();
    await openNew();

    fireEvent.click(byId("routine-preset-weekdays")!);
    fireEvent.change(byId("routine-time-input")!, {
      target: { value: "17:45" },
    });
    pressCreate();

    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      schedule: "45 17 * * 1-5",
    });
  });

  it("shows a weekday picker only for weekly, and saves manual as no cron", async () => {
    await mount();
    await openNew();

    expect(byId("routine-weekday-select")).toBeNull();
    fireEvent.click(byId("routine-preset-weekly")!);
    expect(byId("routine-weekday-select")?.textContent).toContain("Monday");

    fireEvent.click(byId("routine-preset-manual")!);
    expect(byId("routine-time-input")).toBeNull();
    expect(byId("routine-weekday-select")).toBeNull();
    pressCreate();

    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({ schedule: null });
  });

  it("refuses an empty custom expression", async () => {
    await mount();
    await openNew();

    fireEvent.click(byId("routine-preset-custom")!);
    expect(byId("routine-cron-input")).toBeTruthy();
    pressCreate();

    await waitFor(() =>
      expect(document.body.textContent).toContain("routines.scheduleRequired")
    );
    expect(createRoutine).not.toHaveBeenCalled();
  });

  it("reopens an existing routine on the preset that made it", async () => {
    listRoutines.mockResolvedValue([
      routine({ schedule: "15 7 * * 4" }),
      routine({ id: "r2", name: "Odd", schedule: "*/15 * * * *" }),
    ]);
    await mount();
    await waitFor(() => expect(byId("routine-card-r1")).toBeTruthy());

    // The card says it in words; the odd cron stays as the only honest form.
    expect(byId("routine-schedule-r1")?.textContent).toContain(
      "routines.scheduleWeekly"
    );
    expect(byId("routine-schedule-r1")?.textContent).toContain("Thursday");
    expect(byId("routine-schedule-r2")?.textContent).toBe("*/15 * * * *");

    fireEvent.click(byId("routine-edit-r1")!);
    await waitFor(() => expect(byId("routine-preset-group")).toBeTruthy());
    expect(byId("routine-preset-weekly")?.getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect((byId("routine-time-input") as HTMLInputElement).value).toBe(
      "07:15"
    );
    expect(byId("routine-weekday-select")?.textContent).toContain("Thursday");
  });

  it("runs once at a chosen moment, and refuses one already gone", async () => {
    await mount();
    await openNew();

    fireEvent.click(byId("routine-preset-once")!);
    expect(byId("routine-time-input")).toBeNull();
    fireEvent.change(byId("routine-run-at-input")!, {
      target: { value: "2020-01-01T09:00" },
    });
    pressCreate();
    await waitFor(() =>
      expect(document.body.textContent).toContain("routines.runAtPast")
    );
    expect(createRoutine).not.toHaveBeenCalled();

    const future = new Date(Date.now() + 86_400_000);
    future.setSeconds(0, 0);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const local = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    fireEvent.change(byId("routine-run-at-input")!, {
      target: { value: local },
    });
    pressCreate();

    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      schedule: null,
      runAt: future.getTime(),
    });
  });

  it("describes a run-once routine by its moment, and reopens it on Once", async () => {
    const at = new Date(2030, 0, 2, 9, 30).getTime();
    listRoutines.mockResolvedValue([routine({ schedule: null, runAt: at })]);
    await mount();
    await waitFor(() => expect(byId("routine-card-r1")).toBeTruthy());

    expect(byId("routine-schedule-r1")?.textContent).toContain(
      "routines.scheduleOnce"
    );

    fireEvent.click(byId("routine-edit-r1")!);
    await waitFor(() => expect(byId("routine-preset-group")).toBeTruthy());
    expect(byId("routine-preset-once")?.getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect((byId("routine-run-at-input") as HTMLInputElement).value).toBe(
      "2030-01-02T09:30"
    );
  });

  it("runs a new routine once right away, unless told not to", async () => {
    await mount();
    await openNew();
    pressCreate();

    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(runRoutine).toHaveBeenCalledWith("r-new", "create")
    );
  });

  it("skips the test run when the switch is off", async () => {
    await mount();
    await openNew();
    fireEvent.click(byId("routine-test-run-toggle")!);
    pressCreate();

    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(runRoutine).not.toHaveBeenCalled();
  });
});

describe("the folder a routine runs in", () => {
  it("offers projects, never a routine's own folder, and defaults to none", async () => {
    await mount();
    await openNew();

    const select = byId("routine-workspace-select") as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    // Its own folder, the one project open, and the way to add another.
    expect([...select.options].map((option) => option.value)).toEqual([
      "",
      "ws-1",
      "__choose__",
    ]);

    pressCreate();
    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: null,
    });
  });

  it("sends the folder the user picked", async () => {
    await mount();
    await openNew();

    const select = byId("routine-workspace-select") as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: "ws-1" } });
    pressCreate();

    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-1",
    });
  });

  it("adds a folder from the file dialog and selects it", async () => {
    // With no project open the list is one option long, and the instruction
    // the user just wrote is about a repository.
    await mount();
    await openNew();

    const select = byId("routine-workspace-select") as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: "__choose__" } });

    await waitFor(() =>
      expect(addWorkspace).toHaveBeenCalledWith("/code/new", false)
    );
    pressCreate();

    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-new",
    });
  });

  it("points a template that reads a repository at the open project", async () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-1" });
    await mount();

    // "Pull request digest" says "this workspace's repository"; run in a
    // routine's own folder there is no repository to read.
    fireEvent.click(byId("routine-template-pr-digest")!);
    await waitFor(() => expect(byId("routine-preset-group")).toBeTruthy());

    const select = byId("routine-workspace-select") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("ws-1"));

    pressCreate();
    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-1",
    });
  });
});
