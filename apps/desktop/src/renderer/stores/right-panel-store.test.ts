import { describe, expect, it } from "vitest";

import {
  createResourceRightPanelDescriptor,
  createRightPanelState,
  createSingletonRightPanelDescriptor,
  draftConversationKey,
  isRightPanelDescriptor,
  rightPanelReducer,
  rightPanelResourceId,
  rightPanelScopeKey,
  sessionConversationKey,
  selectRightPanelScope,
  type RightPanelAction,
  type RightPanelDescriptor,
  type RightPanelScopeKey,
  type RightPanelState,
} from "./right-panel-store";

const workspaceOne = rightPanelScopeKey({
  workspaceId: "workspace-one",
  sessionId: "session-one",
});
const workspaceTwo = rightPanelScopeKey({
  workspaceId: "workspace-two",
  sessionId: "session-two",
});

const files = createSingletonRightPanelDescriptor("files", "Files");
// A second surface, for the ordering and scoping assertions below. This was
// the diff pane's singleton until the pane was removed; any surface that is
// not `files` serves the same purpose.
const notes = createResourceRightPanelDescriptor({
  id: "notes",
  resourceType: "document",
  resourceKey: "notes.md",
  title: "Notes",
});

type UnscopedRightPanelAction = RightPanelAction extends infer Action
  ? Action extends { scope: RightPanelScopeKey }
    ? Omit<Action, "scope">
    : never
  : never;

const reduce = (
  state: RightPanelState,
  scope: RightPanelScopeKey,
  ...actions: UnscopedRightPanelAction[]
): RightPanelState =>
  actions.reduce(
    (current, action) =>
      rightPanelReducer(current, { ...action, scope } as RightPanelAction),
    state
  );

const ids = (state: RightPanelState, scope = workspaceOne): string[] =>
  selectRightPanelScope(state, scope).descriptors.map(({ id }) => id);

