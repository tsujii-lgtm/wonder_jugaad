// Claude Desktop / Claude Code からローカルで使うための入口
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap } from "./bootstrap.js";
import { createServer } from "./server.js";

const { config, operations, extra } = await bootstrap();
await createServer(config, operations, extra).connect(new StdioServerTransport());
