import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { Store } from "@tanstack/react-store";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { BrowserSurface } from "./index";
it("equivalent serialized lease updates do not register again or steal selected ownership", () => {
  const owner = new Store<string | null>("other-leaf");
  const register = vi.fn(() => vi.fn());
  const presenter = {
    owner,
    captures: new Store<Record<string, string>>({}),
    register,
    activate: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  };
  const lease = {
    conversationKey: sessionConversationKey("w", "s"),
    resourceId: "background",
    generation: 1,
  } as const;
  const props = { lease, presenter, visible: true, blocked: () => false };
  const view = render(<BrowserSurface {...props} />);
  view.rerender(<BrowserSurface {...props} lease={{ ...lease }} />);
  expect(register).toHaveBeenCalledOnce();
  expect(owner.state).toBe("other-leaf");
  view.unmount();
});
