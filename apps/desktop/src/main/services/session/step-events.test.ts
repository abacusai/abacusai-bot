import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));

const { stepNote } = await import("./step-events");

const connected = (...ids: string[]) =>
  stepNote({
    event: "connector_connected",
    step: "offer-1",
    facts: { connected: ids },
  });

describe("the connected note", () => {
  it("tells the model a server's tools are in its list", () => {
    const note = connected("notion");
    expect(note).toContain("Notion is connected now");
    expect(note).toContain("Its tools are in your tool list.");
  });

  it("does not promise an app's own server's tools before the app serves them", () => {
    const note = connected("roblox-studio");
    expect(note).toContain("Roblox Studio is connected now");
    expect(note).not.toContain("Its tools are in your tool list.");
    expect(note).toContain(
      "Its tools join your tool list as soon as the app serves them."
    );
  });
});
