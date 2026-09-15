import {
  AgentStatus,
  type DesktopCommand,
  type DesktopEvent,
  type PermissionDecision,
  type SkillMetadata,
} from "#shared/agent-types";
import type {
  AgentPermissionResponseRequest,
  AgentQueueMessageRequest,
  AgentRemoveFromQueueRequest,
  AgentUpdateQueueMessageRequest,
  AgentSessionCommandRequest,
  AgentSetModeRequest,
  AgentSetModelRequest,
  AgentSessionSnapshot,
  AgentSwitchConversationRequest,
  SendAgentMessageRequest,
} from "#shared/contracts";

type CliCommandDispatcher = (
  workspaceId: string,
  sessionId: string,
  command: DesktopCommand
) => boolean;

/**
 * Out-of-band consequences of one raw NDJSON message. The message itself is
 * broadcast verbatim on `local-cli-ndjson`; this only carries what main owns:
 * snapshot fields, built-in browser auto-approval, and the skills list.
 */
type CommunicationUpdate = {
  statePatch?: Partial<AgentSessionSnapshot>;
  autoAllowDecision?: { permissionId: string; decision: PermissionDecision };
  skillsLoaded?: SkillMetadata[];
};

const BROWSER_AUTO_ALLOW_TOOLS = new Set([
  "browser_navigate",
  "browser_snapshot",
]);

const toCommandRequest = (
  request: AgentSessionCommandRequest
): { workspaceId: string; sessionId: string } => ({
  workspaceId: request.workspaceId,
  sessionId: request.sessionId,
});

export class AgentCommunicationService {
  constructor(private readonly dispatch: CliCommandDispatcher) {}

  sendMessage(request: SendAgentMessageRequest): boolean {
    return this.dispatch(request.workspaceId, request.sessionId, {
      type: "send",
      message: request.message,
      conversationId: request.conversationId,
      activeSkills: request.activeSkills,
    });
  }

  setMode(request: AgentSetModeRequest): void {
    this.dispatch(request.workspaceId, request.sessionId, {
      type: "set_mode",
      mode: request.mode,
    });
  }

  setModel(request: AgentSetModelRequest): void {
    this.dispatch(request.workspaceId, request.sessionId, {
      type: "set_model",
      model: request.model,
    });
  }

  stopTurn(request: AgentSessionCommandRequest): void {
    const target = toCommandRequest(request);
    this.dispatch(target.workspaceId, target.sessionId, { type: "stop" });
  }

  resetConversation(request: AgentSessionCommandRequest): void {
    const target = toCommandRequest(request);
    this.dispatch(target.workspaceId, target.sessionId, {
      type: "reset_conversation",
    });
  }

  switchConversation(request: AgentSwitchConversationRequest): void {
    this.dispatch(request.workspaceId, request.sessionId, {
      type: "switch_conversation",
      conversationId: request.conversationId,
    });
  }

  respondPermission(request: AgentPermissionResponseRequest): void {
    this.dispatch(request.workspaceId, request.sessionId, {
      type: "permission_response",
      permissionId: request.permissionId,
      decision: request.decision as any,
    });
  }

  listSkills(request: AgentSessionCommandRequest): void {
    const target = toCommandRequest(request);
    this.dispatch(target.workspaceId, target.sessionId, {
      type: "list_skills",
    });
  }

  enqueue(request: AgentQueueMessageRequest): void {
    this.dispatch(request.workspaceId, request.sessionId, {
      type: "enqueue",
      message: request.message,
      hidden: request.hidden ?? false,
    });
  }

  dequeue(request: AgentSessionCommandRequest): void {
    const target = toCommandRequest(request);
    this.dispatch(target.workspaceId, target.sessionId, { type: "dequeue" });
  }

  getQueue(request: AgentSessionCommandRequest): void {
    const target = toCommandRequest(request);
    this.dispatch(target.workspaceId, target.sessionId, { type: "get_queue" });
  }

  clearQueue(request: AgentSessionCommandRequest): void {
    const target = toCommandRequest(request);
    this.dispatch(target.workspaceId, target.sessionId, {
      type: "clear_queue",
    });
  }

  removeQueueItem(request: AgentRemoveFromQueueRequest): void {
    this.dispatch(request.workspaceId, request.sessionId, {
      type: "remove_from_queue",
      index: request.index,
    });
  }

  updateQueueItem(request: AgentUpdateQueueMessageRequest): void {
    this.dispatch(request.workspaceId, request.sessionId, {
      type: "update_queue_item",
      index: request.index,
      message: request.message,
    });
  }

  handleDesktopEvent(event: DesktopEvent): CommunicationUpdate {
    if (event.type === "permission_needed") {
      const toolName = event.request.tool.name;
      if (BROWSER_AUTO_ALLOW_TOOLS.has(toolName)) {
        return {
          autoAllowDecision: {
            permissionId: event.permissionId,
            decision: "accept",
          },
        };
      }
      return {
        statePatch: { agentStatus: AgentStatus.WaitingForToolPermission },
      };
    }

    if (event.type === "skills_loaded") {
      return { skillsLoaded: event.skills };
    }

    if (event.type !== "event") {
      return {};
    }

    const statePatch: Partial<AgentSessionSnapshot> = {};
    if (event.event.type === "status_changed") {
      statePatch.agentStatus = event.event.status;
    }
    if (event.event.type === "mode_changed") {
      statePatch.mode = event.event.mode;
    }
    if (event.event.type === "model_changed") {
      statePatch.model = event.event.model;
    }
    if (event.event.type === "sandbox_status") {
      statePatch.sandbox = {
        active: event.event.active,
        reason: event.event.reason,
      };
    }
    if (event.event.type === "turn_complete") {
      statePatch.agentStatus = AgentStatus.Idle;
    }
    if (event.event.type === "error") {
      statePatch.agentStatus = AgentStatus.Idle;
    }

    return Object.keys(statePatch).length > 0 ? { statePatch } : {};
  }
}
