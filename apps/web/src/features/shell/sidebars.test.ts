/**
 * The rail warms a lazy sidebar's chunk on hover or focus, so the click
 * renders it without waiting on the network.
 */
import { expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => new Set<string>());
vi.mock("#renderer/features/artifacts", () => {
  loaded.add("artifacts");
  return { ArtifactsSidebar: () => null };
});
vi.mock("#renderer/features/library", () => {
  loaded.add("library");
  return { LibrarySidebar: () => null };
});
vi.mock("#renderer/features/settings", () => {
  loaded.add("settings");
  return { SettingsSidebar: () => null };
});

it("loads the area's sidebar chunk and nothing for an eager sidebar", async () => {
  const { preloadSidebar } = await import("./sidebars");
  expect(loaded.size).toBe(0);
  preloadSidebar("settings");
  await vi.waitFor(() => expect([...loaded]).toEqual(["settings"]));
  preloadSidebar("bots");
  preloadSidebar("library");
  await vi.waitFor(() =>
    expect([...loaded].sort()).toEqual(["library", "settings"])
  );
});
