import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BootAvatar, BootAvatarHost, bootMood } from "./boot-avatar";

describe("boot avatar", () => {
  it("maps progress and failure to the character's real moods", () => {
    expect(bootMood("installing")).toBe("focused");
    expect(bootMood("waiting")).toBe("waiting");
    expect(bootMood("error")).toBe("blocked");
    expect(bootMood("open")).toBe("happy");
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
