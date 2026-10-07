/**
 * `traveler`: the user's saved travelers for booking forms.
 * - `get` reads them; a passport number is shown masked, never whole: the
 *   browser types it with `browser_traveler_fill` from the traveler's id.
 * - `save` asks first: it returns the exact question to send and a request
 *   id, and only the user's next message after that answers it. A passport
 *   is a second question, answered by a later message of its own.
 * - `forget` drops a traveler, or just the passport.
 * Offered only in the user's own conversations (owner-tools.ts).
 */
import {
  type PhoneToolDefinition,
  stringParam,
  toolText,
} from "../phone/phone-tool.js";
import {
  type Consent,
  MAX_TRAVELERS,
  nextTravelerId,
  readTravelers,
  type Traveler,
  writeTravelers,
} from "./traveler-store.js";

export const TRAVELER_TOOL_NAME = "traveler";

/** One message the user wrote, in arrival order. */
export interface UserWords {
  seq: number;
  text: string;
}

/** Host-added parts of a turn's text: "[note] …", "[linked] …", "[routine] …". */
const HOST_TAG = /^\s*\[[a-z][a-z -]*\]/i;

/**
 * The user's own words in a turn's text. The phone lane joins a batch's
 * messages with blank lines and writes its own notes as one tagged line, so
 * a part that starts with a host tag is not the user's.
 */
export function userWords(turnText: string): string[] {
  return turnText
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !HOST_TAG.test(part));
}

/** The user's last few messages, each with its place in the conversation. */
export class RecentUserText {
  private readonly messages: UserWords[] = [];
  private seq = 0;

  constructor(private readonly keep = 6) {}

  /** A turn's text, or a message steered in mid-turn. */
  note(turnText: string): void {
    for (const text of userWords(turnText)) {
      this.messages.push({ seq: ++this.seq, text });
      if (this.messages.length > this.keep) this.messages.shift();
    }
  }

  read = (): readonly UserWords[] => this.messages;
}

export interface TravelerToolOptions {
  /** The bot directory the store lives under. */
  home: string;
  recentUserText: () => readonly UserWords[];
}

const squash = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\s.,!?;:"'`’“”()]+/g, " ")
    .trim();

const AFFIRMATIVE =
  /\b(?:yes|yeah|yep|yup|ya|sure|ok|okay|okey|alright|fine|absolutely|definitely|please|save|keep|store|remember|go\s+ahead|do\s+it|haan|han|ha|ji|theek|sí|si|oui|ja|da|claro|bien)\b|👍|✅|👌/iu;
