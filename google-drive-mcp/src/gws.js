// Google Workspace 全般（ドライブ・スプレッドシート・ドキュメント・スライド・Gmail・カレンダー）の書き込みツール。
// wrangler.toml で GWS_FULL = "true" にした環境だけで使う。
// 外に出る・消える操作（メール送信、ゴミ箱、共有、予定の削除、招待つきの予定）は ALLOW_SEND = "true" のときだけ増え、
// 毎回 confirmed: true を求める（使う前にチャットで本人の OK をもらう約束）。

import { fileIdFrom } from "./google.js";

export const GWS_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
];

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DOCS = "https://docs.googleapis.com/v1/documents";
const SLIDES = "https://slides.googleapis.com/v1/presentations";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3";
const TZ = "Asia/Tokyo";

const GOOGLE_MIME = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder",
};
const CONTENT_TYPES = { text: "text/plain", markdown: "text/markdown", html: "text/html", csv: "text/csv" };

const idArg = { type: "string", description: "ファイル ID、または共有リンク（https://docs.google.com/...）" };
const confirmArg = {
  type: "boolean",
  description: "辻井さんにチャットで内容を見せて OK をもらったときだけ true にする。OK がなければ呼ばない。",
};

const qs = (o) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

const flag = (v) => String(v || "").toLowerCase() === "true";
export const sendEnabled = (env) => flag(env.ALLOW_SEND);

function requireConfirmed(args, what) {
  if (args.confirmed !== true) throw new Error(`${what}は外に出る・消える操作です。内容を辻井さんに見せて OK をもらってから、confirmed: true で呼んでください。`);
}

// ---- 文字コードまわり ----
const utf8 = (s) => new TextEncoder().encode(s);
function b64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromB64url(s) {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(utf8(s))}?=`);
const list = (v) => (Array.isArray(v) ? v.join(", ") : v || "");
const noCrlf = (v, name) => {
  if (/[\r\n]/.test(v)) throw new Error(`${name} に改行は入れられません`);
  return v;
};

export function buildMime({ to, cc, bcc, subject, body, html, inReplyTo, references }) {
  const headers = [];
  if (list(to)) headers.push(`To: ${noCrlf(list(to), "to")}`);
  if (list(cc)) headers.push(`Cc: ${noCrlf(list(cc), "cc")}`);
  if (list(bcc)) headers.push(`Bcc: ${noCrlf(list(bcc), "bcc")}`);
  headers.push(`Subject: ${encodeHeader(noCrlf(subject || "", "subject"))}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${[references, inReplyTo].filter(Boolean).join(" ")}`);
  headers.push("MIME-Version: 1.0", `Content-Type: ${html ? "text/html" : "text/plain"}; charset=UTF-8`, "Content-Transfer-Encoding: base64");
  const content = b64(utf8(body || "")).replace(/.{76}/g, "$&\r\n");
  return b64url(utf8(`${headers.join("\r\n")}\r\n\r\n${content}`));
}

const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

function bodyText(payload) {
  const found = { plain: "", html: "", attachments: [] };
  const walk = (p) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) found.attachments.push({ filename: p.filename, mimeType: p.mimeType, size: p.body.size, attachmentId: p.body.attachmentId });
    else if (p.mimeType === "text/plain" && p.body?.data && !found.plain) found.plain = new TextDecoder().decode(fromB64url(p.body.data));
    else if (p.mimeType === "text/html" && p.body?.data && !found.html) found.html = new TextDecoder().decode(fromB64url(p.body.data));
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const text =
    found.plain ||
    found.html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return { text, attachments: found.attachments };
}

const summary = (m) => ({
  id: m.id,
  threadId: m.threadId,
  date: header(m, "Date"),
  from: header(m, "From"),
  to: header(m, "To"),
  subject: header(m, "Subject"),
  snippet: m.snippet,
  labels: m.labelIds,
});

// "2026-11-20" は終日、"2026-11-20T10:00" は日本時間として扱う。
function when(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} を指定してください（例: 2026-11-20T10:00 / 終日なら 2026-11-20）`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s };
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return { dateTime: s };
  return { dateTime: s.length === 16 ? `${s}:00` : s, timeZone: TZ };
}

const eventSummary = (e) => ({
  id: e.id,
  summary: e.summary,
  start: e.start?.dateTime || e.start?.date,
  end: e.end?.dateTime || e.end?.date,
  location: e.location,
  description: e.description,
  attendees: e.attendees?.map((a) => `${a.email}${a.responseStatus ? `(${a.responseStatus})` : ""}`),
  htmlLink: e.htmlLink,
});

