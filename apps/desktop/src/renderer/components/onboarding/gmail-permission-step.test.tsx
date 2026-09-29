import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => {
  const t = (key: string): string => key;
  return { useTranslation: () => ({ t, i18n: { language: "en-US" } }) };
});

const { GmailPermissionStep } = await import("./gmail-permission-step");

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);
  return node;
};
const has = (id: string): boolean =>
  document.querySelector(`[data-id="${id}"]`) != null;

const onAllow = vi.fn();
const onDone = vi.fn();
const mount = (): void => {
  render(
    (
      <GmailPermissionStep
        email="someone@gmail.com"
        onAllow={onAllow}
        onDone={onDone}
        dots={null}
      />
    ) as JSX.Element
  );
};

beforeEach(() => {
  onAllow.mockReset();
  onDone.mockReset();
});

describe("the Gmail question after sign-in", () => {
  it("connects on Allow and moves on", async () => {
    onAllow.mockResolvedValue({ ok: true });
    mount();

    fireEvent.click(byId("onboarding-gmail-allow"));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("connected"));
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it("keeps the card up with the reason when the hop failed", async () => {
    onAllow.mockResolvedValue({ ok: false, error: "nope" });
    mount();

    fireEvent.click(byId("onboarding-gmail-allow"));

    await waitFor(() => expect(has("onboarding-gmail-failed")).toBe(true));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("says nothing of a hop the user cancelled", async () => {
    onAllow.mockResolvedValue({ ok: false, error: "x", cancelled: true });
    mount();

    fireEvent.click(byId("onboarding-gmail-allow"));

    await waitFor(() => expect(onAllow).toHaveBeenCalledTimes(1));
    expect(has("onboarding-gmail-failed")).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("takes Not now as the answer", () => {
    mount();

    fireEvent.click(byId("onboarding-gmail-not-now"));

    expect(onDone).toHaveBeenCalledWith("declined");
    expect(onAllow).not.toHaveBeenCalled();
  });
});
