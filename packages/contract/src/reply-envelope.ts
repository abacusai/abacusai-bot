const REPLY_TAG = /<reply>([\s\S]*?)<\/reply>/gi;
const THINKING_BLOCK =
  /<(?:thinking|think|reasoning)>[\s\S]*?<\/(?:thinking|think|reasoning)>/gi;

export const outgoingWords = (text: string): string => {
  const wrapped = [...text.matchAll(REPLY_TAG)];
  const last = wrapped.at(-1)?.[1];
  const chosen = last != null ? last : text.replace(THINKING_BLOCK, "");
  return chosen.trim();
};

/** The last complete <reply> block in `text`, or null when there is none. */
export const lastTaggedReply = (text: string): string | null => {
  const wrapped = [...text.matchAll(REPLY_TAG)];
  const last = wrapped.at(-1)?.[1];
  return last == null ? null : last.trim();
};
