import { expect, it } from "vitest";

import { accountIdentity } from "./account-identity";

it.each([
  ["Ada Example", "ada@example.com", "AE"],
  ["  Ada   Middle Example  ", "ada@example.com", "AE"],
  ["Ada", null, "AD"],
  ["李 小明", null, "李小"],
  ["", "grace@example.com", "GR"],
  ["   ", null, "?"],
  [null, null, "?"],
])(
  "derives initials from the display name %s, then email, then a stable fallback",
  (name, email, initials) => {
    expect(accountIdentity({ name, email, picture: null }).initials).toBe(
      initials
    );
  }
);

it("keeps the account picture and trimmed display label", () => {
  expect(
    accountIdentity({
      name: " Ada Example ",
      email: "ada@example.com",
      picture: "data:image/png;base64,dummy",
    })
  ).toEqual({
    name: "Ada Example",
    initials: "AE",
    picture: "data:image/png;base64,dummy",
  });
  expect(accountIdentity(undefined)).toEqual({
    name: "",
    initials: "?",
    picture: undefined,
  });
});
