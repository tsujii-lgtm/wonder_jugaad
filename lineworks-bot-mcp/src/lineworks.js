// LINE WORKS API 2.0 の Bot でトークに投稿する部分。
// 認証は Service Account + JWT（RS256）。秘密鍵などは wrangler secret で入れる。

const TOKEN_URL = "https://auth.worksmobile.com/oauth2/v2.0/token";
const API = "https://www.worksapis.com/v1.0";
const MAX_TEXT = 2000; // LINE WORKS のテキスト1通の上限

let cached = { key: "", token: "", exp: 0 };
export function resetTokenCache() {
  cached = { key: "", token: "", exp: 0 };
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

function pemToDer(pem) {
  const body = String(pem)
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function makeJwt(env, nowSec = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(env.LW_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const unsigned = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({
    iss: env.LW_CLIENT_ID,
    sub: env.LW_SERVICE_ACCOUNT,
    iat: nowSec,
    exp: nowSec + 3600,
  })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

function need(env) {
  const missing = ["LW_CLIENT_ID", "LW_CLIENT_SECRET", "LW_SERVICE_ACCOUNT", "LW_PRIVATE_KEY", "LW_BOT_ID"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`設定が足りません: ${missing.join(", ")}（npx wrangler secret put で登録）`);
}

async function accessToken(env) {
  need(env);
  const cacheKey = `${env.LW_CLIENT_ID}/${env.LW_SERVICE_ACCOUNT}`;
  if (cached.key === cacheKey && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      assertion: await makeJwt(env),
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      client_id: env.LW_CLIENT_ID,
      client_secret: env.LW_CLIENT_SECRET,
      scope: "bot",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`LINE WORKS のトークン取得に失敗しました（${res.status} ${body.error || ""} ${body.error_description || ""}）。Client ID・Secret・Service Account・秘密鍵と、アプリのScopeに bot があるかを確かめてください。`);
  }
  cached = { key: cacheKey, token: body.access_token, exp: Date.now() + Number(body.expires_in || 3600) * 1000 };
  return cached.token;
}

async function api(env, method, path, body) {
  const token = await accessToken(env);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const textBody = await res.text();
  let data = {};
  try {
    data = textBody ? JSON.parse(textBody) : {};
  } catch {}
  if (!res.ok) {
    const hint =
      res.status === 403 || res.status === 404
        ? "Botがそのトークルームに入っているか、管理者画面でBotが公開されているかを確かめてください。"
        : "";
    throw new Error(`LINE WORKS API エラー ${res.status}: ${data.description || data.code || textBody}。${hint}`);
  }
  return data;
}

// Botの受信口（/callback）から使う。許可リストに関係なく、Botが入っているトークにだけ返事をする。
export async function postText(env, channelId, text) {
  return api(env, "POST", `/bots/${encodeURIComponent(env.LW_BOT_ID)}/channels/${encodeURIComponent(channelId)}/messages`, {
    content: { type: "text", text },
  });
}

export function splitText(text, max = MAX_TEXT) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

const allowedChannels = (env) =>
  String(env.LW_ALLOWED_CHANNEL_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function pickChannel(env, channelId) {
  const allowed = allowedChannels(env);
  const id = channelId || allowed[0];
  if (!id) throw new Error("送り先のトークルームが決まっていません。LW_ALLOWED_CHANNEL_IDS を設定してください。");
  if (!allowed.includes(id)) throw new Error(`このトークルーム（${id}）には送れません。送ってよいのは: ${allowed.join(", ") || "（未設定）"}`);
  return id;
}

const definitions = [
  {
    name: "lineworks_send_message",
    description:
      "BotからLINE WORKSのトークルームにテキストを送る。channelId を省くと既定のトークルーム（LW_ALLOWED_CHANNEL_IDS の先頭）。2000字を超えると自動で分けて送る。送ってよいトークルームは設定で決めたものだけ。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "送る本文" },
        channelId: { type: "string", description: "送り先のトークルームID（省略可）" },
      },
      required: ["text"],
    },
  },
  {
    name: "lineworks_list_targets",
    description: "このBotの情報と、送ってよいトークルームIDの一覧。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lineworks_create_channel",
    description:
      "Botと指定メンバーで新しいグループトークを作り、トークルームIDを返す（最初の設定用。LW_ALLOW_CREATE_CHANNEL が true のときだけ使える）。メンバーはLINE WORKSのID（メールアドレス形式）で渡す。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "トークルーム名" },
        members: { type: "array", items: { type: "string" }, description: "メンバーのID（例: tsujii.k@resow.co.jp）" },
      },
      required: ["title", "members"],
    },
  },
];

async function call(env, name, args) {
  switch (name) {
    case "lineworks_send_message": {
      const channelId = pickChannel(env, args.channelId);
      if (!args.text || !String(args.text).trim()) throw new Error("text が空です");
      const parts = splitText(args.text);
      for (const part of parts) {
        await api(env, "POST", `/bots/${encodeURIComponent(env.LW_BOT_ID)}/channels/${encodeURIComponent(channelId)}/messages`, {
          content: { type: "text", text: part },
        });
      }
      return { sent: true, channelId, messages: parts.length };
    }
    case "lineworks_list_targets": {
      need(env);
      const bot = await api(env, "GET", `/bots/${encodeURIComponent(env.LW_BOT_ID)}`);
      return { botId: env.LW_BOT_ID, botName: bot.botName, allowedChannelIds: allowedChannels(env) };
    }
    case "lineworks_create_channel": {
      if (env.LW_ALLOW_CREATE_CHANNEL !== "true") throw new Error("トークルームの作成は無効です（LW_ALLOW_CREATE_CHANNEL を true にすると使えます）");
      const members = Array.isArray(args.members) ? args.members.filter(Boolean) : [];
      if (!args.title || members.length === 0) throw new Error("title と members が要ります");
      const out = await api(env, "POST", `/bots/${encodeURIComponent(env.LW_BOT_ID)}/channels`, { members, title: args.title });
      return { channelId: out.channelId, note: "このIDを LW_ALLOWED_CHANNEL_IDS に入れると送れるようになります" };
    }
    default:
      return undefined;
  }
}

export const lineworksTools = { definitions, call };
