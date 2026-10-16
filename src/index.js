// ジュガール（Jugaad）を読むためのリモート MCP サーバー (Cloudflare Workers 用)。
// claude.ai の「カスタムコネクタ」に https://<worker>/mcp/<MCP_SECRET> を登録して使う。
// 既定は読み取り専用。

import { jugaadTools } from "./jugaad.js";

const SERVER_INFO = { name: "wonder-jugaad-mcp", version: "0.2.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 0) return text("wonder-jugaad-mcp is running", 200);
    if (parts[0] !== "mcp" || parts.length !== 2 || !safeEqual(parts[1], env.MCP_SECRET || "")) {
      return text("Not found", 404);
    }
    if (!env.MCP_SECRET || env.MCP_SECRET.length < 16) {
      return text("MCP_SECRET が未設定か短すぎます", 500);
    }
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return text("Method not allowed", 405, { Allow: "POST" });

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    const tools = await buildTools(env);
    if (Array.isArray(payload)) {
      const results = (await Promise.all(payload.map((m) => handleMessage(m, tools)))).filter(Boolean);
      return results.length ? json(results) : new Response(null, { status: 202 });
    }
    const result = await handleMessage(payload, tools);
    return result ? json(result) : new Response(null, { status: 202 });
  },
};

// 有効なツールをまとめる。認証情報が設定されたものだけが出る。
export async function buildTools(env, fetchImpl) {
  const providers = (await Promise.all([jugaadTools(env, fetchImpl)])).filter(Boolean);
  return {
    definitions: providers.flatMap((p) => p.definitions),
    async call(name, args) {
      for (const p of providers) {
        if (!p.definitions.some((d) => d.name === name)) continue;
        return p.call(name, args);
      }
      return undefined;
    },
  };
}

export async function handleMessage(msg, tools) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && "id" in msg ? rpcError(msg.id, -32600, "Invalid Request") : null;
  }
  if (!("id" in msg)) return null; // 通知には返事しない

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "ジュガール（ワークフロー・経費精算）の API を読むためのツール。まず jugaad_list_endpoints で使えるエンドポイントを確認する。",
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: tools.definitions });
    case "tools/call":
      return rpcResult(msg.id, await callTool(msg.params?.name, msg.params?.arguments || {}, tools));
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function callTool(name, args, tools) {
  try {
    const out = await tools.call(name, args);
    if (out === undefined) return fail(`不明なツールです: ${name}`);
    return ok(out);
  } catch (e) {
    return fail(e.message || String(e));
  }
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
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
