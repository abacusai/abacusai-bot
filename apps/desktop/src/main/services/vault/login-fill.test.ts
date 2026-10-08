import { describe, expect, it } from "vitest";

import {
  chooseLoginFields,
  fieldName,
  type LoginCandidate,
  loginFilledText,
  loginPurpose,
  onLoginSite,
  signInLabel,
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

describe("a new password field", () => {
  const NEW = ["type", "password", "autocomplete", "new-password"];
  const CURRENT = ["type", "password", "autocomplete", "current-password"];

  it("is never taken as the sign-in's password", () => {
    const choice = chooseLoginFields(
      [field("u", "username", EMAIL), field("p", "password", NEW)],
      COUNTS
    );

    expect(choice.ok === false && choice.error).toMatch(/new password/);
  });

  it("leaves the form marked for the current password as the sign-in", () => {
    expect(
      chooseLoginFields(
        [
          field("join", "password", NEW, { form: 1 }),
          field("other", "password", PASS, { form: 2 }),
          field("login", "password", CURRENT, { form: 0 }),
        ],
        COUNTS
      )
    ).toMatchObject({ ok: true, password: "login" });
  });
});

describe("whether a form signs in", () => {
  const page = "Sign in | Welcome back | /login";

  it("names a button that reads as signing in, in the app's languages", () => {
    for (const label of [
      "Sign in",
      "Log in",
      "Continue",
      "Next",
      "Iniciar sesión",
      "Se connecter",
      "Anmelden",
      "ログイン",
      "Войти",
    ])
      expect(signInLabel(label), label).toBe(true);
    expect(signInLabel("Sign in with Google")).toBe(false);
  });

  it("refuses a button that joins, creates, resets, sends or deletes", () => {
    for (const label of [
      "Join now",
      "Create account",
      "Sign up",
      "Delete account",
      "Send reset link",
      "Reset password",
      "Registrieren",
      "Supprimer le compte",
    ])
      expect(loginPurpose({ label, page, usernameOnly: false }).ok, label).toBe(
        false
      );
  });

  it("fills without naming a button it cannot read as a sign-in", () => {
    expect(loginPurpose({ label: "Go", page, usernameOnly: false })).toEqual({
      ok: true,
      nameButton: false,
    });
    expect(loginPurpose({ label: null, page, usernameOnly: false })).toEqual({
      ok: true,
      nameButton: false,
    });
  });

  it("refuses a lone email field on a page that says it is a sign-up or reset", () => {
    for (const reset of [
      "Forgot password? | Reset your password | /checkpoint/rp",
      "Join LinkedIn | Make the most of your life | /signup",
    ])
      expect(
        loginPurpose({ label: "Continue", page: reset, usernameOnly: true }).ok
      ).toBe(false);
    expect(
      loginPurpose({ label: "Continue", page, usernameOnly: true })
    ).toEqual({ ok: true, nameButton: true });
  });
});

describe("a long button label", () => {
  it("is left out: the ref alone names the button", () => {
    expect(submitName({ ref: "@e7", label: "x".repeat(41) })).toBe("@e7");
  });
});

describe("whether a page is on a saved login's site", () => {
  it("takes subdomains of the site, and nothing that only ends like it", () => {
    expect(onLoginSite("www.linkedin.com", "linkedin.com")).toBe(true);
    expect(onLoginSite("evil-linkedin.com", "linkedin.com")).toBe(false);
    expect(onLoginSite("linkedin.com.evil.example", "linkedin.com")).toBe(
      false
    );
  });
});
