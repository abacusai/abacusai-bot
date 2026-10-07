/**
 * The browser app's way to the apps server's sign-in page, returning here
 * after: the address is absolute (the page ignores a relative one) and names
 * the bot's browser app.
 */
export const webSignInHref = (): string =>
  `/chatllm/signin?AbacusAIBotWeb=1&redirectUrl=${encodeURIComponent(
    location.href
  )}`;
