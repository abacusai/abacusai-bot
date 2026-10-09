/**
 * The browser app's way to the apps server's sign-in page, returning here
 * after: the address is absolute (the page ignores a relative one) and names
 * the bot's browser app. It lives under /bot/link/, which a phone opens in
 * the browser; a /chatllm/ link opens the ChatLLM app instead.
 */
export const webSignInHref = (): string =>
  `/bot/link/signin?AbacusAIBotWeb=1&redirectUrl=${encodeURIComponent(
    location.href
  )}`;
