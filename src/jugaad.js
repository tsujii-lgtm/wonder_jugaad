// ジュガール（Jugaad）の API を呼ぶツール。JUGAAD_API_KEY があるときだけ有効になる。
// Swagger の URL（JUGAAD_OPENAPI_URL）があれば、エンドポイントごとのツールを自動で作る。

import { buildRequest, operationsFromSpec } from "./openapi.js";

const specCache = new Map(); // Worker のインスタンス内だけで使い回す

export async function jugaadTools(env, fetchImpl = (...a) => fetch(...a)) {
  if (!env.JUGAAD_API_KEY) return null;
  const allowWrite = env.JUGAAD_ALLOW_WRITE === "true";
  const baseUrl = (env.JUGAAD_BASE_URL || "https://smartflow.vebuin.com").replace(/\/+$/, "");
  const allowed = allowWrite ? ["GET", "POST", "PUT", "PATCH", "DELETE"] : ["GET"];

  let operations = [];
  let specError = null;
  if (env.JUGAAD_OPENAPI_URL) {
    try {
      if (!specCache.has(env.JUGAAD_OPENAPI_URL)) {
        const res = await fetchImpl(env.JUGAAD_OPENAPI_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        specCache.set(env.JUGAAD_OPENAPI_URL, await res.json());
      }
      operations = operationsFromSpec(specCache.get(env.JUGAAD_OPENAPI_URL), { allowWrite });
    } catch (e) {
      specError = `Swagger を読み込めませんでした: ${e.message}`;
    }
  }
  const byName = new Map(operations.map((o) => [o.toolName, o]));

  async function request({ method, path, query, headers, body }) {
    if (!path.startsWith("/")) throw new Error(`path は / で始めてください: ${path}`);
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, String(v));
    }
    const h = { Accept: "application/json", ...headers };
    const header = env.JUGAAD_AUTH_HEADER || "Authorization";
    const scheme = env.JUGAAD_AUTH_SCHEME ?? "Bearer";
    h[header] = scheme ? `${scheme} ${env.JUGAAD_API_KEY}` : env.JUGAAD_API_KEY;
    let payload;
    if (body !== undefined) {
      h["Content-Type"] ??= "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetchImpl(url.toString(), { method: method.toUpperCase(), headers: h, body: payload });
    const raw = await res.text();
    let parsed = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // JSON 以外はそのまま返す
    }
    if (!res.ok) throw new Error(`ジュガール API エラー ${res.status}: ${raw.slice(0, 300)}`);
    return parsed;
  }

  const definitions = [
    ...operations.map((o) => ({
      name: o.toolName,
      description: o.description,
      inputSchema: o.inputSchema,
      annotations: { readOnlyHint: o.method === "GET" },
    })),
    {
      name: "jugaad_api_request",
      description:
        "ジュガール API を直接呼び出す。仕様にない操作や、自動生成ツールで足りないときに使う。" +
        (allowWrite ? "" : "（読み取り専用: GET のみ）"),
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", enum: allowed },
          path: { type: "string", description: "例: /api/v1/applications" },
          query: { type: "object", description: "クエリパラメータ" },
          body: { description: "JSON ボディ" },
        },
        required: ["method", "path"],
      },
      annotations: { readOnlyHint: !allowWrite },
    },
    {
      name: "jugaad_list_endpoints",
      description: "読み込んだ Swagger 仕様に含まれるエンドポイントの一覧を返す。",
      inputSchema: { type: "object", properties: { filter: { type: "string", description: "パスや説明の部分一致" } } },
      annotations: { readOnlyHint: true },
    },
  ];

  return {
    definitions,
    async call(name, args) {
      if (name === "jugaad_list_endpoints") {
        const f = String(args.filter ?? "").toLowerCase();
        const rows = operations
          .filter((o) => !f || `${o.path} ${o.description}`.toLowerCase().includes(f))
          .map((o) => `${o.method} ${o.path}  →  ${o.toolName}`);
        if (rows.length) return rows.join("\n");
        return specError ?? "該当なし（JUGAAD_OPENAPI_URL が未設定の場合は jugaad_api_request を使ってください）";
      }
      if (name === "jugaad_api_request") {
        const method = String(args.method ?? "GET").toUpperCase();
        if (!allowed.includes(method)) throw new Error(`${method} は許可されていません（JUGAAD_ALLOW_WRITE が "true" のときだけ書き込めます）`);
        return request({ method, path: String(args.path), query: args.query, body: args.body });
      }
      const op = byName.get(name);
      if (!op) return undefined;
      return request(buildRequest(op, args));
    },
  };
}
