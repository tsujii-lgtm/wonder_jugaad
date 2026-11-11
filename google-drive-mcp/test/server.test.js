import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { fileIdFrom, resetTokenCache } from "../src/google.js";

const SECRET = "s3cret-0123456789abcdef";
const SHEET_ID = "1Kmf45BSB5PHeY2_mC-IZTEYLsKI1YZYUHf-63em_Bl8";
const calls = [];

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  calls.push({ url: u, init });
  if (u.host === "oauth2.googleapis.com") {
    const body = new URLSearchParams(init.body);
    if (body.get("grant_type") === "refresh_token") return Response.json({ access_token: "at-1", expires_in: 3600 });
    if (body.get("code") === "good") return Response.json({ refresh_token: "rt-new<x>" });
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }
  assert.equal(init.headers?.Authorization, "Bearer at-1");
  if (u.pathname === `/v4/spreadsheets/${SHEET_ID}`)
    return Response.json({
      properties: { title: "03.コア会議" },
      sheets: [
        { properties: { sheetId: 1, title: "進行台本", gridProperties: { rowCount: 30, columnCount: 5 } } },
        { properties: { sheetId: 2, title: "決定事項", gridProperties: { rowCount: 50, columnCount: 9 } } },
      ],
    });
  if (u.pathname === `/v4/spreadsheets/${SHEET_ID}/values:batchGet`)
    return Response.json({ valueRanges: u.searchParams.getAll("ranges").map((r) => ({ range: r, values: [["No", "項目"]] })) });
  if (u.pathname.startsWith(`/v4/spreadsheets/${SHEET_ID}/values/`) && init.method === "PUT") {
    const body = JSON.parse(init.body);
    return Response.json({ updatedRange: body.range, updatedRows: body.values.length, updatedColumns: body.values[0].length, updatedCells: body.values.flat().length, input: u.searchParams.get("valueInputOption") });
  }
  if (u.pathname === `/v4/spreadsheets/${SHEET_ID}:batchUpdate` && init.method === "POST") {
    const dup = JSON.parse(init.body).requests[0].duplicateSheet;
    return Response.json({ replies: [{ duplicateSheet: { properties: { sheetId: 99, title: dup.newSheetName, index: dup.insertSheetIndex } } }] });
  }
  if (u.pathname === "/drive/v3/files") return Response.json({ files: [{ id: "f1", name: "就業規則" }], q: u.searchParams.get("q") });
  if (u.pathname === "/drive/v3/files/doc1aaaaaaaa") return Response.json({ id: "doc1", name: "規程", mimeType: "application/vnd.google-apps.document" });
  if (u.pathname === "/drive/v3/files/doc1aaaaaaaa/export") return new Response("第1条 目的");
  if (u.pathname === "/drive/v3/files/pdf1aaaaaaaa") return Response.json({ id: "pdf1", name: "a.pdf", mimeType: "application/pdf" });
  if (u.pathname === "/drive/v3/files/missing0000") return Response.json({ error: { message: "File not found" } }, { status: 404 });
  return new Response("unexpected", { status: 500 });
};

const env = {
  MCP_SECRET: SECRET,
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csecret",
  GOOGLE_REFRESH_TOKEN: "rt",
  GOOGLE_ACCOUNT: "tsujii.k@resow.co.jp",
  WORKER_ENV: "resow",
};

beforeEach(() => {
  calls.length = 0;
  resetTokenCache();
});

const req = (path, init) => worker.fetch(new Request("https://w.example" + path, init), env);
async function rpc(body, e = env) {
  const res = await worker.fetch(new Request(`https://w.example/mcp/${SECRET}`, { method: "POST", body: JSON.stringify(body) }), e);
  return res.status === 200 ? res.json() : { status: res.status };
}
const call = async (name, args) => (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result;
const parse = (r) => JSON.parse(r.content[0].text);

test("wrong secret is 404", async () => {
  assert.equal((await req("/mcp/wrong", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await req("/auth/wrong")).status, 404);
});

test("tools/list: 7 read-only tools, none without credentials", async () => {
  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(list.result.tools.length, 7);
  const empty = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { MCP_SECRET: SECRET });
  assert.equal(empty.result.tools.length, 0);
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.match(init.result.instructions, /resow/);
});

test("fileIdFrom accepts share links and ids", () => {
  assert.equal(fileIdFrom(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing`), SHEET_ID);
  assert.equal(fileIdFrom("https://drive.google.com/drive/folders/1ckhRiy7AFHLhzK142ccA9vJL-FBj6jev"), "1ckhRiy7AFHLhzK142ccA9vJL-FBj6jev");
  assert.throws(() => fileIdFrom("hello world"));
});

test("sheets_get_spreadsheet and sheets_get_values (all sheets when range omitted)", async () => {
  const meta = parse(await call("sheets_get_spreadsheet", { spreadsheetId: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` }));
  assert.equal(meta.title, "03.コア会議");
  assert.deepEqual(meta.sheets.map((s) => s.title), ["進行台本", "決定事項"]);

  const all = parse(await call("sheets_get_values", { spreadsheetId: SHEET_ID }));
  assert.deepEqual(all.map((v) => v.range), ["'進行台本'", "'決定事項'"]);
  const one = parse(await call("sheets_get_values", { spreadsheetId: SHEET_ID, range: "決定事項!A1:H10" }));
  assert.equal(one[0].range, "決定事項!A1:H10");
  // the access token is fetched once and reused
  assert.equal(calls.filter((c) => c.url.host === "oauth2.googleapis.com").length, 1);
});

