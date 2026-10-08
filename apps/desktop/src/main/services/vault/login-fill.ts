/**
 * `browser_vault_fill field:"login"`: the host finds the page's sign-in form
 * itself, from the DOM, instead of trusting the model to find its fields in
 * a snapshot. Here: the in-page reads it needs and the pure choice of which
 * fields take the username and password. Every field it picks still goes
 * through the checks of a fill by ref (`fieldKindAllowed` as first seen and
 * as it is now, the plan's origins, the script and queue checks).
 */
import { type FieldFacts, FIELD_FACTS_JS } from "./vault-fill";

/**
 * Run on an input: whether a person could type into it now (on screen, not
 * hidden, not disabled), which form of its document it belongs to (-1 for
 * none), and its facts as they are now.
 */
export const LOGIN_FIELD_FUNCTION = `function() {
  ${FIELD_FACTS_JS}
  const s = getComputedStyle(this);
  const r = this.getBoundingClientRect();
  const shown = this.isConnected && s.display !== 'none' && s.visibility === 'visible'
    && r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
  const form = this.form || this.closest('form');
  return {
    connected: this.isConnected,
    editable: !this.disabled && !this.readOnly,
    shown: shown,
    form: form ? Array.from(document.forms).indexOf(form) : -1,
    facts: __factsOf(this),
  };
}`;

/** Run on an element with `[[ref, selector], ...]`: the ref whose selector names it, or null. */
export const REF_OF_FUNCTION = `function(pairs) {
  for (const pair of pairs) {
    try { if (document.querySelector(pair[1]) === this) return pair[0]; } catch {}
  }
  return null;
}`;

/**
 * Run on the last field filled with `[[ref, selector], ...]`: the button that
 * submits its form (else the page's one visible "Sign in"/"Continue"-like
 * button), as its ref and label; null when there is no such one button.
 */
export const SUBMIT_OF_FUNCTION = `function(pairs) {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility === 'visible' && !el.disabled;
  };
  const text = (el) => String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
  const form = this.form || this.closest('form');
  let button = null;
  if (form) {
    button = Array.from(form.querySelectorAll('button[type=submit],input[type=submit]')).find(shown)
      || Array.from(form.querySelectorAll('button:not([type])')).find(shown) || null;
  }
  if (!button) {
    const words = /^(sign\\s*in|log\\s*in|login|continue|next|submit)$/i;
    const found = Array.from(document.querySelectorAll('button,[role=button],input[type=submit],input[type=button]'))
      .filter((el) => shown(el) && words.test(text(el)));
    if (found.length === 1) button = found[0];
  }
  if (!button) return null;
  let ref = null;
  for (const pair of pairs) {
    try { if (document.querySelector(pair[1]) === button) { ref = pair[0]; break; } } catch {}
  }
  return { ref: ref, label: text(button).slice(0, 60) };
}`;

/** Whether the page shows a sign-in field: a password field, or one marked for a username. */
export const LOGIN_FORM_PRESENT_SCRIPT = `(function() {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility === 'visible' && !el.disabled;
  };
  return Array.from(document.querySelectorAll('input')).some((el) => {
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
    return shown(el) && (type === 'password' || el.hasAttribute('data-abacusai-password')
      || tokens.includes('username') || tokens.includes('current-password'));
  });
})()`;

/** One field that may take a login value, as the host found it. */
export interface LoginCandidate<T> {
  /** What the caller needs to fill it (its remote object, its page). */
  handle: T;
  /** Which of the tab's documents it is in. */
  document: number;
  /** Its form within that document; -1 for none. */
  form: number;
  kind: "username" | "password";
  /** Its facts as they are now. */
  facts: FieldFacts;
}

/** What the scan saw besides the candidates: for a refusal that says why. */
export interface LoginScanCounts {
  /** Text-entry inputs read in all documents. */
  inputs: number;
  /** Sign-in fields that are hidden, off screen, disabled or read-only. */
  unusable: number;
}

export type LoginChoice<T> =
  | { ok: true; document: number; username: T | null; password: T | null }
  | { ok: false; error: string };

const BY_REF =
  'browser_vault_fill field:"username" and field:"password" with each field\'s ref from a snapshot';

/**
 * The one username field among several: the one marked username, else the
 * one marked email, else the one beside the password field; null when that
 * does not single one out.
 */
