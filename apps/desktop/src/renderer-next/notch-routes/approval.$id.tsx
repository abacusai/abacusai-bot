import { createFileRoute } from "@tanstack/react-router";

import { PermissionList } from "#next/features/chat";
import { CompactView } from "#next/features/notch";
import { useNotch } from "#next/notch-context";
const Approval = () => {
  const context = useNotch();
  const id = context.presentation.sessionId;
  if (!id) return null;
  if (context.presentation.attention?.kind === "connector-ask")
    return <CompactView />;
  return (
    <PermissionList
      runtime={context.chat}
      threadId={id}
      variant="notch"
      limit={1}
      maxHeight={context.layout.maxShape.height}
      onReview={context.open}
      onSnooze={context.snooze}
    />
  );
};
export const Route = createFileRoute("/approval/$id")({ component: Approval });
