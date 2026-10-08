import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BootAvatar, BootAvatarHost, bootMood } from "./boot-avatar";

describe("boot avatar", () => {
  it("maps progress and failure to the character's real moods", () => {
    expect(bootMood("installing")).toBe("focused");
    expect(bootMood("waiting")).toBe("waiting");
    expect(bootMood("error")).toBe("blocked");
    expect(bootMood("open")).toBe("happy");
  });
  it("keeps the dialog header above a later background home", () => {
    const view = render(
      <BootAvatarHost>
        <BootAvatar stage="error" size={48} overlay />
        <BootAvatar stage="open" size={22} brand={false} />
      </BootAvatarHost>
    );
    const rig = document.querySelector(
      '[data-slot="boot-avatar-live"] [data-slot="bot-avatar"]'
    );
    expect(rig?.getAttribute("data-mood")).toBe("blocked");
    view.rerender(
      <BootAvatarHost>
        <BootAvatar stage="open" size={22} brand={false} />
      </BootAvatarHost>
    );
    expect(
      document.querySelector(
        '[data-slot="boot-avatar-live"] [data-slot="bot-avatar"]'
      )
    ).toBe(rig);
    expect(rig?.getAttribute("data-mood")).toBe("happy");
  });
  it("keeps one live rig when the startup home changes", () => {
    const { rerender, unmount } = render(
      <BootAvatarHost>
        <BootAvatar stage="starting" />
      </BootAvatarHost>
    );
    const rig = document.querySelector(
      '[data-slot="boot-avatar-live"] [data-slot="bot-avatar"]'
    );
    expect(rig).not.toBeNull();
    rerender(
      <BootAvatarHost>
        <BootAvatar stage="open" size={72} />
      </BootAvatarHost>
    );
    expect(
      document.querySelector(
        '[data-slot="boot-avatar-live"] [data-slot="bot-avatar"]'
      )
    ).toBe(rig);
    expect(rig?.getAttribute("data-mood")).toBe("happy");
    unmount();
    expect(document.querySelector('[data-slot="boot-avatar-live"]')).toBeNull();
  });
});

it("does not install pointer tracking for standalone or hosted boot avatars", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("hover"),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const listener = vi.spyOn(document, "addEventListener");
  const view = render(<BootAvatar stage="open" />);
  try {
    view.rerender(
      <BootAvatarHost>
        <BootAvatar stage="open" />
      </BootAvatarHost>
    );
    expect(listener.mock.calls.some(([kind]) => kind === "pointermove")).toBe(
      false
    );
  } finally {
    view.unmount();
    listener.mockRestore();
    vi.unstubAllGlobals();
  }
});
