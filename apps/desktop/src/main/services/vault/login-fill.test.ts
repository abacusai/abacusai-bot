import { describe, expect, it } from "vitest";

import {
  chooseLoginFields,
  fieldName,
  type LoginCandidate,
  loginFilledText,
  submitName,
} from "./login-fill";
import { factsFromDocument, type FieldFacts } from "./vault-fill";

/** One input's facts from its attributes, beside a password field or not. */
const facts = (attributes: string[], adjacentPassword = false): FieldFacts => ({
  ...factsFromDocument({
    nodeName: "#document",
    children: [{ nodeName: "INPUT", backendNodeId: 1, attributes }],
  }).get(1)!,
  adjacentPassword,
});

const field = (
  handle: string,
  kind: "username" | "password",
  attributes: string[],
  where: { document?: number; form?: number; adjacent?: boolean } = {}
): LoginCandidate<string> => ({
  handle,
  kind,
  document: where.document ?? 0,
  form: where.form ?? 0,
  facts: facts(attributes, where.adjacent ?? false),
});

const USER = ["type", "text", "autocomplete", "username"];
const EMAIL = ["type", "email", "autocomplete", "email"];
const PASS = ["type", "password"];
const COUNTS = { inputs: 2, unusable: 0 };

describe("which fields take a saved login", () => {
  it("takes the one form's username and password", () => {
    expect(
      chooseLoginFields(
        [field("u", "username", USER), field("p", "password", PASS)],
        COUNTS
      )
    ).toEqual({ ok: true, document: 0, username: "u", password: "p" });
  });

  it("takes the sign-in form beside a sign-up form that asks for the password twice", () => {
    const choice = chooseLoginFields(
      [
        field("signup-email", "username", EMAIL, { form: 1 }),
        field("signup-pass", "password", PASS, { form: 1 }),
        field("signup-again", "password", PASS, { form: 1 }),
        field("login-user", "username", USER, { form: 0 }),
        field("login-pass", "password", PASS, { form: 0 }),
      ],
      COUNTS
    );

    expect(choice).toEqual({
      ok: true,
      document: 0,
      username: "login-user",
      password: "login-pass",
    });
  });

  it("refuses a form that asks for the password twice and nothing else", () => {
    const choice = chooseLoginFields(
      [field("a", "password", PASS), field("b", "password", PASS)],
      COUNTS
    );

    expect(choice.ok).toBe(false);
    expect(choice.ok === false && choice.error).toMatch(/sign-up/);
  });

  it("refuses two sign-in forms, and says how to fill by ref instead", () => {
    const choice = chooseLoginFields(
      [
        field("p0", "password", PASS, { form: 0 }),
        field("p1", "password", PASS, { form: 1 }),
      ],
      COUNTS
    );

    expect(choice.ok === false && choice.error).toMatch(
      /2 forms .* field:"username" and field:"password"/
    );
  });

  it("tells forms in different documents apart", () => {
    const choice = chooseLoginFields(
      [
        field("p0", "password", PASS, { document: 0, form: 0 }),
        field("p1", "password", PASS, { document: 1, form: 0 }),
      ],
      COUNTS
    );

    expect(choice.ok).toBe(false);
  });

  it("fills the password alone on a step that asks for no username", () => {
    expect(
      chooseLoginFields([field("p", "password", PASS)], COUNTS)
    ).toMatchObject({ ok: true, username: null, password: "p" });
  });

  it("fills the username alone on a username-first step", () => {
    expect(
      chooseLoginFields([field("u", "username", USER)], COUNTS)
    ).toMatchObject({ ok: true, username: "u", password: null });
  });

  it("singles out the field marked username among several", () => {
    expect(
      chooseLoginFields(
        [
          field("newsletter", "username", EMAIL, { form: -1 }),
          field("u", "username", USER, { form: -1 }),
        ],
        COUNTS
      )
    ).toMatchObject({ ok: true, username: "u" });
  });

  it("refuses when nothing singles the username out", () => {
    const choice = chooseLoginFields(
      [field("a", "username", EMAIL), field("b", "username", EMAIL)],
      COUNTS
    );

    expect(choice.ok === false && choice.error).toMatch(/several fields/);
  });

  it("looks for the username only in the password's own form", () => {
    expect(
      chooseLoginFields(
        [
          field("search-email", "username", EMAIL, { form: 2 }),
          field("p", "password", PASS, { form: 0 }),
        ],
        COUNTS
      )
    ).toMatchObject({ ok: true, username: null, password: "p" });
  });

  it("gives the real reason when there is nothing to fill", () => {
    const none = (counts: { inputs: number; unusable: number }): string => {
      const choice = chooseLoginFields([], counts);
      return choice.ok === false ? choice.error : "";
    };

    expect(none({ inputs: 0, unusable: 0 })).toMatch(
      /no text fields the browser can reach/
    );
    expect(none({ inputs: 3, unusable: 0 })).toMatch(
      /no password field, and no field marked for a username or email/
    );
    expect(none({ inputs: 2, unusable: 2 })).toMatch(
      /hidden, off screen, disabled or read-only/
    );
  });
});

describe("what a login fill says", () => {
  it("names both fields and the button to click", () => {
    expect(
      loginFilledText({
        username: "@e5",
        password: "@e6",
        submit: submitName({ ref: "@e7", label: "Sign in" }),
      })
    ).toBe(
      "Saved login filled (username into @e5, password into @e6); now click Sign in @e7."
    );
  });

  it("says the password is pending after a username-first step", () => {
    const text = loginFilledText({
      username: "@e5",
      password: null,
      submit: submitName({ ref: "@e8", label: "Next" }),
    });

    expect(text).toContain("The password is still pending");
    expect(text).toContain("Click Next @e8");
    expect(text).toContain('browser_vault_fill field:"login" again');
  });

  it("names a field or button the snapshot has no ref for by what it is", () => {
    expect(fieldName(null, "username")).toMatch(/^the username field/);
    expect(submitName({ ref: null, label: "Sign in" })).toBe(
      "Sign in (snapshot for its ref)"
    );
    expect(submitName(null)).toMatch(/sign-in button/);
  });
});
