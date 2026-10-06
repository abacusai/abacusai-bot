/** The pi tool shape the phone loop's own tools share, and their result helper. */
export interface PhoneToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

export const toolText = (body: string, isError = false) => ({
  content: [{ type: "text" as const, text: body }],
  details: null,
  ...(isError ? { isError: true } : {}),
});

/** A string parameter, or "" when the model sent something else. */
export const stringParam = (value: unknown): string =>
  typeof value === "string" ? value : "";
