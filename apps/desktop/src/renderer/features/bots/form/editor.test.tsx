import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { fixtureBots } from "#renderer/data/fixture-db/rows";
import { renderApp } from "#renderer/test-support/app-harness";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
it("successive remote edits refresh blurred untouched fields and preserve edits in the mounted editor and outgoing patch", async () => {
  app = await renderApp("/bots/chief-of-staff/edit");
  const name = await screen.findByRole("textbox", { name: /^Name/ });
  const persona = screen.getByRole("textbox", { name: /^Persona/ });
  fireEvent.blur(name);
  fireEvent.change(persona, { target: { value: "My persona" } });
  const bot = fixtureBots()[0]!;
  for (const remote of ["Remote one", "Remote two"]) {
    await act(async () => {
      app!.db.bots.upsert({
        ...bot,
        name: remote,
        persona: "Remote persona",
        title: "Remote title",
      });
    });
    await waitFor(() => expect((name as HTMLInputElement).value).toBe(remote));
    expect((persona as HTMLTextAreaElement).value).toBe("My persona");
    expect(name.getAttribute("aria-invalid")).not.toBe("true");
  }
  const update = vi.spyOn(app.collections.bots, "update");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(app.collections.bots.get(bot.id)).toMatchObject({
    name: "Remote two",
    title: "Remote title",
    persona: "My persona",
  });
  const draft = { ...app.collections.bots.get(bot.id)! };
  const callback = update.mock.calls[0]![1] as (row: typeof draft) => void;
  const written = new Set<PropertyKey>();
  callback(
    new Proxy(draft, {
      set: (target, property, value) => {
        written.add(property);
        Reflect.set(target, property, value);
        return true;
      },
    })
  );
  expect([...written]).toEqual(["persona"]);
});

it("enables accessory selection and persists the pick in the mounted editor", async () => {
  app = await renderApp("/bots/chief-of-staff/edit");
  const glasses = await screen.findByRole("button", { name: "Glasses" });
  expect(glasses.hasAttribute("disabled")).toBe(false);
  fireEvent.click(glasses);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(app!.collections.bots.get("chief-of-staff")?.avatarAccessory).toBe(
      "glasses"
    )
  );
});
it("shows an active time error and allows saving after switching Off", async () => {
  app = await renderApp("/bots/chief-of-staff/edit");
  fireEvent.click(await screen.findByRole("button", { name: "Daily" }));
  const time = document.querySelector<HTMLInputElement>("#check-in-time")!;
  fireEvent.change(time, { target: { value: "" } });
  fireEvent.blur(time);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(time.getAttribute("aria-invalid")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Off" }));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByTestId("bot-chat", {}, { timeout: 5000 });
});
