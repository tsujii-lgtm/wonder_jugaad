// 模擬 Google API でスプレッドシートのツールを確かめる（本物の Google には繋がない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createSheetsTools, loadSheetsConfig, spreadsheetId } from "../src/google/sheets.js";

test("URL から ID を取り出せる", () => {
  assert.equal(spreadsheetId("https://docs.google.com/spreadsheets/d/AbC-123_x/edit#gid=0"), "AbC-123_x");
  assert.equal(spreadsheetId(" AbC-123_x "), "AbC-123_x");
});

test("認証情報がなければ無効、あれば既定は読み取り専用", () => {
  assert.equal(loadSheetsConfig({}), undefined);
  assert.equal(loadSheetsConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: "{}" })!.allowWrite, false);
});

test("一覧・メタデータ・値の取得と、書き込み制御", async (t) => {
  const seen: { method?: string; url?: string; auth?: string }[] = [];
  const api = createHttpServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url!.startsWith("/drive/files")) return void res.end(JSON.stringify({ files: [{ id: "S1", name: "顧客リスト" }] }));
    if (req.url!.includes("/values/")) return void res.end(JSON.stringify({ values: [["名前", "金額"], ["A社", "100"]] }));
    if (req.url!.startsWith("/sheets/spreadsheets/missing")) {
      res.statusCode = 404;
      return void res.end(JSON.stringify({ error: { message: "not found" } }));
    }
    res.end(JSON.stringify({ properties: { title: "顧客リスト" } }));
  }).listen(0);
  await new Promise((r) => api.once("listening", r));
  t.after(() => {
    api.closeAllConnections();
    api.close();
  });
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const cfg = { allowWrite: false, sheetsBase: `${base}/sheets`, driveBase: `${base}/drive` };

  const ro = createSheetsTools(cfg, async () => "tok");
  assert.ok(!ro.definitions.some((d) => d.name === "sheets_update_values"), "読み取り専用では書き込みツールを出さない");

  const list: any = await ro.call("sheets_list_spreadsheets", { name_contains: "顧客" });
  assert.equal(list.files[0].name, "顧客リスト");
  assert.match(decodeURIComponent(seen[0].url!), /name contains '顧客'/);
  assert.equal(seen[0].auth, "Bearer tok");

  const vals: any = await ro.call("sheets_get_values", { spreadsheet: "https://docs.google.com/spreadsheets/d/S1/edit", range: "Sheet1!A1:B2" });
  assert.deepEqual(vals.values[1], ["A社", "100"]);
  assert.match(seen[1].url!, /spreadsheets\/S1\/values\/Sheet1!A1%3AB2$|spreadsheets\/S1\/values\/Sheet1!A1:B2$/);

  await assert.rejects(ro.call("sheets_get_spreadsheet", { spreadsheet: "missing" }), /共有されているか/);
  await assert.rejects(ro.call("sheets_update_values", { spreadsheet: "S1", range: "A1", values: [[1]] }), /許可されていません/);

  const rw = createSheetsTools({ ...cfg, allowWrite: true }, async () => "tok");
  await rw.call("sheets_update_values", { spreadsheet: "S1", range: "A1", values: [[1]] });
  assert.equal(seen.at(-1)!.method, "PUT");
});
