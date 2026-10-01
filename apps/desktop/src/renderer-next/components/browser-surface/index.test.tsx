import { Store } from "@tanstack/react-store";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { BrowserSurface } from ".";

it("runtime state refreshes keep the same native candidate until its generation changes", () => {
  const unregister = vi.fn();
  const presenter = {
    captures: new Store<Record<string, string>>({}),
    owner: new Store<string | null>(null),
    refresh: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    register: vi.fn(() => unregister),
  };
  const lease = {
    conversationKey: "session",
    resourceId: "browser",
    generation: 1,
  };
  const blocked = () => false;
  const view = render(
    <BrowserSurface
      lease={lease}
      presenter={presenter}
      blocked={blocked}
      visible
    />
  );
  view.rerender(
    <BrowserSurface
      lease={{ ...lease }}
      presenter={presenter}
      blocked={blocked}
      visible
    />
  );
  expect(presenter.register).toHaveBeenCalledTimes(1);
  expect(unregister).not.toHaveBeenCalled();
  view.rerender(
    <BrowserSurface
      lease={{ ...lease, generation: 2 }}
      presenter={presenter}
      blocked={blocked}
      visible
    />
  );
  expect(unregister).toHaveBeenCalledTimes(1);
  expect(presenter.register).toHaveBeenCalledTimes(2);
  view.unmount();
});