const DANGEROUS_LABELS = ["TRASH", "SPAM"];

// ---- ツール定義 ----
const definitions = [
  // ドライブ
  {
    name: "drive_create_folder",
    description: "フォルダを作る。parentId を省くとマイドライブ直下。",
    inputSchema: { type: "object", properties: { name: { type: "string" }, parentId: idArg }, required: ["name"] },
  },
  {
    name: "drive_create_file",
    description:
      "新しい Google ドキュメント／スプレッドシート／スライド、またはテキストファイルを作る。content を渡すと中身つきで作る（document は text・markdown・html、spreadsheet は csv を変換して取り込む）。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string", enum: ["document", "spreadsheet", "presentation", "text"], description: "作る種類" },
        parentId: { ...idArg, description: "置くフォルダの ID か URL（省くとマイドライブ直下）" },
        content: { type: "string", description: "最初の中身（任意）" },
        contentFormat: { type: "string", enum: Object.keys(CONTENT_TYPES), description: "content の形式（既定: document は markdown、spreadsheet は csv、text は text）" },
      },
      required: ["name", "type"],
    },
  },
  {
    name: "drive_copy_file",
    description: "ファイルをコピーする（テンプレートから新しく作るときなど）。元のファイルは変わらない。",
    inputSchema: {
      type: "object",
      properties: { fileId: idArg, name: { type: "string", description: "コピーの名前" }, parentId: { ...idArg, description: "コピーを置くフォルダ（省くと元と同じ場所）" } },
      required: ["fileId"],
    },
  },
  {
    name: "drive_update_file",
    description: "ファイル・フォルダの名前や説明を変える、別のフォルダへ移す。",
    inputSchema: {
      type: "object",
      properties: {
        fileId: idArg,
        name: { type: "string", description: "新しい名前" },
        description: { type: "string" },
        moveToFolderId: { ...idArg, description: "移動先のフォルダ（今の親フォルダからは外れる）" },
      },
      required: ["fileId"],
    },
  },
  {
    name: "drive_list_permissions",
    description: "ファイルを誰と共有しているか（権限の一覧）。",
    inputSchema: { type: "object", properties: { fileId: idArg }, required: ["fileId"] },
  },
  // スプレッドシート
  {
    name: "sheets_append_values",
    description: "表の一番下（データがある最後の行の次）に行を足す。range はシート名か「シート名!A:G」。既存の行は上書きしない。",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: idArg,
        range: { type: "string", description: "例: 求人リスト / 求人リスト!A:H" },
        values: { type: "array", items: { type: "array", items: {} }, description: "足す行の配列" },
        raw: { type: "boolean", description: "true なら文字のまま入れる" },
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  {
    name: "sheets_clear_values",
    description: "範囲の値を消す（書式は残る）。消す前に sheets_get_values で中身を確かめ、消してよいか本人に確かめること。",
    inputSchema: { type: "object", properties: { spreadsheetId: idArg, range: { type: "string", description: "例: 作業用!A2:H100" } }, required: ["spreadsheetId", "range"] },
  },
  {
    name: "sheets_add_sheet",
    description: "空のシート（タブ）を足す。",
    inputSchema: {
      type: "object",
      properties: { spreadsheetId: idArg, title: { type: "string" }, rows: { type: "number" }, columns: { type: "number" } },
      required: ["spreadsheetId", "title"],
    },
  },
  {
    name: "sheets_batch_update",
    description:
      "上級者向け: Sheets API の spreadsheets.batchUpdate の requests をそのまま送る（書式、列幅、固定行、条件付き書式、シート名の変更など）。シートの削除（deleteSheet）は使わない。",
    inputSchema: { type: "object", properties: { spreadsheetId: idArg, requests: { type: "array", items: { type: "object" } } }, required: ["spreadsheetId", "requests"] },
  },
  // ドキュメント
  {
    name: "docs_get_document",
    description: "Google ドキュメントの見出し・段落を、位置（index）つきで返す。どこに書き足すか決めるときに使う。本文だけなら drive_read_file。",
    inputSchema: { type: "object", properties: { documentId: idArg, maxChars: { type: "number" } }, required: ["documentId"] },
  },
  {
    name: "docs_append_text",
    description: "Google ドキュメントの最後に文章を書き足す。",
    inputSchema: { type: "object", properties: { documentId: idArg, text: { type: "string" } }, required: ["documentId", "text"] },
  },
  {
    name: "docs_insert_text",
    description: "Google ドキュメントの指定位置（index、docs_get_document で確かめる）に文章を差し込む。",
    inputSchema: { type: "object", properties: { documentId: idArg, index: { type: "number" }, text: { type: "string" } }, required: ["documentId", "index", "text"] },
  },
  {
    name: "docs_replace_text",
    description: "Google ドキュメントの中の文字を、すべて置き換える（テンプレートの {{名前}} を埋めるときなど）。",
    inputSchema: {
      type: "object",
      properties: {
        documentId: idArg,
        replacements: {
          type: "array",
          items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] },
        },
        matchCase: { type: "boolean", description: "大文字小文字を区別する（既定 true）" },
      },
      required: ["documentId", "replacements"],
    },
  },
  {
    name: "docs_batch_update",
    description: "上級者向け: Docs API の documents.batchUpdate の requests をそのまま送る（見出しの書式、表、箇条書きなど）。",
    inputSchema: { type: "object", properties: { documentId: idArg, requests: { type: "array", items: { type: "object" } } }, required: ["documentId", "requests"] },
  },
  // スライド
  {
    name: "slides_get_presentation",
    description: "スライドの一覧と、各スライドの図形の ID と文字。",
    inputSchema: { type: "object", properties: { presentationId: idArg }, required: ["presentationId"] },
  },
  {
    name: "slides_replace_text",
    description: "スライド全体の文字をすべて置き換える（テンプレートの {{名前}} を埋めるときなど）。",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: idArg,
        replacements: {
          type: "array",
          items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] },
        },
      },
      required: ["presentationId", "replacements"],
    },
  },
  {
    name: "slides_batch_update",
    description: "上級者向け: Slides API の presentations.batchUpdate の requests をそのまま送る（スライドを足す、図形や表を作るなど）。",
    inputSchema: { type: "object", properties: { presentationId: idArg, requests: { type: "array", items: { type: "object" } } }, required: ["presentationId", "requests"] },
  },
  // Gmail
  {
    name: "gmail_search",
    description: "Gmail を探す。query は Gmail の検索窓と同じ書き方（例: from:jqa.jp newer_than:7d is:unread）。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, max: { type: "number", description: "件数（既定 20、最大 50）" }, pageToken: { type: "string" } },
    },
  },
  {
    name: "gmail_read_message",
    description: "メール 1 通の本文と添付ファイルの一覧。",
    inputSchema: { type: "object", properties: { messageId: { type: "string" }, maxChars: { type: "number" } }, required: ["messageId"] },
  },
  {
    name: "gmail_read_thread",
    description: "スレッド（やり取り）全体を古い順に読む。",
    inputSchema: { type: "object", properties: { threadId: { type: "string" }, maxChars: { type: "number" } }, required: ["threadId"] },
  },
  {
    name: "gmail_get_attachment",
    description: "添付ファイルを取る。テキスト類は文字で、それ以外は base64 で返す（5MB まで）。",
    inputSchema: { type: "object", properties: { messageId: { type: "string" }, attachmentId: { type: "string" } }, required: ["messageId", "attachmentId"] },
  },
  {
    name: "gmail_list_labels",
    description: "ラベルの一覧（ID と名前）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "gmail_modify_labels",
    description: "メールのラベルを付け外しする。既読にする＝remove UNREAD、アーカイブ＝remove INBOX、スター＝add STARRED。ゴミ箱・迷惑メールには使えない。",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: { type: "array", items: { type: "string" } },
        add: { type: "array", items: { type: "string" }, description: "付けるラベル ID" },
        remove: { type: "array", items: { type: "string" }, description: "外すラベル ID" },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "gmail_create_draft",
    description:
      "メールの下書きを作る（送信はしない）。返信なら replyToMessageId を渡すと、同じスレッドに件名「Re: 」と宛先を引き継いで作る。",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string", description: "本文" },
        html: { type: "boolean", description: "true なら body を HTML として扱う" },
        replyToMessageId: { type: "string", description: "返信元のメール ID" },
      },
      required: ["body"],
    },
  },
  {
    name: "gmail_list_drafts",
    description: "下書きの一覧。",
    inputSchema: { type: "object", properties: { max: { type: "number" } } },
  },
  // カレンダー
  {
    name: "calendar_list_calendars",
    description: "見られるカレンダーの一覧（ID と名前）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "calendar_list_events",
    description: "予定の一覧。timeMin・timeMax は「2026-11-20」や「2026-11-20T09:00」（日本時間）。省くと今から 7 日分。",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "既定 primary（自分のカレンダー）" },
        timeMin: { type: "string" },
        timeMax: { type: "string" },
        query: { type: "string", description: "予定名などで絞る" },
        max: { type: "number", description: "既定 50" },
      },
    },
  },
  {
    name: "calendar_create_event",
    description:
      "自分のカレンダーに予定を作る（招待なし）。start・end は「2026-11-20T10:00」（日本時間）、終日なら「2026-11-20」。参加者を招待するのは calendar_invite（送信を許可した環境だけ）。",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        summary: { type: "string", description: "予定名" },
        start: { type: "string" },
        end: { type: "string" },
        location: { type: "string" },
        description: { type: "string" },
        meet: { type: "boolean", description: "true なら Google Meet の URL を付ける" },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "calendar_update_event",
    description: "予定の名前・時間・場所・説明を変える（変えたい項目だけ渡す）。参加者がいる予定は、変更の通知を送らない。",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        eventId: { type: "string" },
        summary: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        location: { type: "string" },
        description: { type: "string" },
      },
      required: ["eventId"],
    },
  },
];

