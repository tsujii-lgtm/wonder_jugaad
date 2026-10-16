// claude.ai のカスタムコネクタから使うための入口（Streamable HTTP, ステートレス）
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bootstrap } from "./bootstrap.js";
import { createServer } from "./server.js";

const { config, operations, extra } = await bootstrap();
const accessToken = process.env.MCP_ACCESS_TOKEN;
if (!accessToken && process.env.MCP_ALLOW_NO_AUTH !== "true") {
  // ジュガールのデータを誰でも読める状態で公開しないよう、既定では起動を止める
  console.error("[jugaad-mcp] MCP_ACCESS_TOKEN を設定してください（URL に含める秘密の文字列）");
  process.exit(1);
}

function tokenMatches(given: string | undefined): boolean {
  if (!accessToken) return true;
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(accessToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

const app = express();
app.use(express.json({ limit: "4mb" }));
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// claude.ai のカスタムコネクタは任意ヘッダを送れないため、URL パスに秘密の文字列を含める。
// Authorization: Bearer でも受け付ける（Claude Code などヘッダを送れるクライアント用）。
app.all(["/mcp", "/mcp/:token"], async (req, res) => {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const pathToken = typeof req.params.token === "string" ? req.params.token : undefined;
  if (!tokenMatches(pathToken ?? bearer)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).set("Allow", "POST").json({ error: "method not allowed" });
    return;
  }
  const server = createServer(config, operations, extra);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.error(`[jugaad-mcp] listening on :${port}`));
