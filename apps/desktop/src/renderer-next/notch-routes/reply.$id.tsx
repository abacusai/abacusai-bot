import { createFileRoute } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";

import { ReplyView } from "#next/features/notch";
import { useNotch } from "#next/notch-context";
const Reply = () => {
  const { chat, presentation } = useNotch();
  const id = presentation.sessionId ?? "";
  const session = chat.session(id);
  const messages = useStore(session.hostStore, (state) => state.messages);
  const message = messages.findLast((m) => m.role === "assistant");
  const text =
    message?.parts
      .flatMap((part) =>
        part.type === "text" ? [(part as { content: string }).content] : []
      )
      .join(" ") ?? "";
  return (
    <ReplyView key={id} text={text} submit={(text) => session.submit(text)} />
  );
};
export const Route = createFileRoute("/reply/$id")({ component: Reply });
