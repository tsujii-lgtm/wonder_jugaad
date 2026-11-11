// Google ドライブ・スプレッドシートを読むリモート MCP サーバー (Cloudflare Workers 用)。
// Google アカウントごとに 1 つずつデプロイする（wrangler.toml の [env.resow] など）。
// claude.ai の「カスタムコネクタ」に https://<worker>/mcp/<MCP_SECRET> を登録して使う。
// 既定は読み取り専用。ALLOW_SHEETS_WRITE = "true" の環境だけスプレッドシートに書き込める。

import { googleTools, scopesFor, sheetsWriteEnabled } from "./google.js";

const SERVER_INFO = { name: "google-drive-mcp", version: "0.1.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const account = env.GOOGLE_ACCOUNT || "";

    if (parts.length === 0) return text(`google-drive-mcp (${account}) is running`, 200);

    const secretOk = env.MCP_SECRET && env.MCP_SECRET.length >= 16;

    // 初回だけ: Google にログインしてリフレッシュトークンを取る
    if (parts[0] === "auth" && parts.length === 2) {
      if (!secretOk || !safeEqual(parts[1], env.MCP_SECRET)) return text("Not found", 404);
      if (!env.GOOGLE_CLIENT_ID) return text("GOOGLE_CLIENT_ID が未設定です", 500);
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: `${url.origin}/oauth/callback`,
        response_type: "code",
        scope: scopesFor(env),
        access_type: "offline",
        prompt: "consent",
        state: await stateFor(env.MCP_SECRET),
        ...(account ? { login_hint: account } : {}),
      }).toString();
      return Response.redirect(auth.toString(), 302);
    }
    if (parts[0] === "oauth" && parts[1] === "callback") {
      return oauthCallback(url, env);
    }

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

    const tools = (await googleTools(env)) || { definitions: [], call: async () => undefined };
    if (Array.isArray(payload)) {
      const results = (await Promise.all(payload.map((m) => handleMessage(m, tools, account, sheetsWriteEnabled(env))))).filter(Boolean);
      return results.length ? json(results) : new Response(null, { status: 202 });
    }
    const result = await handleMessage(payload, tools, account, sheetsWriteEnabled(env));
    return result ? json(result) : new Response(null, { status: 202 });
  },
};

async function oauthCallback(url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  if (url.searchParams.get("error")) return html(`ログインが中止されました: ${escape(url.searchParams.get("error"))}`, 400);
  if (!code || !env.MCP_SECRET || !safeEqual(state, await stateFor(env.MCP_SECRET))) return text("Not found", 404);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/oauth/callback`,
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    return html(`トークンを取れませんでした（${res.status} ${escape(body.error || "")} ${escape(body.error_description || "")}）。もう一度 /auth/... を開いてください。`, 400);
  }
  const envFlag = env.WORKER_ENV ? ` --env ${escape(env.WORKER_ENV)}` : "";
  return html(
    `<p>ログインできました（${escape(env.GOOGLE_ACCOUNT || "")}）。</p>
<p>ターミナルで次のコマンドを実行し、聞かれたら下の文字列を貼り付けて Enter を押してください。</p>
<pre>npx wrangler secret put GOOGLE_REFRESH_TOKEN${envFlag}</pre>
<p><textarea readonly rows="3" cols="80" onclick="this.select()">${escape(body.refresh_token)}</textarea></p>
<p>この文字列は他人に見せないでください。貼り付けたら、このページは閉じてください。</p>`,
    200,
  );
}

export async function handleMessage(msg, tools, account = "", canWrite = false) {
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
        instructions: `${account || "1 つの Google アカウント"} の Google ドライブとスプレッドシートを読むツール（${canWrite ? "スプレッドシートだけ書き込みもできる" : "読み取り専用"}）。共有リンクの URL をそのまま fileId / spreadsheetId に渡せる。スプレッドシートは sheets_get_spreadsheet でシート名を見てから sheets_get_values で読む。${canWrite ? "書き込み（sheets_update_values / sheets_duplicate_sheet）の前に、必ず今の値を読んで、上書きしてよい範囲か確かめる。" : ""}`,
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

async function stateFor(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`oauth-state:${secret}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (body, status, headers = {}) => new Response(body, { status, headers });
const html = (body, status) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>google-drive-mcp</title><body style="font-family:sans-serif;max-width:720px;margin:2em auto">${body}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
