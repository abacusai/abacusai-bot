/**
 * A chat continued from another on a top model (the retry line under a stuck
 * task, or the composer's top-model line) starts from the earlier chat's
 * summary instead of its history: the new model reads a page, not every call
 * of a long chat again, and not the attempts that went wrong word for word.
 * The summary rides hidden on the new chat's first message.
 */
export const continuationNote = (summary: string): string =>
  "This chat continues one of the user's earlier chats in this folder, moved " +
  "here to a stronger model. You do not have its history, only this summary " +
  "of it:\n\n" +
  `${summary.trim()}\n\n` +
  "Work from the summary and the files themselves: open a file again before " +
  "you change it, and do not repeat an approach the summary says did not work. " +
  "Do not mention this note; answer the user's message below.";
