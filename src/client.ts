import type { Config } from "./config.js";

export interface ApiRequest {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

export async function callJugaad(config: Config, req: ApiRequest): Promise<ApiResponse> {
  if (!/^\//.test(req.path)) throw new Error(`path は / で始めてください: ${req.path}`);
  const url = new URL(config.baseUrl + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
    else url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
  if (config.apiKey) {
    headers[config.authHeader] = config.authScheme ? `${config.authScheme} ${config.apiKey}` : config.apiKey;
  }
  let body: string | undefined;
  if (req.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }

  const res = await fetch(url, {
    method: req.method.toUpperCase(),
    headers,
    body,
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // JSON 以外はテキストのまま返す
  }
  return { status: res.status, ok: res.ok, body: parsed };
}
