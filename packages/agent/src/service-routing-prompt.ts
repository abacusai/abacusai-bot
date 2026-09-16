/**
 * One line saying which tool a kind of task belongs to. Without it github.com
 * reads as a website and a pull-request question goes to the browser, whose
 * tool text never mentions connectors. GitHub is `gh` in bash on the user's
 * own token (github-prompt.ts), never a platform connector. Static, so it
 * costs the prompt cache nothing.
 */
export const serviceRoutingPrompt = (): string =>
  "Route by service, not by website: repositories, pull requests, commits " +
  "and issues → `gh` and git in bash (a token on the GitHub connector card " +
  "authenticates them; without one, ask the user to add it there); mail → " +
  "Gmail; events and availability → Google Calendar; files → Google Drive. " +
  "If a connector is not attached, connect it with connect_connector rather " +
  "than driving the service's website in the browser; the browser is for " +
  "sites that have no connector.";
