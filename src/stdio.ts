// Claude Desktop / Claude Code からローカルで使うための入口
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap } from "./bootstrap.js";
import { createServer } from "./server.js";

const { config, operations } = await bootstrap();
await createServer(config, operations).connect(new StdioServerTransport());
