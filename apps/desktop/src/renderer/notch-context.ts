import type { QueryClient } from "@tanstack/react-query";
import { createContext, use } from "react";

import type { Db } from "#renderer/data/db";
import type { Transport } from "#renderer/data/transport";
import type { ChatRuntime } from "#renderer/features/chat";
import type { NotchPresentation } from "#renderer/features/notch";
import type { NotchLayout } from "#shared/contract";
export interface NotchRouterContext {
  transport: Transport;
  db: Db;
  queryClient: QueryClient;
  chat: ChatRuntime;
  layout: NotchLayout;
}
export interface NotchViewContext extends NotchRouterContext {
  presentation: NotchPresentation;
  open(): void;
  snooze(): void;
  focused: boolean;
  message(botId: string, call?: boolean): Promise<void>;
  endCall(text?: string, error?: "microphone" | "transcription"): void;
  dictationError?: "microphone" | "transcription" | null;
}
export const NotchContext = createContext<NotchViewContext | null>(null);
export const useNotch = (): NotchViewContext => {
  const context = use(NotchContext);
  if (!context) throw new Error("Notch context missing");
  return context;
};
