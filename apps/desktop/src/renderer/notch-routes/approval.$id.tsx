import { createFileRoute } from "@tanstack/react-router";

import { PermissionList } from "#renderer/features/chat/kit/permissions/permission-list";
import { ConnectorAskView } from "#renderer/features/notch";
import { useNotch } from "#renderer/notch-context";
const Approval = () => {
  const context = useNotch();
  const id = context.presentation.sessionId;
  if (!id) return null;
  if (context.presentation.attention?.kind === "connector-ask")
    return <ConnectorAskView />;
  return (
    <PermissionList
      runtime={context.chat}
      threadId={id}
      variant="notch"
      limit={1}
      maxHeight={
        context.layout.maxShape.height -
        Math.max(context.layout.notch?.height ?? 32, 32) -
        18
      }
      focused={context.focused}
      onHaptic={(key) =>
        void context.transport.client.notch.haptic({
          pattern: "alignment",
          key,
        })
      }
      onReview={context.open}
      onSnooze={context.snooze}
    />
  );
};
export const Route = createFileRoute("/approval/$id")({ component: Approval });
