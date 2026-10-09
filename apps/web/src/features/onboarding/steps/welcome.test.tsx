import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { expect, it, vi } from "vitest";

import { fixedT, initI18n } from "#renderer/lib/i18n";

import type { StepContext } from "./context";
import { WelcomeStep, type BrowserProfile } from "./welcome";

it.each([false, true])(
  "starts signup or the correct direct sign-in, saved default=%s",
  async (savedDefault) => {
    await initI18n();
    const signIn = vi.fn();
    const ctx = {
      t: fixedT(),
      busy: false,
      props: { signIn },
    } as unknown as StepContext;
    const profiles: BrowserProfile[] = savedDefault
      ? [
          {
            id: "work",
            browserName: "Chrome",
            profileName: "Work",
            isDefault: true,
            hasAbacusSession: true,
          },
        ]
      : [];
    render(<WelcomeStep ctx={ctx} profiles={profiles} heading={createRef()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign up for free" }));
    expect(signIn).toHaveBeenLastCalledWith("signup");
    fireEvent.click(
      screen.getByRole("button", { name: "I already have an account" })
    );
    if (savedDefault) expect(signIn).toHaveBeenLastCalledWith("signin", "work");
    else expect(signIn).toHaveBeenLastCalledWith("signin");
  }
);

it("offers eligible browser profiles and an alternate sign-in without selecting a signed-out profile", async () => {
  await initI18n();
  const signIn = vi.fn();
  const ctx = {
    t: fixedT(),
    busy: false,
    props: { signIn },
  } as unknown as StepContext;
  render(
    <WelcomeStep
      ctx={ctx}
      profiles={[
        {
          id: "work",
          browserName: "Chrome",
          profileName: "Work",
          hasAbacusSession: true,
        },
        {
          id: "personal",
          browserName: "Firefox",
          profileName: "Personal",
          hasAbacusSession: false,
        },
      ]}
      heading={createRef()}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "I already have an account" })
  );
  const work = await screen.findByRole("menuitem", { name: /Chrome.*Work/ });
  expect(screen.queryByRole("menuitem", { name: /Personal/ })).toBeNull();
  fireEvent.click(work);
  expect(signIn).toHaveBeenLastCalledWith("signin", "work");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.click(
    screen.getByRole("button", { name: "I already have an account" })
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Sign in another way" })
  );
  expect(signIn).toHaveBeenLastCalledWith("signin");
});
