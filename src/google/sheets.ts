// Google スプレッドシート用のツール。サービスアカウントで認証し、既定は読み取り専用。
import { GoogleAuth } from "google-auth-library";

export interface ExtraTools {
  definitions: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  call(name: string, args: Record<string, any>): Promise<unknown | undefined>;
}

export interface SheetsConfig {
  credentialsJson?: string;
  credentialsFile?: string;
  allowWrite: boolean;
  sheetsBase: string;
  driveBase: string;
}

export function loadSheetsConfig(env: NodeJS.ProcessEnv = process.env, allowWrite = false): SheetsConfig | undefined {
  const credentialsJson = env.GOOGLE_SERVICE_ACCOUNT_JSON || undefined;
  const credentialsFile = env.GOOGLE_APPLICATION_CREDENTIALS || undefined;
  if (!credentialsJson && !credentialsFile) return undefined;
  return {
    credentialsJson,
    credentialsFile,
    allowWrite: env.GOOGLE_ALLOW_WRITE === "true" || allowWrite,
    sheetsBase: env.GOOGLE_SHEETS_BASE ?? "https://sheets.googleapis.com/v4",
    driveBase: env.GOOGLE_DRIVE_BASE ?? "https://www.googleapis.com/drive/v3",
  };
}

type TokenProvider = () => Promise<string>;

function googleTokenProvider(config: SheetsConfig): TokenProvider {
  const auth = new GoogleAuth({
    ...(config.credentialsJson ? { credentials: JSON.parse(config.credentialsJson) } : {}),
    scopes: [
      config.allowWrite ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
  return async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error("Google のアクセストークンを取得できませんでした");
    return token;
  };
}

// URL（…/spreadsheets/d/<id>/edit）でも ID でも受け付ける
export function spreadsheetId(input: string): string {
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(input);
  return m ? m[1] : input.trim();
}

async function gfetch(getToken: TokenProvider, url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // JSON 以外はそのまま返す
  }
  if (!res.ok) {
    const hint =
      res.status === 404 || res.status === 403
        ? "（シートがサービスアカウントに共有されているか確認してください）"
        : "";
    throw new Error(`Google API ${res.status}${hint}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

export function createSheetsTools(config: SheetsConfig, getToken: TokenProvider = googleTokenProvider(config)): ExtraTools {
  const idProp = { type: "string", description: "スプレッドシートの URL または ID" };
  const definitions: ExtraTools["definitions"] = [
    {
      name: "sheets_list_spreadsheets",
      description: "サービスアカウントに共有されているスプレッドシートの一覧（名前で絞り込み可）。",
      inputSchema: { type: "object", properties: { name_contains: { type: "string" }, page_size: { type: "number" } } },
    },
    {
      name: "sheets_get_spreadsheet",
      description: "スプレッドシートのタイトルとシート（タブ）名・行列数を返す。",
      inputSchema: { type: "object", properties: { spreadsheet: idProp }, required: ["spreadsheet"] },
    },
    {
      name: "sheets_get_values",
      description: "指定範囲の値を返す。範囲は A1 記法（例: 'Sheet1!A1:D50'）。",
      inputSchema: {
        type: "object",
        properties: { spreadsheet: idProp, range: { type: "string", description: "例: Sheet1!A1:D50" } },
        required: ["spreadsheet", "range"],
      },
    },
  ];
  if (config.allowWrite) {
    definitions.push(
      {
        name: "sheets_update_values",
        description: "指定範囲に値を書き込む（上書き）。values は行の配列。",
        inputSchema: {
          type: "object",
          properties: { spreadsheet: idProp, range: { type: "string" }, values: { type: "array", items: { type: "array" } } },
          required: ["spreadsheet", "range", "values"],
        },
      },
      {
        name: "sheets_append_values",
        description: "表の末尾に行を追加する。",
        inputSchema: {
          type: "object",
          properties: { spreadsheet: idProp, range: { type: "string" }, values: { type: "array", items: { type: "array" } } },
          required: ["spreadsheet", "range", "values"],
        },
      },
    );
  }

  const q = encodeURIComponent;
  return {
    definitions,
    async call(name, args) {
      switch (name) {
        case "sheets_list_spreadsheets": {
          const filters = ["mimeType='application/vnd.google-apps.spreadsheet'", "trashed=false"];
          if (args.name_contains) filters.push(`name contains '${String(args.name_contains).replace(/(['\\])/g, "\\$1")}'`);
          const url =
            `${config.driveBase}/files?q=${q(filters.join(" and "))}` +
            `&fields=${q("files(id,name,modifiedTime,owners(emailAddress)),nextPageToken")}` +
            `&pageSize=${Math.min(Number(args.page_size ?? 30), 100)}&orderBy=modifiedTime%20desc` +
            `&supportsAllDrives=true&includeItemsFromAllDrives=true`;
          return gfetch(getToken, url);
        }
        case "sheets_get_spreadsheet": {
          const id = spreadsheetId(String(args.spreadsheet));
          const fields = "spreadsheetId,properties.title,sheets.properties(title,gridProperties)";
          return gfetch(getToken, `${config.sheetsBase}/spreadsheets/${q(id)}?fields=${q(fields)}`);
        }
        case "sheets_get_values": {
          const id = spreadsheetId(String(args.spreadsheet));
          return gfetch(getToken, `${config.sheetsBase}/spreadsheets/${q(id)}/values/${q(String(args.range))}`);
        }
        case "sheets_update_values":
        case "sheets_append_values": {
          if (!config.allowWrite) throw new Error("書き込みは許可されていません（GOOGLE_ALLOW_WRITE=true が必要です）");
          const id = spreadsheetId(String(args.spreadsheet));
          const range = q(String(args.range));
          const body = JSON.stringify({ values: args.values });
          const url =
            name === "sheets_update_values"
              ? `${config.sheetsBase}/spreadsheets/${q(id)}/values/${range}?valueInputOption=USER_ENTERED`
              : `${config.sheetsBase}/spreadsheets/${q(id)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
          return gfetch(getToken, url, { method: name === "sheets_update_values" ? "PUT" : "POST", body });
        }
        default:
          return undefined;
      }
    },
  };
}
