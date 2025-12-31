
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
const server = new McpServer({ name: "test", version: "1.0" });
console.log("Has registerTool:", typeof (server as any).registerTool);
console.log("Has tool:", typeof server.tool);
