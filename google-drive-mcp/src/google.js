// Google ドライブ・スプレッドシートを読むツール（読み取り専用）。
// 1 つの Google アカウントの OAuth リフレッシュトークンで動く。

export const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE = "https://www.googleapis.com/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,createdTime,size,webViewLink,parents,owners(displayName,emailAddress),lastModifyingUser(displayName),shared,driveId";

const MIME = {
  folder: "application/vnd.google-apps.folder",
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  pdf: "application/pdf",
};

// 共有リンクや ID のどちらでも受け取れるようにする。
export function fileIdFrom(input) {
  const s = String(input || "").trim();
  if (!s) throw new Error("fileId（またはファイルの URL）を指定してください");
  const m = s.match(/\/d\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || s.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  throw new Error(`ファイル ID として読めません: ${s}`);
}

const quote = (v) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

let cached = { key: "", token: "", exp: 0 };

async function accessToken(env, fetchImpl) {
  const key = env.GOOGLE_REFRESH_TOKEN;
  if (cached.key === key && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: key,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Google のトークン更新に失敗しました（${res.status} ${body.error || ""}）。/auth/<MCP_SECRET> を開いてログインし直してください。`,
    );
  }
  cached = { key, token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 };
  return cached.token;
}

export function resetTokenCache() {
  cached = { key: "", token: "", exp: 0 };
}

async function google(env, fetchImpl, url, { raw = false } = {}) {
  const token = await accessToken(env, fetchImpl);
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error?.message || "";
    } catch {}
    if (res.status === 404) throw new Error(`見つかりません。このアカウント（${env.GOOGLE_ACCOUNT || "接続中のアカウント"}）に共有されていない可能性があります。${detail}`);
    throw new Error(`Google API エラー ${res.status}: ${detail}`);
  }
  return raw ? res.text() : res.json();
}

const qs = (o) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

const listParams = (q, max, pageToken, orderBy) => ({
  q,
  pageSize: Math.min(Math.max(Number(max) || 20, 1), 100),
  pageToken,
  orderBy,
  fields: `nextPageToken,files(${FILE_FIELDS})`,
  supportsAllDrives: "true",
  includeItemsFromAllDrives: "true",
  corpora: "allDrives",
});

const clip = (text, max) => {
  const n = Number(max) || 50000;
  return text.length > n ? `${text.slice(0, n)}\n…（${text.length} 文字中 ${n} 文字まで表示。続きは maxChars を増やす）` : text;
};

const idArg = { type: "string", description: "ファイル ID、または共有リンク（https://docs.google.com/...）" };

const definitions = [
  {
    name: "drive_search_files",
    description:
      "ドライブのファイルを探す。query はファイル名と本文の両方から探す。type で種類を絞れる。共有ドライブも含む。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "探す言葉（ファイル名・本文）" },
        type: { type: "string", enum: Object.keys(MIME), description: "種類で絞る" },
        q: { type: "string", description: "上級者向け: Drive API の q をそのまま渡す（query・type より優先）" },
        max: { type: "number", description: "件数（既定 20、最大 100）" },
        pageToken: { type: "string", description: "前の結果の nextPageToken" },
      },
    },
  },
  {
    name: "drive_list_recent",
    description: "最近更新されたファイルの一覧。",
    inputSchema: { type: "object", properties: { max: { type: "number" }, pageToken: { type: "string" } } },
  },
  {
    name: "drive_list_folder",
    description: "フォルダの中身の一覧（フォルダの ID か URL を渡す）。",
    inputSchema: {
      type: "object",
      properties: { folderId: idArg, max: { type: "number" }, pageToken: { type: "string" } },
      required: ["folderId"],
    },
  },
  {
    name: "drive_get_file",
    description: "ファイルの情報（名前・種類・更新日・オーナー・リンク）。",
    inputSchema: { type: "object", properties: { fileId: idArg }, required: ["fileId"] },
  },
  {
    name: "drive_read_file",
    description:
      "ファイルの中身を文字で読む。Google ドキュメント・スライドは本文、スプレッドシートは最初のシートの CSV、テキスト類はそのまま。スプレッドシートの別のシートは sheets_get_values を使う。",
    inputSchema: {
      type: "object",
      properties: { fileId: idArg, maxChars: { type: "number", description: "最大文字数（既定 50000）" } },
      required: ["fileId"],
    },
  },
  {
    name: "sheets_get_spreadsheet",
    description: "スプレッドシートのタイトルとシート（タブ）の一覧・行数・列数。",
    inputSchema: { type: "object", properties: { spreadsheetId: idArg }, required: ["spreadsheetId"] },
  },
  {
    name: "sheets_get_values",
    description:
      "スプレッドシートのセルの値を読む。range は「シート名」だけでも「シート名!A1:F50」でもよい。省略すると全シートを読む。",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: idArg,
        range: { type: "string", description: "例: 進行台本 / 決定事項!A1:H100" },
        ranges: { type: "array", items: { type: "string" }, description: "複数の範囲をまとめて読む" },
        formulas: { type: "boolean", description: "true なら値ではなく数式を返す" },
      },
      required: ["spreadsheetId"],
    },
  },
];

export async function googleTools(env, fetchImpl = (...a) => fetch(...a)) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) return null;
  const get = (url, opts) => google(env, fetchImpl, url, opts);

  const sheetTitles = async (id) => {
    const meta = await get(`${SHEETS}/${id}?${qs({ fields: "properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount),hidden)" })}`);
    return meta;
  };

  const handlers = {
    async drive_search_files({ query, type, q, max, pageToken }) {
      let filter = q;
      if (!filter) {
        const parts = ["trashed = false"];
        if (query) parts.push(`(name contains ${quote(query)} or fullText contains ${quote(query)})`);
        if (type) parts.push(`mimeType = ${quote(MIME[type] || type)}`);
        filter = parts.join(" and ");
      }
      return get(`${DRIVE}/files?${qs(listParams(filter, max, pageToken, query ? undefined : "modifiedTime desc"))}`);
    },
    async drive_list_recent({ max, pageToken }) {
      return get(`${DRIVE}/files?${qs(listParams("trashed = false", max, pageToken, "modifiedTime desc"))}`);
    },
    async drive_list_folder({ folderId, max, pageToken }) {
      const id = fileIdFrom(folderId);
      return get(`${DRIVE}/files?${qs(listParams(`${quote(id)} in parents and trashed = false`, max, pageToken, "folder,name"))}`);
    },
    async drive_get_file({ fileId }) {
      return get(`${DRIVE}/files/${fileIdFrom(fileId)}?${qs({ fields: FILE_FIELDS, supportsAllDrives: "true" })}`);
    },
    async drive_read_file({ fileId, maxChars }) {
      const id = fileIdFrom(fileId);
      const meta = await get(`${DRIVE}/files/${id}?${qs({ fields: "id,name,mimeType", supportsAllDrives: "true" })}`);
      const exportAs = {
        [MIME.document]: "text/plain",
        [MIME.presentation]: "text/plain",
        [MIME.spreadsheet]: "text/csv",
      }[meta.mimeType];
      let body;
      if (exportAs) {
        body = await get(`${DRIVE}/files/${id}/export?${qs({ mimeType: exportAs })}`, { raw: true });
      } else if (/^text\/|json|csv|xml|javascript|markdown/.test(meta.mimeType)) {
        body = await get(`${DRIVE}/files/${id}?${qs({ alt: "media", supportsAllDrives: "true" })}`, { raw: true });
      } else {
        return `「${meta.name}」（${meta.mimeType}）は文字で読めない形式です。Google ドキュメント・スプレッドシート・スライド・テキストに対応しています。`;
      }
      return `# ${meta.name}（${meta.mimeType}）\n\n${clip(body, maxChars)}`;
    },
    async sheets_get_spreadsheet({ spreadsheetId }) {
      const meta = await sheetTitles(fileIdFrom(spreadsheetId));
      return {
        title: meta.properties?.title,
        sheets: (meta.sheets || []).map(({ properties: p }) => ({
          title: p.title,
          gid: p.sheetId,
          rows: p.gridProperties?.rowCount,
          columns: p.gridProperties?.columnCount,
          ...(p.hidden ? { hidden: true } : {}),
        })),
      };
    },
    async sheets_get_values({ spreadsheetId, range, ranges, formulas }) {
      const id = fileIdFrom(spreadsheetId);
      let list = ranges?.length ? ranges : range ? [range] : null;
      if (!list) list = ((await sheetTitles(id)).sheets || []).map((s) => s.properties.title);
      const params = new URLSearchParams({ valueRenderOption: formulas ? "FORMULA" : "FORMATTED_VALUE" });
      for (const r of list) params.append("ranges", r.includes("!") || /^'.*'$/.test(r) ? r : `'${r.replace(/'/g, "''")}'`);
      const data = await get(`${SHEETS}/${id}/values:batchGet?${params}`);
      return (data.valueRanges || []).map((v) => ({ range: v.range, values: v.values || [] }));
    },
  };

  return {
    definitions,
    async call(name, args) {
      const h = handlers[name];
      return h ? h(args || {}) : undefined;
    },
  };
}