const sendDefinitions = [
  {
    name: "gmail_send_draft",
    description: "下書きを送信する。送る前に必ず宛先・件名・本文を辻井さんに見せて OK をもらい、confirmed: true で呼ぶ。",
    inputSchema: { type: "object", properties: { draftId: { type: "string" }, confirmed: confirmArg }, required: ["draftId", "confirmed"] },
  },
  {
    name: "gmail_trash_message",
    description: "メールをゴミ箱に入れる（30 日は戻せる）。辻井さんの OK をもらってから confirmed: true で呼ぶ。",
    inputSchema: { type: "object", properties: { messageIds: { type: "array", items: { type: "string" } }, confirmed: confirmArg }, required: ["messageIds", "confirmed"] },
  },
  {
    name: "drive_trash_file",
    description: "ファイル・フォルダをゴミ箱に入れる（30 日は戻せる）。辻井さんの OK をもらってから confirmed: true で呼ぶ。",
    inputSchema: { type: "object", properties: { fileId: idArg, confirmed: confirmArg }, required: ["fileId", "confirmed"] },
  },
  {
    name: "drive_share_file",
    description: "ファイル・フォルダを人に共有する。role は reader（閲覧）・commenter（コメント）・writer（編集）。辻井さんの OK をもらってから confirmed: true で呼ぶ。",
    inputSchema: {
      type: "object",
      properties: {
        fileId: idArg,
        email: { type: "string" },
        role: { type: "string", enum: ["reader", "commenter", "writer"] },
        notify: { type: "boolean", description: "共有のお知らせメールを送る（既定 false）" },
        message: { type: "string", description: "お知らせメールに添える文" },
        confirmed: confirmArg,
      },
      required: ["fileId", "email", "role", "confirmed"],
    },
  },
  {
    name: "calendar_invite",
    description:
      "参加者を招待して予定を作る（eventId を渡すと既存の予定に参加者を足す）。招待メールが届く。辻井さんの OK をもらってから confirmed: true で呼ぶ。",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        eventId: { type: "string", description: "既存の予定に足すとき" },
        attendees: { type: "array", items: { type: "string" }, description: "招待するメールアドレス" },
        summary: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        location: { type: "string" },
        description: { type: "string" },
        meet: { type: "boolean" },
        confirmed: confirmArg,
      },
      required: ["attendees", "confirmed"],
    },
  },
  {
    name: "calendar_delete_event",
    description: "予定を消す。参加者がいる予定は、取り消しの通知が届く。辻井さんの OK をもらってから confirmed: true で呼ぶ。",
    inputSchema: {
      type: "object",
      properties: { calendarId: { type: "string" }, eventId: { type: "string" }, confirmed: confirmArg },
      required: ["eventId", "confirmed"],
    },
  },
];

