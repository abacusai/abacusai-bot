/** Stable run codes only; agent messages are never parsed. Returns an i18n key. */
export const runErrorCopy = (code: string | undefined): string => {
  switch (code) {
    case "rate_limit":
    case "rate_limited":
    case "rate_limit_exceeded":
      return "chat.error.rateLimited";
    case "agent_exit":
    case "agent_crashed":
      return "chat.error.crashed";
    default:
      return "notch.failed.title";
  }
};