test("drive_search_files builds a safe query", async () => {
  const out = parse(await call("drive_search_files", { query: "就業's規則", type: "folder" }));
  assert.equal(out.q, "trashed = false and (name contains '就業\\'s規則' or fullText contains '就業\\'s規則') and mimeType = 'application/vnd.google-apps.folder'");
});

test("drive_read_file exports Docs as text and explains unsupported types", async () => {
  const doc = await call("drive_read_file", { fileId: "https://docs.google.com/document/d/doc1aaaaaaaa/edit" });
  assert.ok(!doc.isError);
  assert.match(doc.content[0].text, /規程[\s\S]*第1条 目的/);
  const pdf = await call("drive_read_file", { fileId: "pdf1aaaaaaaa" });
  assert.match(pdf.content[0].text, /文字で読めない形式/);
});

test("404 gives a hint about sharing", async () => {
  const r = await call("drive_get_file", { fileId: "missing0000" });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /共有されていない/);
});

test("auth redirects to Google with offline access", async () => {
  const res = await req(`/auth/${SECRET}`);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location"));
  assert.equal(loc.host, "accounts.google.com");
  assert.equal(loc.searchParams.get("access_type"), "offline");
  assert.equal(loc.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.readonly");
  assert.equal(loc.searchParams.get("redirect_uri"), "https://w.example/oauth/callback");
  assert.equal(loc.searchParams.get("login_hint"), "tsujii.k@resow.co.jp");

  const state = loc.searchParams.get("state");
  assert.equal((await req(`/oauth/callback?code=good&state=bad`)).status, 404);
  const ok = await req(`/oauth/callback?code=good&state=${state}`);
  assert.equal(ok.status, 200);
  const page = await ok.text();
  assert.match(page, /rt-new&lt;x&gt;/);
  assert.match(page, /--env resow/);
  const bad = await req(`/oauth/callback?code=nope&state=${state}`);
  assert.equal(bad.status, 400);
});

const writeEnv = { ...env, GOOGLE_ACCOUNT: "tsujii.k@unistep.co.jp", WORKER_ENV: "unistep", ALLOW_SHEETS_WRITE: "true" };
const callW = async (name, args) =>
  (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, writeEnv)).result;

test("write tools only appear when ALLOW_SHEETS_WRITE is true", async () => {
  const ro = await call("sheets_update_values", { spreadsheetId: SHEET_ID, range: "決定事項!A1", values: [["x"]] });
  assert.ok(ro.isError);
  assert.match(ro.content[0].text, /不明なツール/);
  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, writeEnv);
  assert.equal(list.result.tools.length, 9);
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, writeEnv);
  assert.match(init.result.instructions, /書き込み/);
});

test("sheets_update_values writes with USER_ENTERED and validates input", async () => {
  const out = parse(await callW("sheets_update_values", { spreadsheetId: SHEET_ID, range: "決定事項!A2:C3", values: [["安達", 13, 19500], ["角川", 17, "=B3*1500"]] }));
  assert.deepEqual(out, { updatedRange: "決定事項!A2:C3", updatedRows: 2, updatedColumns: 3, updatedCells: 6 });
  const put = calls.find((c) => c.init.method === "PUT");
  assert.equal(put.url.searchParams.get("valueInputOption"), "USER_ENTERED");
  assert.ok((await callW("sheets_update_values", { spreadsheetId: SHEET_ID, range: "A1", values: [["x"]] })).isError);
  assert.ok((await callW("sheets_update_values", { spreadsheetId: SHEET_ID, range: "決定事項!A1", values: ["x"] })).isError);
});

test("sheets_duplicate_sheet copies a tab next to the source", async () => {
  const out = parse(await callW("sheets_duplicate_sheet", { spreadsheetId: SHEET_ID, sourceSheet: "進行台本", newTitle: "進行台本(10月)" }));
  assert.deepEqual(out, { title: "進行台本(10月)", gid: 99 });
  const dupErr = await callW("sheets_duplicate_sheet", { spreadsheetId: SHEET_ID, sourceSheet: "進行台本", newTitle: "決定事項" });
  assert.match(dupErr.content[0].text, /すでにあります/);
  const missing = await callW("sheets_duplicate_sheet", { spreadsheetId: SHEET_ID, sourceSheet: "ない", newTitle: "x" });
  assert.match(missing.content[0].text, /見つかりません/);
});

test("auth asks for the spreadsheets scope only when writing is enabled", async () => {
  const res = await worker.fetch(new Request(`https://w.example/auth/${SECRET}`), writeEnv);
  const scope = new URL(res.headers.get("location")).searchParams.get("scope");
  assert.equal(scope, "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets");
});