function pickUsername<T>(
  list: ReadonlyArray<LoginCandidate<T>>
): LoginCandidate<T> | null | "ambiguous" {
  if (list.length <= 1) return list[0] ?? null;
  const tests: Array<(facts: FieldFacts) => boolean> = [
    (facts) => facts.autocomplete.includes("username"),
    (facts) => facts.autocomplete.includes("email"),
    (facts) => facts.adjacentPassword,
  ];
  for (const test of tests) {
    const matched = list.filter((candidate) => test(candidate.facts));
    if (matched.length === 1) return matched[0]!;
  }
  return "ambiguous";
}

/**
 * Which fields take the saved login: the one form with exactly one password
 * field, with its username field if it has one; on a step with no password
 * field, the one username field. A refusal says what the page has instead.
 */
export function chooseLoginFields<T>(
  candidates: ReadonlyArray<LoginCandidate<T>>,
  counts: LoginScanCounts
): LoginChoice<T> {
  const key = (candidate: LoginCandidate<T>): string =>
    `${candidate.document}:${candidate.form}`;
  const passwords = candidates.filter((c) => c.kind === "password");

  if (passwords.length > 0) {
    const forms = new Map<string, Array<LoginCandidate<T>>>();
    for (const password of passwords)
      forms.set(key(password), [...(forms.get(key(password)) ?? []), password]);
    const single = [...forms.values()].filter((list) => list.length === 1);
    if (single.length === 0)
      return {
        ok: false,
        error:
          "Refused: the form here asks for a password more than once, which is a sign-up or password change " +
          "form, not a sign-in. Nothing was filled.",
      };
    if (single.length > 1)
      return {
        ok: false,
        error:
          `Refused: ${single.length} forms here have a password field, so which one signs in is unclear. ` +
          `Nothing was filled. Fill by ref instead: ${BY_REF}.`,
      };
    const password = single[0]![0]!;
    const username = pickUsername(
      candidates.filter(
        (c) => c.kind === "username" && key(c) === key(password)
      )
    );
    if (username === "ambiguous")
      return {
        ok: false,
        error:
          "Refused: the sign-in form has more than one field that could take the username, so which one is " +
          `unclear. Nothing was filled. Fill by ref instead: ${BY_REF}.`,
      };
    return {
      ok: true,
      document: password.document,
      username: username?.handle ?? null,
      password: password.handle,
    };
  }

  const username = pickUsername(
    candidates.filter((c) => c.kind === "username")
  );
  if (username === "ambiguous")
    return {
      ok: false,
      error:
        "Refused: there is no password field here, and several fields could take the username, so which one " +
        `signs in is unclear. Nothing was filled. Fill by ref instead: ${BY_REF}.`,
    };
  if (username != null)
    return {
      ok: true,
      document: username.document,
      username: username.handle,
      password: null,
    };
  if (counts.unusable > 0)
    return {
      ok: false,
      error:
        "No sign-in field here can be typed into now: the page has sign-in fields, but they are hidden, off " +
        'screen, disabled or read-only. If a "Sign in" button reveals the form, click it, then call again.',
    };
  return {
    ok: false,
    error:
      counts.inputs === 0
        ? "No sign-in form here: the page has no text fields the browser can reach. If it has a " +
          '"Sign in" link or button, click it first. A form inside a shadow root or a frame the browser ' +
          "cannot read is out of its reach."
        : "No sign-in form here: no password field, and no field marked for a username or email. If the " +
          'page has a "Sign in" link or button, click it first.',
  };
}

/** How the result names a field: its ref, or what it is when it has none. */
export const fieldName = (ref: string | null, kind: string): string =>
  ref ?? `the ${kind} field (it has no ref in the last snapshot)`;

/** How the result names the button to press next. */
export function submitName(
  submit: { ref: string | null; label: string } | null
): string {
  if (submit == null) return "the form's sign-in button (snapshot to find it)";
  const label = submit.label.length > 0 ? submit.label : "the sign-in button";
  return submit.ref != null
    ? `${label} ${submit.ref}`
    : `${label} (snapshot for its ref)`;
}

/** The result of a login fill that typed everything it found. */
export function loginFilledText(input: {
  username: string | null;
  password: string | null;
  submit: string;
}): string {
  if (input.username != null && input.password != null)
    return `Saved login filled (username into ${input.username}, password into ${input.password}); now click ${input.submit}.`;
  if (input.username != null)
    return (
      `Saved login: username filled into ${input.username}. The password is still pending: this step has no ` +
      `password field. Click ${input.submit} to go on, then call browser_vault_fill field:"login" again on the ` +
      "password step."
    );
  return (
    `Saved login: password filled into ${input.password} (this step asks for no username; the site has it ` +
    `already). Now click ${input.submit}.`
  );
}
