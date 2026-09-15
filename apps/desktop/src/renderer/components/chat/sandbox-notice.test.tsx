import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { SandboxNotice } from "./sandbox-notice";

const notice = (): Element | null =>
  document.querySelector('[data-id="sandbox-notice"]');

describe("the no-sandbox notice", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("says nothing while the sandbox is on, or before the agent has said", () => {
    const { rerender } = render(
      <SandboxNotice sandbox={{ active: true, reason: null }} />
    );
    expect(notice()).toBeNull();
    rerender(<SandboxNotice sandbox={null} />);
    expect(notice()).toBeNull();
  });

  it("shows the reason when commands run unconfined", () => {
    render(
      <SandboxNotice
        sandbox={{
          active: false,
          reason: "bubblewrap or socat is not installed",
        }}
      />
    );
    expect(notice()?.textContent).toContain(
      "bubblewrap or socat is not installed"
    );
  });

  it("stays dismissed for the machine once crossed out", () => {
    const { unmount } = render(
      <SandboxNotice sandbox={{ active: false, reason: null }} />
    );
    fireEvent.click(
      document.querySelector('[data-id="sandbox-notice-dismiss"]')!
    );
    expect(notice()).toBeNull();
    unmount();

    render(<SandboxNotice sandbox={{ active: false, reason: null }} />);
    expect(notice()).toBeNull();
  });
});
