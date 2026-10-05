import { expect, it } from "vitest";

import { providerMessage } from "./status";
it("extracts provider messages without rendering JSON as a headline", () => {
  expect(
    providerMessage(
      '403 {"error":{"message":"Access denied","type":"authorization"}}'
    )
  ).toBe("Access denied");
  expect(providerMessage('500 {"internal":true}')).toBe("");
  expect(providerMessage("403 Access denied")).toBe("Access denied");
  expect(providerMessage()).toBe("");
});
