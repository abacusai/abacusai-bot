import type { ReactNode } from "react";

// AbacusAI Bot's own WhatsApp number is a browser feature; the desktop app links WhatsApp itself.
export const WhatsAppIntro = () => null;

/** The desktop pairs WhatsApp from the card's own Connect. */
export const useBotNumberConnect = (
  _onConnected: (() => void) | undefined
): { connect(): void; dialog: ReactNode } | null => null;
