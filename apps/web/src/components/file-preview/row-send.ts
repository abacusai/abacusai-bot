/**
 * Sending a message as the user from a file row (a deck's "Try another look"),
 * provided by the chat the row sits in. Outside a chat there is none, and the
 * row offers nothing that needs it.
 */
import { createContext, useContext } from "react";

export type RowSend = (
  text: string,
  handlers: { accepted(): void; failed(): void }
) => void;

export const RowSendContext = createContext<RowSend | null>(null);

export const useRowSend = (): RowSend | null => useContext(RowSendContext);