const NEGATIVE =
  /\b(?:no|nope|nah|not|don'?t|do\s+not|never|nahi|nahin|mat|non|nein|cancel|stop)\b|👎|❌/iu;

/** Whether a message says yes, and nothing that says no. */
export const isAffirmative = (text: string): boolean =>
  AFFIRMATIVE.test(text) && !NEGATIVE.test(text);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A save waiting on the user's answer to the question it asked. */
interface PendingSave {
  id: string;
  kind: "details" | "passport";
  traveler: Traveler;
  /** The passport given with the details: asked about next, separately. */
  passport: Traveler["passport"];
  /** The user's last message when the question was asked: the answer comes after it. */
  afterSeq: number;
}

/** What a details question names, without any number. */
const keptFields = (traveler: Traveler): string =>
  [
    "name",
    traveler.dateOfBirth != null ? "date of birth" : null,
    traveler.gender != null ? "gender" : null,
    traveler.nationality != null ? "nationality" : null,
    traveler.email != null ? "email" : null,
    traveler.phone != null ? "phone" : null,
  ]
    .filter((field): field is string => field != null)
    .join(", ");

const optional = (value: unknown, max = 120): string | null => {
  const text = stringParam(value).trim().slice(0, max);
  return text.length > 0 ? text : null;
};

const masked = (number: string): string =>
  `••••${number.replace(/\s+/g, "").slice(-2)}`;

function describe(traveler: Traveler): string {
  const parts = [`${traveler.id}: ${traveler.name}`];
  if (traveler.dateOfBirth != null) parts.push(`born ${traveler.dateOfBirth}`);
  if (traveler.gender != null) parts.push(traveler.gender);
  if (traveler.nationality != null)
    parts.push(`nationality ${traveler.nationality}`);
  if (traveler.email != null) parts.push(traveler.email);
  if (traveler.phone != null) parts.push(traveler.phone);
  const passport = traveler.passport;
  if (passport != null)
    parts.push(
      `passport ${masked(passport.number)} saved` +
        (passport.expiry != null ? `, expires ${passport.expiry}` : "") +
        (passport.country != null ? `, issued by ${passport.country}` : "") +
        ` (the browser types the number: give its task traveler ${traveler.id})`
    );
  return parts.join(", ");
}

export function buildTravelerTool(
  options: TravelerToolOptions
): PhoneToolDefinition {
  const get = () => {
    const travelers = readTravelers(options.home);
    if (travelers.length === 0)
      return toolText(
        "No travelers saved. Ask for the details the form needs, once, in one message."
      );
    return toolText(travelers.map(describe).join("\n"));
  };

  /** Questions asked and not yet answered, by request id. */
  const pending = new Map<string, PendingSave>();
  let requests = 0;
  const lastSeq = (): number => options.recentUserText().at(-1)?.seq ?? 0;
  /** The user's very next message after `afterSeq`: the answer to what was asked then. */
  const answerAfter = (afterSeq: number): UserWords | null =>
    options.recentUserText().find((message) => message.seq === afterSeq + 1) ??
    null;

  const ask = (save: Omit<PendingSave, "id" | "afterSeq">): string => {
    const id = `R${++requests}`;
    pending.set(id, { ...save, id, afterSeq: lastSeq() });
    const who = save.traveler.name;
    const question =
      save.kind === "passport"
        ? `Also keep ${who}'s passport for your next bookings? It is never shown back, only typed into booking forms. (yes/no)`
        : `Keep ${who}'s details (${keptFields(save.traveler)}) for your next bookings? (yes/no)`;
    return (
      `Not saved yet. Send the user exactly this question, in their language, and nothing else with it: "${question}" ` +
      `Their next message answers it. Then call traveler save with request_id "${id}" (nothing else).`
    );
  };

  const commit = (save: PendingSave, answer: UserWords) => {
    const travelers = readTravelers(options.home);
    const existing =
      travelers.find((item) => item.id === save.traveler.id) ??
      travelers.find(
        (item) => squash(item.name) === squash(save.traveler.name)
      );
    if (existing == null && travelers.length >= MAX_TRAVELERS)
      return toolText(
        `Not saved: ${MAX_TRAVELERS} travelers are saved already; forget one first.`,
        true
      );
    const at = new Date().toISOString();
    const consent: Consent = { quote: answer.text.slice(0, 200), at };
    const traveler: Traveler =
      save.kind === "passport"
        ? {
            ...(existing ?? save.traveler),
            passport: save.traveler.passport,
            passportConsent: consent,
          }
        : {
            ...save.traveler,
            id: existing?.id ?? nextTravelerId(travelers),
            dateOfBirth:
              save.traveler.dateOfBirth ?? existing?.dateOfBirth ?? null,
            gender: save.traveler.gender ?? existing?.gender ?? null,
            nationality:
              save.traveler.nationality ?? existing?.nationality ?? null,
            email: save.traveler.email ?? existing?.email ?? null,
            phone: save.traveler.phone ?? existing?.phone ?? null,
            passport: existing?.passport ?? null,
            consent,
            passportConsent: existing?.passportConsent ?? null,
          };
    writeTravelers(
      options.home,
      existing == null
        ? [...travelers, traveler]
        : travelers.map((item) => (item.id === existing.id ? traveler : item))
    );
    return traveler;
  };

  const save = (params: Record<string, unknown>) => {
    const requestId = optional(params.request_id, 12);
    if (requestId != null) {
      const request = pending.get(requestId);
      if (request == null)
        return toolText(
          `Not saved: no open question ${requestId}. Call traveler save with the details to ask again.`,
          true
        );
      const answer = answerAfter(request.afterSeq);
      if (answer == null && lastSeq() > request.afterSeq) {
        pending.delete(requestId);
        return toolText(
          "Not saved: the user's answer is too far back to read. Ask again with save.",
          true
        );
      }
      if (answer == null)
        return toolText(
          "The user has not answered yet. Wait for their reply, then call this again.",
          true
        );
      pending.delete(requestId);
      if (!isAffirmative(answer.text))
        return toolText(
          "Not saved: the user's answer was not a yes. Do not ask again unless they bring it up.",
          true
        );
      const saved = commit(request, answer);
      if (!("id" in saved)) return saved;
      // The passport is its own question, answered by a later message.
      if (request.kind === "details" && request.passport != null)
        return toolText(
          `Saved ${describe(saved)}. ` +
            ask({
              kind: "passport",
              traveler: { ...saved, passport: request.passport },
              passport: null,
            })
        );
      return toolText(`Saved ${describe(saved)}.`);
    }

    const name = optional(params.name);
    if (name == null)
      return toolText("Not saved: name (as on the ID) is required.", true);
    const dateOfBirth = optional(params.date_of_birth, 10);
    if (dateOfBirth != null && !ISO_DATE.test(dateOfBirth))
      return toolText("Not saved: date_of_birth is YYYY-MM-DD.", true);
    const passportNumber = optional(params.passport_number, 20);
    const passportExpiry = optional(params.passport_expiry, 10);
    const passportCountry = optional(params.passport_country, 60);
    if (
      passportNumber == null &&
      (passportExpiry != null || passportCountry != null)
    )
      return toolText(
        "Not saved: passport_number is required with the passport's other details.",
        true
      );
    if (passportExpiry != null && !ISO_DATE.test(passportExpiry))
      return toolText("Not saved: passport_expiry is YYYY-MM-DD.", true);
    const id = optional(params.id, 12);
    const travelers = readTravelers(options.home);
    const existing =
      id != null ? travelers.find((item) => item.id === id) : undefined;
    if (id != null && existing == null)
      return toolText(`Not saved: no traveler ${id}.`, true);
    const passport =
      passportNumber != null
        ? {
            number: passportNumber,
            expiry: passportExpiry,
            country: passportCountry,
          }
        : null;
    const traveler: Traveler = {
      id: existing?.id ?? "",
      name,
      dateOfBirth,
      gender: optional(params.gender),
      nationality: optional(params.nationality),
      email: optional(params.email),
      phone: optional(params.phone),
      passport: null,
      consent: { quote: "", at: "" },
      passportConsent: null,
    };
    return toolText(ask({ kind: "details", traveler, passport }));
  };

  const forget = (params: Record<string, unknown>) => {
    const travelers = readTravelers(options.home);
    if (params.all === true) {
      writeTravelers(options.home, []);
      return toolText(`Forgot all ${travelers.length} saved travelers.`);
    }
    const id = optional(params.id, 12);
    const traveler = travelers.find((item) => item.id === id);
    if (traveler == null)
      return toolText(
        "Name the traveler's id (traveler get lists them), or pass all: true.",
        true
      );
    if (params.field === "passport") {
      writeTravelers(
        options.home,
        travelers.map((item) =>
          item.id === traveler.id
            ? { ...item, passport: null, passportConsent: null }
            : item
        )
      );
      return toolText(`Forgot ${traveler.name}'s passport.`);
    }
    writeTravelers(
      options.home,
      travelers.filter((item) => item.id !== traveler.id)
    );
    return toolText(`Forgot ${traveler.name}.`);
  };

  return {
    name: TRAVELER_TOOL_NAME,
    label: TRAVELER_TOOL_NAME,
    description: [
      "The user's saved travelers for booking forms (name as on ID, date of birth, gender,",
      "nationality, email, phone, and a passport when they agreed to keep it).",
      '- "get": before asking for traveler details. Confirm saved ones in one line instead of',
      "  asking again. A passport number is never shown: give the browser's task the traveler",
      "  id and it types the number itself.",
      '- "save": with the details, it does not save yet: it returns the exact question to send and',
      "  a request_id. After the user's next message, call save with only that request_id: it",
      "  saves on a yes. A passport given with the details is asked about separately next.",
      "  Pass id to update a saved traveler.",
      '- "forget": id (field: "passport" to drop only the passport), or all: true.',
      "Never save a card number, password or code here.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "save", "forget"] },
        id: { type: "string", description: "A saved traveler's id, e.g. t1" },
        name: { type: "string", description: "Full name as on the ID" },
        date_of_birth: { type: "string", description: "YYYY-MM-DD" },
        gender: { type: "string" },
        nationality: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        passport_number: { type: "string" },
        passport_expiry: { type: "string", description: "YYYY-MM-DD" },
        passport_country: { type: "string", description: "Issuing country" },
        request_id: {
          type: "string",
          description: "The question save returned, once the user answered it",
        },
        field: {
          type: "string",
          enum: ["passport"],
          description: "forget: only this part",
        },
        all: { type: "boolean", description: "forget: every traveler" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      switch (params.action) {
        case "get":
          return get();
        case "save":
          return save(params);
        case "forget":
          return forget(params);
        default:
          return toolText('action is "get", "save" or "forget".', true);
      }
    },
  };
}
