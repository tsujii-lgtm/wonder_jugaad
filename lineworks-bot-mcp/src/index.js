// LINE WORKS の Bot でトークに投稿するリモート MCP サーバー (Cloudflare Workers 用)。
// claude.ai の「カスタムコネクタ」に https://<worker>/mcp/<MCP_SECRET> を登録して使う。
// 送れるのは LW_ALLOWED_CHANNEL_IDS に入れたトークルームだけ。トークの中身は読まない。

import { lineworksTools as lineTools, postText } from "./lineworks.js";

const SERVER_INFO = { name: "lineworks-bot-mcp", version: "0.1.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const account = env.LW_LABEL || "";

    if (parts.length === 0) return text(`lineworks-bot-mcp (${account}) is running`, 200);
    if (parts.length === 1 && parts[0] === "callback") return handleCallback(request, env);

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

// LINE WORKS からBotへのイベント受信口。Developer Console の Callback URL に https://<worker>/callback を入れる。
// Botがトークに招待されたら（joined）、そのトークのIDをトークに書き込む。メッセージの中身は保存しない。
async function handleCallback(request, env) {
  if (request.method !== "POST") return text("Method not allowed", 405, { Allow: "POST" });
  if (!env.LW_BOT_SECRET) return text("LW_BOT_SECRET が未設定です", 500);
  const body = await request.text();
  const sig = request.headers.get("x-works-signature") || "";
  if (!(await verifySignature(env.LW_BOT_SECRET, body, sig))) return text("Bad signature", 401);
  let ev;
  try {
    ev = JSON.parse(body);
  } catch {
    return text("Bad request", 400);
  }
  const channelId = ev?.source?.channelId;
  const said = ev?.type === "message" ? String(ev?.content?.text || "").trim() : "";
  if (channelId && (ev.type === "joined" || said === "トークID")) {
    const allowed = String(env.LW_ALLOWED_CHANNEL_IDS || "").split(",").map((s) => s.trim());
    const note = allowed.includes(channelId)
      ? "このトークには毎朝のお知らせが届く設定になっています。"
      : "このIDを設定に入れると、このトークにお知らせが届くようになります。";
    try {
      await postText(env, channelId, `このトークのID：${channelId}\n${note}`);
    } catch {}
  }
  return new Response(null, { status: 200 });
}

export async function verifySignature(secret, body, sig) {
  if (!sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = btoa(String.fromCharCode(...mac));
  return safeEqual(expected, sig);
}

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
        instructions: `LINE WORKS（${account || "ReSow"}）のBotから、決められたトークルームにテキストを送るツール。送れるのは設定で許したトークルームだけで、トークの中身は読めない。`,
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
