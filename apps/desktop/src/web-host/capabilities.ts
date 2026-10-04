/**
 * What the hosted web app can do: bots, chat, memory and platform connectors.
 * Coding (`sessions`, `files`, `terminal`) turns on only while the user's own
 * desktop app is attached as a runner, which does that work on their machine.
 */
import { ALL_CAPABILITIES, type Capabilities } from "#shared/contract";

const OFF: Capabilities = Object.fromEntries(
  Object.keys(ALL_CAPABILITIES).map((name) => [name, false])
) as Capabilities;

export const webCapabilities = ({
  runnerAttached,
}: {
  runnerAttached: boolean;
}): Capabilities => ({
  ...OFF,
  sessions: runnerAttached,
  files: runnerAttached,
  terminal: runnerAttached,
});
