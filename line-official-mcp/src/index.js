// LINE公式アカウントの数字を読むリモート MCP サーバー (Cloudflare Workers 用)。
// LINE公式アカウントごとに 1 つずつデプロイする（wrangler.toml の [env.emit] など）。
// claude.ai の「カスタムコネクタ」に https://<worker>/mcp/<MCP_SECRET> を登録して使う。読み取り専用。

import { lineTools } from "./line.js";

const SERVER_INFO = { name: "line-official-mcp", version: "0.1.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const account = env.LINE_ACCOUNT_LABEL || "";

    if (parts.length === 0) return text(`line-official-mcp (${account}) is running`, 200);

    const secretOk = env.MCP_SECRET && env.MCP_SECRET.length >= 16;
    if (parts[0] !== "mcp" || parts.length !== 2 || !secretOk || !safeEqual(parts[1], env.MCP_SECRET)) {
      if (parts[0] === "mcp" && !secretOk) return text("MCP_SECRET が未設定か短すぎます", 500);
      return text("Not found", 404);
    }
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return text("Method not allowed", 405, { Allow: "POST" });

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }
    if (Array.isArray(payload)) {
      const results = (await Promise.all(payload.map((m) => handleMessage(m, env, account)))).filter(Boolean);
      return results.length ? json(results) : new Response(null, { status: 202 });
    }
    const result = await handleMessage(payload, env, account);
    return result ? json(result) : new Response(null, { status: 202 });
  },
};

export async function handleMessage(msg, env, account = "") {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && "id" in msg ? rpcError(msg.id, -32600, "Invalid Request") : null;
  }
  if (!("id" in msg)) return null;

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: `LINE公式アカウント「${account || "1つのアカウント"}」の友だち数・ブロック数・属性・配信数をLINE Messaging APIで読むツール（読み取り専用）。日付は日本時間で、前日分は翌日に確定する。友だち追加の経路（どの広告から来たか）はLINEのAPIでは取れないので、UTAGEの流入経路を使う。`,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: lineTools.definitions });
    case "tools/call": {
      try {
        const out = await lineTools.call(env, msg.params?.name, msg.params?.arguments || {});
        if (out === undefined) return rpcResult(msg.id, fail(`不明なツールです: ${msg.params?.name}`));
        return rpcResult(msg.id, ok(out));
      } catch (e) {
        return rpcResult(msg.id, fail(e.message || String(e)));
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (body, status, headers = {}) => new Response(body, { status, headers });
