/**
 * One line saying which tool a kind of task belongs to. Without it github.com
 * reads as a website and a pull-request question goes to the browser, whose
 * tool text never mentions connectors. GitHub is `gh` in bash on the user's
 * own token (github-prompt.ts), asked for with the same Connect button as
 * any connector, never the platform's GitHub App. Static, so it costs the
 * prompt cache nothing.
 */
export const serviceRoutingPrompt = (): string =>
  "Route by service, not by website: repositories, pull requests, commits " +
  "and issues → `gh` and git in bash, authenticated by the user's GitHub " +
  'token (without one, connect_connector "github" puts up the button that ' +
  "takes it); mail → " +
  "Gmail; events and availability → Google Calendar; files → Google Drive. " +
  "If a connector is not attached, connect it with connect_connector rather " +
  "than driving the service's website in the browser; the browser is for " +
  "sites that have no connector.";
