import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { resetTokenCache } from "../src/google.js";
import { buildMime } from "../src/gws.js";

const SECRET = "s3cret-0123456789abcdef";
const SHEET = "1EzS-a914o-wQrZFsbtiyugY4Zsco5vRoTUFxEH4eT0c";
const calls = [];
const b64url = (s) => Buffer.from(s).toString("base64url");

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = init.body && typeof init.body === "string" && init.headers?.["content-type"] === "application/json" ? JSON.parse(init.body) : init.body;
  calls.push({ url: u, method: init.method || "GET", body, headers: init.headers });
  if (u.host === "oauth2.googleapis.com") return Response.json({ access_token: "at-1", expires_in: 3600 });
  const p = u.pathname;
  if (p === `/v4/spreadsheets/${SHEET}`) return Response.json({ properties: { title: "B型 作業リスト" }, sheets: [{ properties: { sheetId: 0, title: "リスト" } }] });
  if (p.startsWith(`/v4/spreadsheets/${SHEET}/values/`) && p.endsWith(":append"))
    return Response.json({ updates: { updatedRange: "リスト!A5:C6", updatedRows: body.values.length, updatedCells: body.values.flat().length } });
  if (p === `/v4/spreadsheets/${SHEET}:batchUpdate`) return Response.json({ replies: [{ addSheet: { properties: { sheetId: 7, title: body.requests[0].addSheet?.properties.title } } }] });
  if (p === "/upload/drive/v3/files") return Response.json({ id: "new1", name: "議事録", mimeType: "application/vnd.google-apps.document" });
  if (p === "/drive/v3/files/file0000001" && init.method === "GET") return Response.json({ parents: ["oldParent00"] });
  if (p === "/drive/v3/files/file0000001" && init.method === "PATCH") return Response.json({ id: "file0000001", q: Object.fromEntries(u.searchParams) });
  if (p === "/v1/documents/doc00000001:batchUpdate") return Response.json({ replies: body.requests.map(() => ({ replaceAllText: { occurrencesChanged: 2 } })) });
  if (p === "/gmail/v1/users/me/messages") return Response.json({ messages: [{ id: "m1" }] });
  if (p === "/gmail/v1/users/me/messages/m1" && u.searchParams.get("format") === "metadata")
    return Response.json({
      id: "m1",
      threadId: "t1",
      snippet: "こんにちは",
      payload: { headers: [{ name: "Subject", value: "見積もりの件" }, { name: "From", value: "JQA <info@jqa.jp>" }, { name: "Message-ID", value: "<abc@jqa.jp>" }] },
    });
  if (p === "/gmail/v1/users/me/messages/m1")
    return Response.json({
      id: "m1",
      threadId: "t1",
      payload: {
        headers: [{ name: "Subject", value: "見積もりの件" }],
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("本文です") } },
          { mimeType: "application/pdf", filename: "見積.pdf", body: { attachmentId: "att1", size: 100 } },
        ],
      },
    });
  if (p === "/gmail/v1/users/me/drafts" && init.method === "POST") return Response.json({ id: "d1", message: { id: "m9", threadId: body.message.threadId } });
  if (p === "/gmail/v1/users/me/drafts/send") return Response.json({ id: "m9", threadId: "t1" });
  if (p === "/calendar/v3/calendars/primary/events" && init.method === "POST") return Response.json({ id: "e1", ...body, htmlLink: "https://cal/e1" });
  return new Response(`unexpected ${init.method} ${u}`, { status: 500 });
};

const env = {
  MCP_SECRET: SECRET,
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csecret",
  GOOGLE_REFRESH_TOKEN: "rt",
  GOOGLE_ACCOUNT: "tsujii.k@resow.co.jp",
  WORKER_ENV: "resow",
  GWS_FULL: "true",
  ALLOW_SEND: "true",
};
const noSend = { ...env, ALLOW_SEND: "false" };

beforeEach(() => {
  calls.length = 0;
  resetTokenCache();
});

async function rpc(body, e = env) {
  const res = await worker.fetch(new Request(`https://w.example/mcp/${SECRET}`, { method: "POST", body: JSON.stringify(body) }), e);
  return res.json();
}
const call = async (name, args, e = env) => (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, e)).result;
const parse = (r) => {
  assert.ok(!r.isError, r.content[0].text);
  return JSON.parse(r.content[0].text);
};
const names = async (e) => (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, e)).result.tools.map((t) => t.name);

test("tools: full GWS set, send tools only with ALLOW_SEND", async () => {
  const all = await names(env);
  for (const n of ["sheets_update_values", "sheets_append_values", "docs_append_text", "slides_replace_text", "gmail_create_draft", "calendar_create_event", "gmail_send_draft", "drive_trash_file"])
    assert.ok(all.includes(n), n);
  assert.equal(new Set(all).size, all.length);
  const safe = await names(noSend);
  assert.ok(!safe.includes("gmail_send_draft"));
  assert.ok(safe.includes("gmail_create_draft"));
  const r = await call("gmail_send_draft", { draftId: "d1", confirmed: true }, noSend);
  assert.match(r.content[0].text, /不明なツール/);
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.match(init.result.instructions, /Gmail/);
});

