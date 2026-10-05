/** R1-T2: search schemas fall back instead of throwing; defaults stay out of URLs. */
import { createMemoryHistory } from "@tanstack/react-router";
import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import { GallerySearch } from "#renderer/features/gallery";
import {
  createHarness,
  type AppHarness,
} from "#renderer/test-support/app-harness";

import {
  ArtifactsSearch,
  BotSearch,
  ConnectorsSearch,
  NewSessionSearch,
  RoutineSearch,
  SessionSearch,
  ShellSearch,
} from "./search";

const parse = <T extends v.GenericSchema>(schema: T, input: unknown) =>
  v.parse(schema, input);

describe("search schemas", () => {
  it("round-trips valid input", () => {
    expect(parse(ShellSearch, { tab: "terminal" })).toEqual({
      tab: "terminal",
    });
    expect(
      parse(SessionSearch, { view: "full", tab: "files", agent: "a1" })
    ).toEqual({
      view: "full",
      tab: "files",
      agent: "a1",
    });
    expect(
      parse(ArtifactsSearch, {
        type: "file",
        from: "bot:b",
        q: "plan",
        item: "x",
      })
    ).toEqual({
      type: "file",
      from: "bot:b",
      q: "plan",
      item: "x",
      view: "grid",
      sort: "newest",
    });
    expect(parse(RoutineSearch, { run: "s-1" })).toEqual({ run: "s-1" });
    expect(parse(NewSessionSearch, { workspace: "w1" })).toEqual({
      workspace: "w1",
    });
    expect(parse(ConnectorsSearch, { connector: "gmail" })).toEqual({
      connector: "gmail",
      category: "featured",
    });
  });

  it("falls back on invalid values and drops unknown keys", () => {
    expect(parse(ShellSearch, { tab: "nope", extra: 1 })).toEqual({
      tab: undefined,
    });
    expect(parse(SessionSearch, { view: "wide" })).toMatchObject({
      view: "split",
    });
    expect(parse(SessionSearch, {})).toMatchObject({ view: "split" });
    expect(parse(ArtifactsSearch, { q: "x".repeat(201) }).q).toBeUndefined();
    expect(
      parse(NewSessionSearch, { workspace: "../etc" }).workspace
    ).toBeUndefined();
    expect(parse(RoutineSearch, { run: ".hidden" }).run).toBeUndefined();
  });

  it("keeps a bot route from holding a session tab", () => {
    expect(parse(BotSearch, { tab: "terminal" }).tab).toBeUndefined();
    expect(parse(BotSearch, { tab: "memory" }).tab).toBe("memory");
  });

  it("accepts the gallery's theme values only", () => {
    expect(parse(GallerySearch, {}).theme).toBe("app");
    expect(parse(GallerySearch, { theme: "dark" }).theme).toBe("dark");
    expect(parse(GallerySearch, { theme: "sepia" }).theme).toBe("app");
    expect(parse(GallerySearch, { open: "dialog" }).open).toBe("dialog");
    expect(parse(GallerySearch, { open: "nope" }).open).toBeUndefined();
  });
});

describe("search middlewares", () => {
  let harness: AppHarness | null = null;
  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("strips the session view default from built links", async () => {
    harness = await createHarness("/sessions/new");
    const split = harness.router.buildLocation({
      to: "/sessions/$sessionId",
      params: { sessionId: "review-prs" },
      search: { view: "split" },
    } as never);
    expect(split.href).toBe("/sessions/review-prs");
    const full = harness.router.buildLocation({
      to: "/sessions/$sessionId",
      params: { sessionId: "review-prs" },
      search: { view: "full" },
    } as never);
    expect(full.href).toBe("/sessions/review-prs?view=full");
  });

  it("retains view across sessions", async () => {
    harness = await createHarness("/sessions/review-prs?view=full", {
      history: createMemoryHistory({
        initialEntries: ["/sessions/review-prs?view=full"],
      }),
    });
    await harness.router.load();
    const next = harness.router.buildLocation({
      to: "/sessions/$sessionId",
      params: { sessionId: "flights" },
    } as never);
    expect(next.search).toMatchObject({ view: "full" });
  });
});
