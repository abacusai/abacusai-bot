import { expect, it } from "vitest";

import { notificationSilent } from "./notification-policy";
it("OS notifications are silent to avoid duplicating renderer cues", () => {
  expect(notificationSilent()).toBe(true);
});
