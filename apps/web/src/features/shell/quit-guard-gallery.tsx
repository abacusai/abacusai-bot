import type { QuitGuardWork } from "@abacus-ai/contract/contract/system";
import { generateSessionTitle } from "@abacus-ai/contract/transcript/session-title";

import { QuitGuardQuestion } from "./quit-guard";

/** How many chats run under the gallery's quit question. */
export const QUIT_GUARD_GALLERY_COUNTS = ["1", "3", "5"] as const;
export type QuitGuardGalleryCount = (typeof QUIT_GUARD_GALLERY_COUNTS)[number];

/** Opening messages as people type them, named the way main names a chat. */
const OPENING_MESSAGES = [
  "Build a modern, full-stack web application called **TaskFlow Pro** with a dashboard, auth and a REST API",
  "## Refactor `C:\\Users\\me\\Projects\\invoice-app\\src\\components\\InvoiceTableWithFilters.tsx`",
  "Summarise [the quarterly report](https://example.com/reports/q3) for the team",
  "> Write a short reply to the landlord about the broken heating",
  "Compare deepseek-v4-flash-instruct-preview and kimi-k2.7-code-preview-latest on my test suite",
];

/** The quit question with 1, 3 or 5 chats running, for the gallery and its screenshots. */
export const QuitGuardGallery = ({
  count,
}: {
  count: QuitGuardGalleryCount;
}) => {
  const work: QuitGuardWork[] = OPENING_MESSAGES.slice(0, Number(count)).map(
    (message, index) => ({
      sessionId: `gallery-${index}`,
      label: generateSessionTitle(message),
    })
  );
  return <QuitGuardQuestion open work={work} onAnswer={() => undefined} />;
};
