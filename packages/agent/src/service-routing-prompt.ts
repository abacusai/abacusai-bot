/**
 * One line saying which tool a kind of task belongs to. Without it github.com
 * reads as a website and a pull-request question goes to the browser, whose
 * tool text never mentions connectors. Static, so it costs the prompt cache
 * nothing.
 */
export const serviceRoutingPrompt = (): string =>
  "Route by service, not by website: repositories, pull requests, commits " +
  "and issues → the GitHub connector; mail → Gmail; events and availability " +
  "→ Google Calendar; files → Google Drive. If that connector is not " +
  "attached, connect it with connect_connector rather than driving the " +
  "service's website in the browser; the browser is for sites that have no " +
  "connector.";