test("auth asks for all Workspace scopes", async () => {
  const res = await worker.fetch(new Request(`https://w.example/auth/${SECRET}`), env);
  const scope = new URL(res.headers.get("location")).searchParams.get("scope").split(" ");
  for (const s of ["drive", "spreadsheets", "documents", "presentations", "gmail.modify", "calendar"]) assert.ok(scope.includes(`https://www.googleapis.com/auth/${s}`), s);
});

test("sheets_append_values appends rows below existing data", async () => {
  const out = parse(await call("sheets_append_values", { spreadsheetId: `https://docs.google.com/spreadsheets/d/${SHEET}/edit`, range: "リスト", values: [["a", 1], ["b", 2]] }));
  assert.equal(out.updatedRows, 2);
  const c = calls.find((x) => x.url.pathname.endsWith(":append"));
  assert.equal(decodeURIComponent(c.url.pathname.split("/values/")[1]), "'リスト':append");
  assert.equal(c.url.searchParams.get("insertDataOption"), "INSERT_ROWS");
});

test("sheets_add_sheet and batch_update refuses deleteSheet", async () => {
  assert.deepEqual(parse(await call("sheets_add_sheet", { spreadsheetId: SHEET, title: "11月" })), { title: "11月", gid: 7 });
  assert.match((await call("sheets_add_sheet", { spreadsheetId: SHEET, title: "リスト" })).content[0].text, /すでにあります/);
  assert.ok((await call("sheets_batch_update", { spreadsheetId: SHEET, requests: [{ deleteSheet: { sheetId: 0 } }] })).isError);
});

test("drive_create_file uploads markdown as a Google Doc", async () => {
  parse(await call("drive_create_file", { name: "議事録", type: "document", content: "# 見出し\n本文", parentId: "https://drive.google.com/drive/folders/folder000001" }));
  const c = calls.find((x) => x.url.pathname === "/upload/drive/v3/files");
  assert.equal(c.url.searchParams.get("uploadType"), "multipart");
  assert.match(c.headers["content-type"], /^multipart\/related; boundary=/);
  assert.match(c.body, /"mimeType":"application\/vnd.google-apps.document"/);
  assert.match(c.body, /"parents":\["folder000001"\]/);
  assert.match(c.body, /Content-Type: text\/markdown/);
});

test("drive_update_file moves between folders", async () => {
  const out = parse(await call("drive_update_file", { fileId: "file0000001", name: "新しい名前", moveToFolderId: "newParent00" }));
  assert.equal(out.q.addParents, "newParent00");
  assert.equal(out.q.removeParents, "oldParent00");
});

test("docs_replace_text counts replacements", async () => {
  const out = parse(await call("docs_replace_text", { documentId: "doc00000001", replacements: [{ find: "{{名前}}", replace: "石橋" }] }));
  assert.deepEqual(out.occurrencesChanged, [2]);
});

test("gmail search, read and reply draft", async () => {
  const s = parse(await call("gmail_search", { query: "from:jqa.jp" }));
  assert.equal(s.messages[0].subject, "見積もりの件");
  const m = parse(await call("gmail_read_message", { messageId: "m1" }));
  assert.equal(m.body, "本文です");
  assert.equal(m.attachments[0].filename, "見積.pdf");

  const d = parse(await call("gmail_create_draft", { body: "承知しました", replyToMessageId: "m1" }));
  assert.equal(d.draftId, "d1");
  assert.equal(d.threadId, "t1");
  const raw = Buffer.from(calls.find((x) => x.url.pathname.endsWith("/drafts")).body.message.raw, "base64url").toString();
  assert.match(raw, /To: JQA <info@jqa.jp>/);
  assert.match(raw, /In-Reply-To: <abc@jqa.jp>/);
  const subj = raw.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1];
  assert.equal(Buffer.from(subj, "base64").toString(), "Re: 見積もりの件");
});

test("buildMime refuses header injection", () => {
  assert.throws(() => buildMime({ to: ["a@b.c\r\nBcc: x@y.z"], body: "x" }));
});

test("send needs confirmed: true", async () => {
  const no = await call("gmail_send_draft", { draftId: "d1" });
  assert.ok(no.isError);
  assert.match(no.content[0].text, /OK/);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/drafts/send")).length, 0);
  assert.deepEqual(parse(await call("gmail_send_draft", { draftId: "d1", confirmed: true })), { sent: true, messageId: "m9", threadId: "t1" });
});

test("calendar_create_event uses Tokyo time and never notifies", async () => {
  const e = parse(await call("calendar_create_event", { summary: "面談", start: "2026-11-20T10:00", end: "2026-11-20T11:00" }));
  assert.equal(e.start, "2026-11-20T10:00:00");
  const c = calls.find((x) => x.url.pathname.endsWith("/events"));
  assert.equal(c.body.start.timeZone, "Asia/Tokyo");
  assert.equal(c.url.searchParams.get("sendUpdates"), "none");
  assert.equal(c.body.attendees, undefined);
  const allDay = parse(await call("calendar_create_event", { summary: "休み", start: "2026-11-21", end: "2026-11-22" }));
  assert.equal(allDay.start, "2026-11-21");
});
