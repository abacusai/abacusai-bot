/**
 * The hosted web app's entry (web.html). The browser's session decides
 * whether the app starts at all: a signed-out tab goes to the website's
 * sign-in and comes back, and a session the server refuses gets a plain
 * page instead of a socket that would only close. Then the same boot as the
 * desktop (main.tsx), over a WebSocket.
 */
import {
  checkWebSession,
  installViewportTracking,
  isRunnerView,
  signInUrl,
  webAppUrl,
  type WebSession,
} from "#renderer/lib/web-app";

/** No i18n or styles yet: a few words and a link, in the page's own font. */
const renderGate = (title: string, body: string, link?: [string, string]) => {
  const root = document.getElementById("root");
  if (root == null) return;
  const box = document.createElement("main");
  box.style.cssText =
    "max-width:28rem;margin:20vh auto 0;padding:0 1.5rem;font:15px/1.5 system-ui,sans-serif";
  const heading = document.createElement("h1");
  heading.style.cssText = "font-size:1.25rem;margin:0 0 .5rem";
  heading.textContent = title;
  const text = document.createElement("p");
  text.style.margin = "0 0 1rem";
  text.textContent = body;
  box.append(heading, text);
  if (link != null) {
    const anchor = document.createElement("a");
    anchor.href = link[1];
    anchor.textContent = link[0];
    box.append(anchor);
  }
  root.replaceChildren(box);
};

const GATES: Record<
  Exclude<WebSession, "signed-in" | "signed-out">,
  () => void
> = {
  "not-allowed": () =>
    renderGate(
      "AbacusAI Bot on the web isn't on for your account yet",
      "You can use AbacusAI Bot in the desktop app in the meantime.",
      ["Get the desktop app", "https://bot.abacus.ai"]
    ),
  "no-runner": () =>
    renderGate(
      "Open AbacusAI Bot on your computer",
      "Coding runs on your own computer. Open the desktop app, turn on Settings > Use from the web, and this page connects.",
      ["Back to your bots", webAppUrl()]
    ),
  down: () =>
    renderGate(
      "AbacusAI Bot can't be reached right now",
      "Try again in a moment.",
      ["Try again", window.location.href]
    ),
};

const session = await checkWebSession({ runner: isRunnerView() });
if (session === "signed-out") {
  window.location.replace(signInUrl());
} else if (session === "signed-in") {
  installViewportTracking();
  await import("./main");
} else {
  GATES[session]();
}