describe("right panel store", () => {
  it("uses one versioned draft per workspace and distinct saved sessions", () => {
    const draft = draftConversationKey("workspace-one");
    const sameDraft = rightPanelScopeKey({
      workspaceId: "workspace-one",
      sessionId: null,
    });
    const firstSession = sessionConversationKey("workspace-one", "session-one");
    const secondSession = sessionConversationKey(
      "workspace-one",
      "session-two"
    );

    expect(draft).toBe(sameDraft);
    expect(firstSession).not.toBe(draft);
    expect(secondSession).not.toBe(firstSession);
    expect(JSON.parse(draft)).toEqual([
      "conversation",
      1,
      "workspace-one",
      "draft",
    ]);
  });

  it("keeps ordered surfaces and active selection scoped by workspace session", () => {
    let state = createRightPanelState();
    state = reduce(
      state,
      workspaceOne,
      { type: "focus", descriptor: files },
      { type: "focus", descriptor: notes },
      { type: "focus", descriptor: files }
    );
    state = reduce(state, workspaceTwo, {
      type: "focus",
      descriptor: notes,
    });

    expect(ids(state)).toEqual(["files", "notes"]);
    expect(selectRightPanelScope(state, workspaceOne).activeId).toBe("files");
    expect(ids(state, workspaceTwo)).toEqual(["notes"]);
    expect(selectRightPanelScope(state, workspaceTwo).activeId).toBe("notes");
  });

  it("keeps multiple browser, file, and simulator instances while refocusing the same resource", () => {
    const browserOne = createResourceRightPanelDescriptor({
      id: "browser:profile-one:tab-one",
      resourceType: "browser",
      resourceKey: "profile-one/tab-one",
      title: "Local app",
    });
    const browserTwo = createResourceRightPanelDescriptor({
      resourceType: "browser",
      resourceKey: "profile-one/tab-two",
      title: "Documentation",
    });
    const fileOne = createResourceRightPanelDescriptor({
      resourceType: "file",
      resourceKey: "/workspace/src/app.tsx",
      title: "app.tsx",
    });
    const fileTwo = createResourceRightPanelDescriptor({
      resourceType: "file",
      resourceKey: "/workspace/src/router.tsx",
      title: "router.tsx",
    });
    const simulator = createResourceRightPanelDescriptor({
      resourceType: "simulator",
      resourceKey: "ios:device-1",
      title: "iPhone Simulator",
    });
    const refreshedFileOne = createResourceRightPanelDescriptor({
      resourceType: "file",
      resourceKey: "/workspace/src/app.tsx",
      title: "app.tsx: refreshed",
      metadata: { revision: 2 },
    });

    const state = reduce(
      createRightPanelState(),
      workspaceOne,
      { type: "focus", descriptor: browserOne },
      { type: "focus", descriptor: browserTwo },
      { type: "focus", descriptor: fileOne },
      { type: "focus", descriptor: fileTwo },
      { type: "focus", descriptor: simulator },
      { type: "focus", descriptor: refreshedFileOne }
    );
    const scope = selectRightPanelScope(state, workspaceOne);

    expect(fileOne.id).toBe(refreshedFileOne.id);
    expect(scope.descriptors).toEqual([
      browserOne,
      browserTwo,
      refreshedFileOne,
      fileTwo,
      simulator,
    ]);
    expect(scope.activeId).toBe(fileOne.id);
  });

  it("deduplicates only singleton kinds, not distinct resource instances", () => {
    const agentsOne = createResourceRightPanelDescriptor({
      resourceType: "agents",
      resourceKey: "run-one",
      title: "Agents: run one",
    });
    const agentsTwo = createResourceRightPanelDescriptor({
      resourceType: "agents",
      resourceKey: "run-two",
      title: "Agents: run two",
    });
    const state = reduce(
      createRightPanelState(),
      workspaceOne,
      { type: "focus", descriptor: files },
      { type: "focus", descriptor: notes },
      { type: "focus", descriptor: files },
      { type: "focus", descriptor: notes },
      { type: "focus", descriptor: agentsOne },
      { type: "focus", descriptor: agentsTwo }
    );

    expect(ids(state)).toEqual(["files", "notes", agentsOne.id, agentsTwo.id]);
  });

  it("closes the active surface to the next item, then the previous item", () => {
    let state = reduce(
      createRightPanelState(),
      workspaceOne,
      { type: "focus", descriptor: files },
      { type: "focus", descriptor: notes },
      {
        type: "focus",
        descriptor: createResourceRightPanelDescriptor({
          resourceType: "browser",
          resourceKey: "profile/tab",
          title: "Browser",
        }),
      },
      { type: "focus-existing", id: "notes" },
      { type: "close-active" }
    );

    const browserId = rightPanelResourceId("browser", "profile/tab");
    expect(ids(state)).toEqual(["files", browserId]);
    expect(selectRightPanelScope(state, workspaceOne).activeId).toBe(browserId);

    state = reduce(state, workspaceOne, { type: "close-active" });
    expect(ids(state)).toEqual(["files"]);
    expect(selectRightPanelScope(state, workspaceOne).activeId).toBe("files");
  });

  it("closes the final surface into the launcher and hides without forgetting open surfaces", () => {
    let state = reduce(
      createRightPanelState(),
      workspaceOne,
      { type: "focus", descriptor: files },
      { type: "close-active" }
    );
    let scope = selectRightPanelScope(state, workspaceOne);

    expect(scope.isOpen).toBe(true);
    expect(scope.activeId).toBeNull();
    expect(ids(state)).toEqual([]);

    state = reduce(
      state,
      workspaceOne,
      { type: "focus", descriptor: files },
      { type: "hide" }
    );
    scope = selectRightPanelScope(state, workspaceOne);
    expect(scope.isOpen).toBe(false);
    expect(ids(state)).toEqual(["files"]);

    state = reduce(state, workspaceOne, { type: "show" });
    scope = selectRightPanelScope(state, workspaceOne);
    expect(scope.isOpen).toBe(true);
    expect(scope.activeId).toBe("files");
  });

  it("keeps agent availability and its reason in the relevant scope", () => {
    let state = reduce(createRightPanelState(), workspaceOne, {
      type: "set-agents-availability",
      availability: { available: false, reason: "No active agent run" },
    });

    expect(
      selectRightPanelScope(state, workspaceOne).agentsAvailability
    ).toEqual({ available: false, reason: "No active agent run" });
    expect(
      selectRightPanelScope(state, workspaceTwo).agentsAvailability
    ).toEqual({ available: false, reason: null });

    state = reduce(state, workspaceOne, {
      type: "set-agents-availability",
      availability: { available: true, reason: "stale reason" },
    });
    expect(
      selectRightPanelScope(state, workspaceOne).agentsAvailability
    ).toEqual({ available: true, reason: null });
  });

  it("moves and merges a draft into its saved session exactly once", () => {
    const draft = draftConversationKey("workspace-one");
    const session = sessionConversationKey("workspace-one", "session-one");
    const browser = createResourceRightPanelDescriptor({
      resourceType: "browser",
      resourceKey: "browser-one",
      title: "Browser",
    });
    let state = reduce(createRightPanelState(), session, {
      type: "focus",
      descriptor: notes,
    });
    state = reduce(
      state,
      draft,
      { type: "focus", descriptor: files },
      { type: "focus", descriptor: browser },
      { type: "hide" },
      {
        type: "set-agents-availability",
        availability: { available: false, reason: "Draft run" },
      }
    );

    state = rightPanelReducer(state, {
      type: "promote-draft",
      from: draft,
      to: session,
    });
    const promoted = selectRightPanelScope(state, session);

    expect(state.scopes[draft]).toBeUndefined();
    expect(promoted.descriptors).toEqual([files, browser, notes]);
    expect(promoted.activeId).toBe(browser.id);
    expect(promoted.isOpen).toBe(false);
    expect(promoted.agentsAvailability).toEqual({
      available: false,
      reason: "Draft run",
    });

    const once = state;
    state = rightPanelReducer(state, {
      type: "promote-draft",
      from: draft,
      to: session,
    });
    expect(state).toBe(once);
  });

  it("disposes one conversation or every conversation in a workspace", () => {
    const draft = draftConversationKey("workspace-one");
    const session = sessionConversationKey("workspace-one", "session-one");
    const other = sessionConversationKey("workspace-two", "session-two");
    let state = reduce(createRightPanelState(), draft, {
      type: "focus",
      descriptor: files,
    });
    state = reduce(state, session, { type: "focus", descriptor: notes });
    state = reduce(state, other, { type: "focus", descriptor: files });

    state = rightPanelReducer(state, {
      type: "dispose-scope",
      scope: draft,
    });
    expect(state.scopes[draft]).toBeUndefined();
    expect(state.scopes[session]).toBeDefined();

    state = rightPanelReducer(state, {
      type: "dispose-workspace",
      workspaceId: "workspace-one",
    });
    expect(state.scopes[session]).toBeUndefined();
    expect(state.scopes[other]).toBeDefined();
  });

  it("cannot represent the terminal as a right-panel surface", () => {
    const terminal: RightPanelDescriptor = {
      id: "terminal",
      // @ts-expect-error Terminal belongs to the center column, not this union.
      kind: "terminal",
      title: "Terminal",
    };
    expect(isRightPanelDescriptor(terminal)).toBe(false);

    const invalidAction = {
      type: "focus",
      scope: workspaceOne,
      descriptor: terminal,
    } as RightPanelAction;
    const initial = createRightPanelState();
    expect(rightPanelReducer(initial, invalidAction)).toBe(initial);
  });
});
