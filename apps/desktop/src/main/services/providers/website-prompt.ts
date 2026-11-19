/**
 * The website's prompt (contract website-prompt.ts) once the renderer has
 * taken it: run as the first task, or passed over. The platform is told so
 * no other install runs it, and the cached account stops offering it. Fire
 * and forget: a lost ack leaves the prompt on the account, and the renderer's
 * own record still keeps this install from running it twice.
 */
import { forgetWebsitePrompt } from "./abacus";
import { abacusApiCall } from "./abacus-connector-service";

export const takeWebsitePrompt = (): void => {
  forgetWebsitePrompt();
  void abacusApiCall("_ackAbacusbotFirstPrompt", "POST", {}, 10_000).catch(
    () => {}
  );
};
