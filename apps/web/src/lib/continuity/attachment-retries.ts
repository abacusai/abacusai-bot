export const attachmentRetries = new Map<string, () => Promise<void>>();

export const releaseAttachments = (threadId: string): void => {
  for (const key of attachmentRetries.keys())
    if (key.startsWith(`${threadId}:`)) attachmentRetries.delete(key);
};
