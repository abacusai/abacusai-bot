// Frozen legacy tool-result shapes, C5 d8bccf17.
export type V1ToolResultData =
  | {
      type: "read";
      content: string;
      startLine?: number;
      lineCount: number;
      isUploadedDocument?: boolean;
      filePath?: string;
      filename?: string;
      size?: number;
      mimeType?: string;
    }
  | {
      type: "file_mutation";
      originalContent?: string;
      finalContent?: string;
      diff?: string;
      isNewFile?: boolean;
      additions?: number;
      deletions?: number;
    }
  | {
      type: "bash";
      command: string;
      output: string;
      exitCode?: number;
      duration?: number;
      background?: boolean;
      terminated?: boolean;
      timedOut?: boolean;
    }
  | { type: "mcp"; content: string; isError: boolean }
  | { type: "generic"; output: string };

export interface V1ToolRejection {
  reason: "rejected" | "interrupted" | "sibling_failed";
  userMessage?: string;
}

export interface V1ToolResult {
  toolCallId: string;
  output: string;
  error?: string;
  rejection?: V1ToolRejection;
  data?: V1ToolResultData;
}
