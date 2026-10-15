import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callJugaad } from "./client.js";
import type { Config } from "./config.js";
import { buildRequest, type Operation } from "./openapi.js";

const GENERIC_TOOL = "jugaad_api_request";
const LIST_TOOL = "jugaad_list_endpoints";

function result(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
    isError,
  };
}

export function createServer(config: Config, operations: Operation[]): Server {
  const server = new Server({ name: "jugaad-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
  const byName = new Map(operations.map((op) => [op.toolName, op]));

  const allowedMethods = config.allowWrite ? ["GET", "POST", "PUT", "PATCH", "DELETE"] : ["GET"];
  const genericTools = [
    {
      name: GENERIC_TOOL,
      description:
        "ジュガール API を直接呼び出す。仕様にない操作や、自動生成ツールで足りないときに使う。" +
        (config.allowWrite ? "" : "（読み取り専用モード: GET のみ）"),
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", enum: allowedMethods },
          path: { type: "string", description: "例: /api/v1/applications" },
          query: { type: "object", description: "クエリパラメータ" },
          body: { description: "JSON ボディ" },
        },
        required: ["method", "path"],
      },
    },
    {
      name: LIST_TOOL,
      description: "読み込んだ API 仕様に含まれるエンドポイントの一覧を返す。",
      inputSchema: { type: "object", properties: { filter: { type: "string", description: "パスや説明の部分一致" } } },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...operations.map((op) => ({ name: op.toolName, description: op.description, inputSchema: op.inputSchema })),
      ...genericTools,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, any>;
    try {
      if (name === LIST_TOOL) {
        const f = String(args.filter ?? "").toLowerCase();
        const rows = operations
          .filter((op) => !f || `${op.path} ${op.description}`.toLowerCase().includes(f))
          .map((op) => `${op.method} ${op.path}  →  ${op.toolName}`);
        return result(rows.length ? rows.join("\n") : "該当なし（仕様未読み込みの場合は JUGAAD_OPENAPI を設定してください）");
      }
      if (name === GENERIC_TOOL) {
        const method = String(args.method ?? "GET").toUpperCase();
        if (!allowedMethods.includes(method)) {
          return result(`${method} は許可されていません。書き込みを許可するには JUGAAD_ALLOW_WRITE=true を設定してください。`, true);
        }
        const res = await callJugaad(config, { method, path: String(args.path), query: args.query, body: args.body });
        return result(res, !res.ok);
      }
      const op = byName.get(name);
      if (!op) return result(`不明なツール: ${name}`, true);
      const res = await callJugaad(config, buildRequest(op, args));
      return result(res, !res.ok);
    } catch (err) {
      return result(`呼び出しに失敗しました: ${(err as Error).message}`, true);
    }
  });

  return server;
}
