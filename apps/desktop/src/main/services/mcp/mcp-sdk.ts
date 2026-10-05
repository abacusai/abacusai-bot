/**
 * The parts of the MCP SDK the built-in servers use, behind one module so
 * mcp-http-server.ts can load them with a single dynamic import: the SDK, its
 * zod schemas and Ajv then sit in their own chunk under dist/main/assets and
 * cost the main process nothing until the first MCP server starts.
 */
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

export { Server } from "@modelcontextprotocol/sdk/server/index.js";
export { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
export {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Only consulted for elicitation, which these servers never send, but the SDK
 * server builds one per instance unless given one, and an Ajv instance per
 * request is wasted work.
 */
export const validator = new AjvJsonSchemaValidator();
