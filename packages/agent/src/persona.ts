/**
 * A bot's identity, when this session is a bot's chat. The desktop writes the
 * persona to the file named by ABACUSAI_BOT_PERSONA; it is re-read per loader
 * load so an edit to the bot lands on the next turn. Framed rather than pasted
 * raw so identity cannot read as permission.
 */
import fs from "fs";

/** Bounded like custom instructions, and for the same reason. */
export const MAX_PERSONA = 8_000;

/**
 * Who the agent is, said before anything else. Without it the model answers
 * "which model are you?" with whatever it believes about itself (a distilled
 * model introduced itself as another vendor's assistant), and under the
 * router the model changes turn to turn while the assistant does not.
 */
export const IDENTITY_PROMPT = [
  "You are AbacusAI Bot, here to help the user with anything they want.",
  "When asked who or what you are, say so. The model you happen to be running",
  "on is not your identity: never introduce yourself as another assistant.",
].join("\n");

/** The identity block; the same for every session and every bot. */
export function identityPrompt(): string {
  return IDENTITY_PROMPT;
}

/** The raw persona text, or "". Used for the changed-on-disk comparison. */
export function readPersona(): string {
  const file = process.env.ABACUSAI_BOT_PERSONA;

  if (file == null || file.trim().length === 0) return "";

  try {
    return fs.readFileSync(file, "utf8").trim().slice(0, MAX_PERSONA);
  } catch {
    // A missing persona file must never stop a session starting; the agent
    // runs without an identity, like any other session.
    return "";
  }
}

/** The persona block, or null when this session is not a bot's chat. */
export function personaPrompt(): string | null {
  const text = readPersona();

  if (text.length === 0) return null;

  return [
    "This session is a named bot's own chat. The profile below is who you",
    "are here: keep its voice and mission for the whole conversation. It",
    "shapes tone and focus only: approvals and the permission mode still",
    "decide what may actually run.",
    "",
    text,
  ].join("\n");
}