export function gwsTools(env, get, { sheetTitles }) {
  const cal = (id) => encodeURIComponent(id || "primary");
  const clip = (s, max) => {
    const n = Number(max) || 20000;
    return s.length > n ? `${s.slice(0, n)}\n…（${s.length} 文字中 ${n} 文字まで）` : s;
  };
  const readMessage = async (id, maxChars) => {
    const m = await get(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
    const { text, attachments } = bodyText(m.payload);
    return { ...summary(m), cc: header(m, "Cc"), body: clip(text, maxChars), attachments };
  };
  const meetData = (meet) => (meet ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {});
  const eventBody = (a) => {
    const b = {};
    if (a.summary !== undefined) b.summary = a.summary;
    if (a.location !== undefined) b.location = a.location;
    if (a.description !== undefined) b.description = a.description;
    if (a.start !== undefined) b.start = when(a.start, "start");
    if (a.end !== undefined) b.end = when(a.end, "end");
    return b;
  };
  const replaceRequests = (replacements, matchCase = true) =>
    (replacements || []).map((r) => ({ replaceAllText: { containsText: { text: r.find, matchCase }, replaceText: r.replace } }));
  const countReplaced = (out) => (out.replies || []).map((r) => r.replaceAllText?.occurrencesChanged || 0);

  const handlers = {
    // ---- ドライブ ----
    async drive_create_folder({ name, parentId }) {
      if (!name) throw new Error("name を指定してください");
      return get(`${DRIVE}/files?${qs({ supportsAllDrives: "true", fields: "id,name,webViewLink" })}`, {
        method: "POST",
        body: { name, mimeType: GOOGLE_MIME.folder, ...(parentId ? { parents: [fileIdFrom(parentId)] } : {}) },
      });
    },
    async drive_create_file({ name, type, parentId, content, contentFormat }) {
      if (!name) throw new Error("name を指定してください");
      const target = type === "text" ? CONTENT_TYPES[contentFormat || "text"] : GOOGLE_MIME[type];
      if (!target) throw new Error("type は document / spreadsheet / presentation / text のどれかです");
      const meta = { name, mimeType: target, ...(parentId ? { parents: [fileIdFrom(parentId)] } : {}) };
      const params = qs({ supportsAllDrives: "true", fields: "id,name,mimeType,webViewLink" });
      if (content === undefined || content === "") return get(`${DRIVE}/files?${params}`, { method: "POST", body: meta });
      const fmt = contentFormat || { document: "markdown", spreadsheet: "csv" }[type] || "text";
      const boundary = `gws${crypto.randomUUID().replace(/-/g, "")}`;
      const rawBody = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${CONTENT_TYPES[fmt] || "text/plain"}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
      return get(`${UPLOAD}/files?uploadType=multipart&${params}`, { method: "POST", rawBody, contentType: `multipart/related; boundary=${boundary}` });
    },
    async drive_copy_file({ fileId, name, parentId }) {
      return get(`${DRIVE}/files/${fileIdFrom(fileId)}/copy?${qs({ supportsAllDrives: "true", fields: "id,name,mimeType,webViewLink" })}`, {
        method: "POST",
        body: { ...(name ? { name } : {}), ...(parentId ? { parents: [fileIdFrom(parentId)] } : {}) },
      });
    },
    async drive_update_file({ fileId, name, description, moveToFolderId }) {
      const id = fileIdFrom(fileId);
      const params = { supportsAllDrives: "true", fields: "id,name,parents,webViewLink" };
      if (moveToFolderId) {
        const cur = await get(`${DRIVE}/files/${id}?${qs({ fields: "parents", supportsAllDrives: "true" })}`);
        params.addParents = fileIdFrom(moveToFolderId);
        params.removeParents = (cur.parents || []).join(",");
      }
      const body = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      return get(`${DRIVE}/files/${id}?${qs(params)}`, { method: "PATCH", body });
    },
    async drive_list_permissions({ fileId }) {
      const out = await get(`${DRIVE}/files/${fileIdFrom(fileId)}/permissions?${qs({ supportsAllDrives: "true", fields: "permissions(id,type,role,emailAddress,domain,displayName)" })}`);
      return out.permissions || [];
    },

    // ---- スプレッドシート ----
    async sheets_append_values({ spreadsheetId, range, values, raw }) {
      if (!range) throw new Error("range を指定してください");
      if (!Array.isArray(values) || !values.every(Array.isArray)) throw new Error("values は行の配列（[[...], [...]]）で指定してください");
      const r = String(range).includes("!") ? range : `'${String(range).replace(/'/g, "''")}'`;
      const out = await get(
        `${SHEETS}/${fileIdFrom(spreadsheetId)}/values/${encodeURIComponent(r)}:append?${qs({ valueInputOption: raw ? "RAW" : "USER_ENTERED", insertDataOption: "INSERT_ROWS" })}`,
        { method: "POST", body: { majorDimension: "ROWS", values } },
      );
      return { updatedRange: out.updates?.updatedRange, updatedRows: out.updates?.updatedRows, updatedCells: out.updates?.updatedCells };
    },
    async sheets_clear_values({ spreadsheetId, range }) {
      if (!range || !String(range).includes("!")) throw new Error("range は「シート名!A2:H100」の形で指定してください");
      const out = await get(`${SHEETS}/${fileIdFrom(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`, { method: "POST", body: {} });
      return { clearedRange: out.clearedRange };
    },
    async sheets_add_sheet({ spreadsheetId, title, rows, columns }) {
      const id = fileIdFrom(spreadsheetId);
      const sheets = (await sheetTitles(id)).sheets || [];
      if (sheets.some((s) => s.properties.title === title)) throw new Error(`同じ名前のシートがすでにあります: ${title}`);
      const grid = rows || columns ? { gridProperties: { ...(rows ? { rowCount: rows } : {}), ...(columns ? { columnCount: columns } : {}) } } : {};
      const out = await get(`${SHEETS}/${id}:batchUpdate`, { method: "POST", body: { requests: [{ addSheet: { properties: { title, ...grid } } }] } });
      const p = out.replies?.[0]?.addSheet?.properties || {};
      return { title: p.title, gid: p.sheetId };
    },
    async sheets_batch_update({ spreadsheetId, requests }) {
      if (!Array.isArray(requests) || !requests.length) throw new Error("requests を 1 つ以上指定してください");
      if (requests.some((r) => r && ("deleteSheet" in r))) throw new Error("シートの削除（deleteSheet）はこのツールでは行いません。辻井さんに画面で消してもらってください。");
      const out = await get(`${SHEETS}/${fileIdFrom(spreadsheetId)}:batchUpdate`, { method: "POST", body: { requests } });
      return { replies: out.replies };
    },

    // ---- ドキュメント ----
    async docs_get_document({ documentId, maxChars }) {
      const d = await get(`${DOCS}/${fileIdFrom(documentId)}`);
      const lines = [];
      for (const el of d.body?.content || []) {
        if (el.paragraph) {
          const t = (el.paragraph.elements || []).map((e) => e.textRun?.content || "").join("").replace(/\n$/, "");
          const style = el.paragraph.paragraphStyle?.namedStyleType;
          lines.push(`[${el.startIndex}-${el.endIndex}]${style && style !== "NORMAL_TEXT" ? ` (${style})` : ""} ${t}`);
        } else if (el.table) lines.push(`[${el.startIndex}-${el.endIndex}] （表 ${el.table.rows}行×${el.table.columns}列）`);
      }
      return `# ${d.title}\n\n${clip(lines.join("\n"), maxChars || 50000)}`;
    },
    async docs_append_text({ documentId, text }) {
      await get(`${DOCS}/${fileIdFrom(documentId)}:batchUpdate`, { method: "POST", body: { requests: [{ insertText: { endOfSegmentLocation: {}, text } }] } });
      return "書き足しました";
    },
    async docs_insert_text({ documentId, index, text }) {
      await get(`${DOCS}/${fileIdFrom(documentId)}:batchUpdate`, { method: "POST", body: { requests: [{ insertText: { location: { index: Number(index) }, text } }] } });
      return `位置 ${index} に差し込みました`;
    },
    async docs_replace_text({ documentId, replacements, matchCase }) {
      const out = await get(`${DOCS}/${fileIdFrom(documentId)}:batchUpdate`, { method: "POST", body: { requests: replaceRequests(replacements, matchCase !== false) } });
      return { occurrencesChanged: countReplaced(out) };
    },
    async docs_batch_update({ documentId, requests }) {
      if (!Array.isArray(requests) || !requests.length) throw new Error("requests を 1 つ以上指定してください");
      const out = await get(`${DOCS}/${fileIdFrom(documentId)}:batchUpdate`, { method: "POST", body: { requests } });
      return { replies: out.replies };
    },

    // ---- スライド ----
    async slides_get_presentation({ presentationId }) {
      const p = await get(`${SLIDES}/${fileIdFrom(presentationId)}`);
      const textOf = (shape) => (shape?.text?.textElements || []).map((t) => t.textRun?.content || "").join("").trim();
      return {
        title: p.title,
        slides: (p.slides || []).map((s, i) => ({
          number: i + 1,
          objectId: s.objectId,
          elements: (s.pageElements || [])
            .map((e) => ({ objectId: e.objectId, text: textOf(e.shape) }))
            .filter((e) => e.text),
        })),
      };
    },
    async slides_replace_text({ presentationId, replacements }) {
      const out = await get(`${SLIDES}/${fileIdFrom(presentationId)}:batchUpdate`, { method: "POST", body: { requests: replaceRequests(replacements) } });
      return { occurrencesChanged: countReplaced(out) };
    },
    async slides_batch_update({ presentationId, requests }) {
      if (!Array.isArray(requests) || !requests.length) throw new Error("requests を 1 つ以上指定してください");
      const out = await get(`${SLIDES}/${fileIdFrom(presentationId)}:batchUpdate`, { method: "POST", body: { requests } });
      return { replies: out.replies };
    },

    // ---- Gmail ----
    async gmail_search({ query, max, pageToken }) {
      const n = Math.min(Math.max(Number(max) || 20, 1), 50);
      const out = await get(`${GMAIL}/messages?${qs({ q: query, maxResults: n, pageToken })}`);
      const msgs = await Promise.all(
        (out.messages || []).map((m) =>
          get(`${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`),
        ),
      );
      return { messages: msgs.map(summary), nextPageToken: out.nextPageToken };
    },
    async gmail_read_message({ messageId, maxChars }) {
      return readMessage(messageId, maxChars);
    },
    async gmail_read_thread({ threadId, maxChars }) {
      const t = await get(`${GMAIL}/threads/${encodeURIComponent(threadId)}?format=full`);
      return (t.messages || []).map((m) => {
        const { text, attachments } = bodyText(m.payload);
        return { ...summary(m), body: clip(text, maxChars || 8000), attachments };
      });
    },
    async gmail_get_attachment({ messageId, attachmentId }) {
      const m = await get(`${GMAIL}/messages/${encodeURIComponent(messageId)}?format=full`);
      const info = bodyText(m.payload).attachments.find((a) => a.attachmentId === attachmentId) || {};
      if (info.size > 5 * 1024 * 1024) throw new Error(`添付が大きすぎます（${info.size} バイト）`);
      const a = await get(`${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
      const bytes = fromB64url(a.data || "");
      if (/^text\/|json|csv|xml/.test(info.mimeType || "")) return { ...info, text: new TextDecoder().decode(bytes) };
      return { ...info, base64: b64(bytes) };
    },
    async gmail_list_labels() {
      const out = await get(`${GMAIL}/labels`);
      return (out.labels || []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
    },
    async gmail_modify_labels({ messageIds, add = [], remove = [] }) {
      if (!messageIds?.length) throw new Error("messageIds を指定してください");
      if (add.some((l) => DANGEROUS_LABELS.includes(l))) throw new Error("ゴミ箱・迷惑メールへの移動はこのツールでは行いません");
      await get(`${GMAIL}/messages/batchModify`, { method: "POST", body: { ids: messageIds, addLabelIds: add, removeLabelIds: remove } });
      return `${messageIds.length} 通のラベルを変えました`;
    },
    async gmail_create_draft({ to, cc, bcc, subject, body, html, replyToMessageId }) {
      const message = {};
      let mime = { to, cc, bcc, subject, body, html };
      if (replyToMessageId) {
        const o = await get(
          `${GMAIL}/messages/${encodeURIComponent(replyToMessageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Reply-To`,
        );
        const subj = header(o, "Subject");
        mime = {
          ...mime,
          to: list(to) ? to : header(o, "Reply-To") || header(o, "From"),
          subject: subject || (/^re:/i.test(subj) ? subj : `Re: ${subj}`),
          inReplyTo: header(o, "Message-ID"),
          references: header(o, "References"),
        };
        message.threadId = o.threadId;
      }
      message.raw = buildMime(mime);
      const d = await get(`${GMAIL}/drafts`, { method: "POST", body: { message } });
      return { draftId: d.id, messageId: d.message?.id, threadId: d.message?.threadId, note: "下書きを作りました（まだ送っていません）" };
    },
    async gmail_list_drafts({ max }) {
      const out = await get(`${GMAIL}/drafts?${qs({ maxResults: Math.min(Number(max) || 20, 50) })}`);
      return Promise.all(
        (out.drafts || []).map(async (d) => {
          const full = await get(`${GMAIL}/drafts/${d.id}?format=metadata`);
          return { draftId: d.id, ...summary(full.message || {}) };
        }),
      );
    },

    // ---- カレンダー ----
    async calendar_list_calendars() {
      const out = await get(`${CAL}/users/me/calendarList`);
      return (out.items || []).map((c) => ({ id: c.id, summary: c.summary, primary: !!c.primary, accessRole: c.accessRole }));
    },
    async calendar_list_events({ calendarId, timeMin, timeMax, query, max }) {
      const iso = (v) => {
        const w = when(v, "time");
        return w.date ? `${w.date}T00:00:00+09:00` : w.timeZone ? `${w.dateTime}+09:00` : w.dateTime;
      };
      const min = timeMin ? iso(timeMin) : new Date().toISOString();
      const max7 = timeMax ? iso(timeMax) : new Date(Date.parse(min) + 7 * 86400000).toISOString();
      const out = await get(
        `${CAL}/calendars/${cal(calendarId)}/events?${qs({ timeMin: min, timeMax: max7, q: query, singleEvents: "true", orderBy: "startTime", maxResults: Math.min(Number(max) || 50, 250), timeZone: TZ })}`,
      );
      return (out.items || []).map(eventSummary);
    },
    async calendar_create_event(a) {
      const body = { ...eventBody(a), ...meetData(a.meet) };
      if (!body.start || !body.end) throw new Error("start と end を指定してください");
      const e = await get(`${CAL}/calendars/${cal(a.calendarId)}/events?${qs({ sendUpdates: "none", conferenceDataVersion: a.meet ? 1 : undefined })}`, { method: "POST", body });
      return { ...eventSummary(e), meet: e.hangoutLink };
    },
    async calendar_update_event(a) {
      const e = await get(`${CAL}/calendars/${cal(a.calendarId)}/events/${encodeURIComponent(a.eventId)}?${qs({ sendUpdates: "none" })}`, { method: "PATCH", body: eventBody(a) });
      return eventSummary(e);
    },

    // ---- 送信・削除・共有（ALLOW_SEND のときだけ） ----
    async gmail_send_draft(a) {
      requireConfirmed(a, "メールの送信");
      const out = await get(`${GMAIL}/drafts/send`, { method: "POST", body: { id: a.draftId } });
      return { sent: true, messageId: out.id, threadId: out.threadId };
    },
    async gmail_trash_message(a) {
      requireConfirmed(a, "メールをゴミ箱に入れること");
      for (const id of a.messageIds || []) await get(`${GMAIL}/messages/${encodeURIComponent(id)}/trash`, { method: "POST", body: {} });
      return `${(a.messageIds || []).length} 通をゴミ箱に入れました`;
    },
    async drive_trash_file(a) {
      requireConfirmed(a, "ファイルをゴミ箱に入れること");
      const out = await get(`${DRIVE}/files/${fileIdFrom(a.fileId)}?${qs({ supportsAllDrives: "true", fields: "id,name,trashed" })}`, { method: "PATCH", body: { trashed: true } });
      return out;
    },
    async drive_share_file(a) {
      requireConfirmed(a, "共有");
      return get(
        `${DRIVE}/files/${fileIdFrom(a.fileId)}/permissions?${qs({ supportsAllDrives: "true", sendNotificationEmail: a.notify ? "true" : "false", emailMessage: a.notify ? a.message : undefined, fields: "id,role,emailAddress" })}`,
        { method: "POST", body: { type: "user", role: a.role, emailAddress: a.email } },
      );
    },
    async calendar_invite(a) {
      requireConfirmed(a, "予定への招待");
      if (!a.attendees?.length) throw new Error("attendees を指定してください");
      const path = `${CAL}/calendars/${cal(a.calendarId)}/events`;
      if (a.eventId) {
        const cur = await get(`${path}/${encodeURIComponent(a.eventId)}`);
        const have = new Set((cur.attendees || []).map((x) => x.email));
        const attendees = [...(cur.attendees || []), ...a.attendees.filter((m) => !have.has(m)).map((email) => ({ email }))];
        const e = await get(`${path}/${encodeURIComponent(a.eventId)}?${qs({ sendUpdates: "all" })}`, { method: "PATCH", body: { ...eventBody(a), attendees } });
        return eventSummary(e);
      }
      const body = { ...eventBody(a), ...meetData(a.meet), attendees: a.attendees.map((email) => ({ email })) };
      if (!body.start || !body.end) throw new Error("start と end を指定してください");
      const e = await get(`${path}?${qs({ sendUpdates: "all", conferenceDataVersion: a.meet ? 1 : undefined })}`, { method: "POST", body });
      return { ...eventSummary(e), meet: e.hangoutLink };
    },
    async calendar_delete_event(a) {
      requireConfirmed(a, "予定の削除");
      await get(`${CAL}/calendars/${cal(a.calendarId)}/events/${encodeURIComponent(a.eventId)}?${qs({ sendUpdates: "all" })}`, { method: "DELETE" });
      return "予定を消しました";
    },
  };

  const send = sendEnabled(env);
  const sendNames = new Set(sendDefinitions.map((d) => d.name));
  if (!send) for (const n of sendNames) delete handlers[n];
  return { definitions: send ? [...definitions, ...sendDefinitions] : definitions, handlers };
}
