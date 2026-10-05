import {
  draftConversationKey,
  sessionConversationKey,
} from "@abacus-ai/contract/conversation-scope";

// Fixtures derive structural inputs from the contract; semantic ids address absent rows.
export const procedureInput = (
  schema: any,
  home: string,
  key = ""
): unknown => {
  if (!schema) return undefined;
  switch (schema.type) {
    case "optional":
    case "undefinedable":
      return undefined;
    case "nullable":
    case "nullish":
      return null;
    case "object":
    case "strict_object":
    case "loose_object":
      return Object.fromEntries(
        Object.entries(schema.entries).map(([name, value]) => [
          name,
          procedureInput(value, home, name),
        ])
      );
    case "union":
    case "variant":
      return procedureInput(schema.options[0], home, key);
    case "picklist":
      return schema.options[0];
    case "literal":
      return schema.literal;
    case "boolean":
      return false;
    case "number":
      return 1;
    case "array":
      return Array.from(
        {
          length:
            schema.pipe?.find((part: any) => part.type === "min_length")
              ?.requirement ?? 0,
        },
        () => procedureInput(schema.item, home, key)
      );
    case "record":
      return {};
    case "string": {
      if (/url/i.test(key)) return "https://example.invalid/";
      if (/path|folder|root|directory/i.test(key)) return home;
      if (/email/i.test(key)) return "fixture@example.invalid";
      return "fixture";
    }
    case "custom":
      return /draft/i.test(key)
        ? draftConversationKey("fixture")
        : sessionConversationKey("fixture", "fixture");
    default:
      return {};
  }
};
