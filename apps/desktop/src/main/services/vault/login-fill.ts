/**
 * `browser_vault_fill field:"login"`: the host finds the page's sign-in form
 * itself, from the DOM, instead of trusting the model to find its fields in
 * a snapshot. Here: the in-page reads it needs and the pure choice of which
 * fields take the username and password. Every field it picks still goes
 * through the checks of a fill by ref (`fieldKindAllowed` as first seen and
 * as it is now, the plan's origins, the script and queue checks).
 */
import { VISIBILITY_JS } from "../browser/visibility";
import { onSite } from "./site";
import { type FieldFacts, FIELD_FACTS_JS } from "./vault-fill";

/**
 * A button label that reads as the step that signs in, in the languages the
 * app speaks. Anchored: "Sign in with Google" is not the form's own button.
 */
const SIGN_IN_WORDS =
  "^(sign\\s*in|log\\s*in|login|log\\s*on|continue|next|verify|submit|" +
  "iniciar sesi[oó]n|entrar|acceder|continuar|siguiente|pr[oó]ximo|" +
  "se connecter|connexion|continuer|suivant|anmelden|einloggen|weiter|" +
  "accedi|avanti|masuk|lanjut|lanjutkan|ログイン|次へ|로그인|다음|登录|登入|下一步|" +
  "войти|далее|लॉग इन|जारी रखें)$";

/** Words for what a form does when it is not a sign-in. */
const ACCOUNT_ACTION_WORDS =
  "\\b(join|sign\\s*up|signup|register|registration|create|delete|remove|deactivate|close account|" +
  "reset|send|forgot|recover|change password|new password|update password|subscribe|" +
  "regist|crear|cr[ée]er|inscri|eliminar|borrar|supprimer|l[öo]schen|restablecer|" +
  "r[ée]initialiser|zur[üu]cksetzen|excluir|cadastr|daftar|hapus)|" +
  "(登録|削除|再設定|가입|삭제|재설정|注册|删除|重置|зарегистр|удалить|сброс)";

/**
 * Run on an input: whether a person could type into it now (on the page by
 * the snapshot's own rule, and not transparent or clipped to nothing), which
 * form of its document it belongs to (-1 for none), and its facts now.
 */
export const LOGIN_FIELD_FUNCTION = `function() {
  ${FIELD_FACTS_JS}
  ${VISIBILITY_JS}
  const shown = __typeableNow(this);
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
 * Run on the field a login fill anchors on, with `[[ref, selector], ...]`:
 * the button that submits its form (else the page's one visible button
 * whose text reads as a sign-in step), as its ref and label, or null; and
 * what the page says it is (title, main heading, path), to tell a sign-in
 * from a sign-up or a password reset.
 */
export const LOGIN_CONTEXT_FUNCTION = `function(pairs) {
  ${VISIBILITY_JS}
  const text = (el) => String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
  const form = this.form || this.closest('form');
  let button = null;
  if (form) {
    button = Array.from(form.querySelectorAll('button[type=submit],input[type=submit]')).find(__typeableNow)
      || Array.from(form.querySelectorAll('button:not([type])')).find(__typeableNow) || null;
  }
  if (!button) {
    const words = new RegExp(${JSON.stringify(SIGN_IN_WORDS)}, 'i');
    const found = Array.from(document.querySelectorAll('button,[role=button],input[type=submit],input[type=button]'))
      .filter((el) => __typeableNow(el) && words.test(text(el)));
    if (found.length === 1) button = found[0];
  }
  let submit = null;
  if (button) {
    let ref = null;
    for (const pair of pairs) {
      try { if (document.querySelector(pair[1]) === button) { ref = pair[0]; break; } } catch {}
    }
    submit = { ref: ref, label: text(button).slice(0, 200) };
  }
  const heading = document.querySelector('h1');
  return {
    submit: submit,
    page: [document.title, heading ? text(heading) : '', location.pathname].join(' | ').slice(0, 400),
  };
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

/** What the page or its button says when it is not a sign-in: an account action. */
function accountAction(text: string): boolean {
  return new RegExp(ACCOUNT_ACTION_WORDS, "i").test(text);
}

/** Whether a button's label reads as the step that signs in. */
export function signInLabel(label: string): boolean {
  return new RegExp(SIGN_IN_WORDS, "i").test(label.trim());
}

/**
 * Whether a login fill may go ahead on this form, and whether its button may
 * be named as the next click. An account action on the button (join, create,
 * delete, reset, send) is refused, and so is a username-only step on a page
 * that says it is one; a button that does not read as signing in is not
 * named, so the model is never told to press something else.
 */
export function loginPurpose(input: {
  label: string | null;
  page: string;
  usernameOnly: boolean;
}): { ok: true; nameButton: boolean } | { ok: false; error: string } {
  if (input.label != null && accountAction(input.label))
    return {
      ok: false,
      error:
        "Refused: this form's button is not a sign-in (it creates, changes, resets or deletes something), so " +
        "nothing was filled. Find the site's sign-in page and call again.",
    };
  if (input.usernameOnly && accountAction(input.page))
    return {
      ok: false,
      error:
        "Refused: this page is a sign-up or password reset, not a sign-in, so its email field was not filled. " +
        "Find the site's sign-in page and call again.",
    };
  return {
    ok: true,
    nameButton: input.label != null && signInLabel(input.label),
  };
}

/** Whether `host` is on `site` (a registrable domain), by the one site rule. */
export const onLoginSite = (host: string, site: string): boolean =>
  onSite(host, site);

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
  const all = candidates.filter((c) => c.kind === "password");
  // A field marked for a new password is a sign-up or a password change.
  const passwords = all.filter(
    (c) => !c.facts.autocomplete.includes("new-password")
  );
  if (all.length > 0 && passwords.length === 0)
    return {
      ok: false,
      error:
        "Refused: the password field here is for a new password, which is a sign-up or password change form, " +
        "not a sign-in. Nothing was filled.",
    };

  if (passwords.length > 0) {
    const forms = new Map<string, Array<LoginCandidate<T>>>();
    for (const password of passwords)
      forms.set(key(password), [...(forms.get(key(password)) ?? []), password]);
    let single = [...forms.values()].filter((list) => list.length === 1);
    // Of several, the one marked for the current password is the sign-in.
    const current = single.filter((list) =>
      list[0]!.facts.autocomplete.includes("current-password")
    );
    if (single.length > 1 && current.length === 1) single = current;
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

/**
 * How the result names the button to press next: its ref, with its label
 * only when short (the label is the page's text). Null when the button is not
 * to be named: the model is told to submit the form, not what to press.
 */
export function submitName(
  submit: { ref: string | null; label: string } | null
): string {
  if (submit == null) return "the form's sign-in button (snapshot to find it)";
  const label =
    submit.label.length > 0 && submit.label.length <= 40 ? submit.label : null;
  if (submit.ref != null)
    return label != null ? `${label} ${submit.ref}` : submit.ref;
  return `${label ?? "the sign-in button"} (snapshot for its ref)`;
}

/** The result of a login fill that typed everything it found. */
export function loginFilledText(input: {
  username: string | null;
  password: string | null;
  submit: string;
  /** The username was filled earlier under this sign-in, so it was left as it is. */
  usernameKept?: boolean;
}): string {
  if (input.usernameKept === true && input.password != null)
    return `Saved login: username already filled; password filled into ${input.password}. Now click ${input.submit}.`;
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
