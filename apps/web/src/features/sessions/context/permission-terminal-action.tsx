import type { PermissionRequest } from "@abacus-ai/contract/agent-types";
import { useSelector } from "@tanstack/react-store";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";

import { panelTabsStore } from "../dock/panel-tabs-store";

export const SessionPermissionAction = ({
  request,
  conversationKey,
  open,
}: {
  request: PermissionRequest;
  conversationKey: string;
  open(tab: string): void;
}) => {
  const { t } = useTranslation();
  const tabs = useSelector(panelTabsStore, (s) => s[conversationKey]?.tabs);
  if (request.type !== "sandbox_denied" && request.type !== "network_host")
    return null;
  const id =
    request.tool.input.terminalId ??
    request.tool.input.terminal_id ??
    request.tool.id;
  const ref = typeof id === "string" ? `terminal:${id}` : null;
  if (!ref || !tabs?.some((tab) => tab.ref === ref)) return null;
  return (
    <Button variant="ghost" size="sm" onClick={() => open(ref)}>
      {t("sessions.permission.openTerminal")}
    </Button>
  );
};
