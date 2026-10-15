// 環境変数から設定を読み込む。認証情報はリポジトリに置かず、必ず環境変数で渡す。

export interface Config {
  baseUrl: string;
  apiKey?: string;
  authHeader: string;
  authScheme: string;
  openapiSource?: string;
  allowWrite: boolean;
  timeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    baseUrl: (env.JUGAAD_BASE_URL ?? "https://smartflow.vebuin.com").replace(/\/+$/, ""),
    apiKey: env.JUGAAD_API_KEY || undefined,
    authHeader: env.JUGAAD_AUTH_HEADER ?? "Authorization",
    // 空文字にするとキーをそのままヘッダ値として送る（例: X-API-KEY 方式）
    authScheme: env.JUGAAD_AUTH_SCHEME ?? "Bearer",
    openapiSource: env.JUGAAD_OPENAPI || undefined,
    // 既定は読み取り専用。申請の作成・承認などを許可するときだけ true にする
    allowWrite: env.JUGAAD_ALLOW_WRITE === "true",
    timeoutMs: Number(env.JUGAAD_TIMEOUT_MS ?? 30000),
  };
}
