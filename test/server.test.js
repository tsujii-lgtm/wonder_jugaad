import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { buildRequest, operationsFromSpec } from "../src/openapi.js";

const SECRET = "s3cret-0123456789abcdef";
const SPEC = JSON.parse(readFileSync(new URL("./fixtures/sample-swagger.json", import.meta.url), "utf8"));
const calls = [];

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host === "spec.example") return Response.json(SPEC);
  calls.push({ method: init.method, url: u.pathname + u.search, auth: init.headers?.Authorization, body: init.body });
  if (u.pathname === "/api/v1/applications") return Response.json({ items: [{ id: 1, title: "出張申請" }] });
  return new Response("not found", { status: 404 });
};

const env = {
  MCP_SECRET: SECRET,
  JUGAAD_API_KEY: "dummy-key",
  JUGAAD_BASE_URL: "https://jugaad.example",
  JUGAAD_OPENAPI_URL: "https://spec.example/swagger.json",
};
async function rpc(body, path = `/mcp/${SECRET}`, e = env) {
  const res = await worker.fetch(new Request("https://x.example" + path, { method: "POST", body: JSON.stringify(body) }), e);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}
const call = async (name, args, e = env) =>
  (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, `/mcp/${SECRET}`, e)).body.result;

test("wrong secret is 404, short secret is 500", async () => {
  assert.equal((await rpc({}, "/mcp/wrong")).status, 404);
  assert.equal((await rpc({}, "/mcp/short", { MCP_SECRET: "short" })).status, 500);
});

test("initialize, notification and tools/list（既定は読み取り専用）", async () => {
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const names = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools.map((t) => t.name);
  assert.ok(names.includes("listapplications") && names.includes("jugaad_api_request"));
  assert.ok(!names.includes("createapplication"));
});

test("APIキーが無ければツールは出ない", async () => {
  const names = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, `/mcp/${SECRET}`, { MCP_SECRET: SECRET })).body.result.tools;
  assert.deepEqual(names, []);
});

test("自動生成ツールが認証つきで API を呼ぶ", async () => {
  const r = await call("listapplications", { status: "pending" });
  assert.match(r.content[0].text, /出張申請/);
  const last = calls.at(-1);
  assert.equal(last.url, "/api/v1/applications?status=pending");
  assert.equal(last.auth, "Bearer dummy-key");
});

test("X-API-KEY 方式にも切り替えられる", async () => {
  const e = { ...env, JUGAAD_AUTH_HEADER: "X-API-KEY", JUGAAD_AUTH_SCHEME: "" };
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => (seen.push(init.headers), orig(url, init));
  await call("jugaad_api_request", { method: "GET", path: "/api/v1/applications" }, e);
  globalThis.fetch = orig;
  assert.equal(seen.at(-1)["X-API-KEY"], "dummy-key");
});

test("書き込みは既定で拒否され、許可すると POST できる", async () => {
  const denied = await call("jugaad_api_request", { method: "POST", path: "/api/v1/applications", body: { title: "x" } });
  assert.equal(denied.isError, true);
  const e = { ...env, JUGAAD_ALLOW_WRITE: "true" };
  const names = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, `/mcp/${SECRET}`, e)).body.result.tools.map((t) => t.name);
  assert.ok(names.includes("createapplication"));
  await call("jugaad_api_request", { method: "POST", path: "/api/v1/applications", body: { title: "x" } }, e);
  assert.equal(calls.at(-1).method, "POST");
});

test("API エラーはツールエラーとして返る", async () => {
  const r = await call("jugaad_api_request", { method: "GET", path: "/nope" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /404/);
});

test("Swagger の $ref・循環参照・パス引数を扱える", () => {
  const ops = operationsFromSpec(SPEC, { allowWrite: true });
  const create = ops.find((o) => o.toolName === "createapplication");
  assert.deepEqual(create.inputSchema.required, ["body"]);
  assert.ok(JSON.stringify(create.inputSchema).length < 20000);
  const detail = ops.find((o) => o.path === "/api/v1/applications/{id}");
  assert.equal(buildRequest(detail, { id: 42 }).path, "/api/v1/applications/42");
});
