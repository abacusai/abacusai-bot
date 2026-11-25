import { contract } from "@abacus-ai/contract/contract";
import type { GithubStatus } from "@abacus-ai/contract/contract/github";
import { implement } from "@orpc/server";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { fixturePrefs } from "#renderer/data/fixture-db/rows";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
const status = (patch: Partial<GithubStatus>): GithubStatus => ({
  state: "ok",
  version: "2.83.0",
  account: "ada",
  host: "github.com",
  message: null,
  ...patch,
});
const row = async (id: string) =>
  within(
    await waitFor(
      () => {
        const node = document.querySelector<HTMLElement>(
          `[data-setting-id="${id}"]`
        );
        if (!node) throw new Error(`no ${id}`);
        return node;
      },
      { timeout: 5_000 }
    )
  );

it.each([
  [status({}), "Connected", "Signed in as @ada on github.com · gh 2.83.0"],
  [
    status({ state: "missing", version: null, account: null, host: null }),
    "Not installed",
    "Install gh from cli.github.com (macOS: brew install gh), then run gh auth login.",
  ],
  [
    status({ state: "unauthenticated", account: null, host: null }),
    "Not signed in",
    "Run gh auth login in a terminal, then check again.",
  ],
  [
    status({ state: "error", message: "gh: something broke" }),
    "Unavailable",
    // The CLI's own words are for the log.
    "Something went wrong. Try again.",
  ],
] as const)("shows gh's state: %o", async (answer, pill, detail) => {
  app = await renderApp("/settings/environment", {
    procedures: {
      github: { status: os.github.status.handler(() => answer) },
    },
  });
  const cli = await row("githubCli");
  expect(await cli.findByText(pill)).toBeTruthy();
  expect(cli.getByText(detail)).toBeTruthy();
  expect(cli.queryByRole("button", { name: "Get gh" }) !== null).toBe(
    answer.state === "missing"
  );
  expect(cli.queryByRole("button", { name: "Check again" }) !== null).toBe(
    answer.state !== "ok"
  );
});

it("Check again asks gh afresh, past main's cache", async () => {
  const inputs: unknown[] = [];
  app = await renderApp("/settings/environment", {
    procedures: {
      github: {
        status: os.github.status.handler(({ input }) => {
          inputs.push(input);
          return inputs.length > 1
            ? status({})
            : status({ state: "unauthenticated", account: null });
        }),
      },
    },
  });
  const cli = await row("githubCli");
  fireEvent.click(await cli.findByRole("button", { name: "Check again" }));
  expect(await cli.findByText("Connected")).toBeTruthy();
  expect(inputs.at(-1)).toEqual({ refresh: true });
});

it("turning the integration off hides gh's row and saves the pref", async () => {
  const seed = defaultSeed();
  seed.prefs = fixturePrefs({ githubIntegration: true });
  app = await renderApp("/settings/environment", { seed });
  const toggle = (await row("githubIntegration")).getByRole("switch");
  await row("githubCli");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(app!.db.prefs.rows.get("app")?.githubIntegration).toBe(false)
  );
  await waitFor(() =>
    expect(document.querySelector('[data-setting-id="githubCli"]')).toBeNull()
  );
});
