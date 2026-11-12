import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { jstDate, normalizeDate } from "../src/line.js";

const SECRET = "s3cret-0123456789abcdef";
const env = { MCP_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: "tok", LINE_ACCOUNT_LABEL: "エミット" };
const seen = [];

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  seen.push({ u, init });
  assert.equal(init.method ?? "GET", "GET");
  assert.equal(init.headers.Authorization, "Bearer tok");
  if (u.pathname === "/v2/bot/info") return Response.json({ displayName: "エミット", basicId: "@abc" });
  if (u.pathname === "/v2/bot/insight/followers") {
    const n = Number(u.searchParams.get("date").slice(6));
    return Response.json({ status: "ready", followers: 100 + n * 3, targetedReaches: 90 + n * 2, blocks: 5 + n });
  }
  if (u.pathname === "/v2/bot/message/quota") return Response.json({ type: "limited", value: 200 });
  if (u.pathname === "/v2/bot/message/quota/consumption") return Response.json({ totalUsage: 12 });
  if (u.pathname === "/v2/bot/insight/demographic") return Response.json({ message: "Authentication failed" }, { status: 401 });
  return new Response("unexpected", { status: 500 });
};

const rpc = (body, secret = SECRET) =>
  worker.fetch(new Request(`https://x.dev/mcp/${secret}`, { method: "POST", body: JSON.stringify(body) }), env);
const call = async (name, args = {}) => (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()).result;

test("wrong secret is 404", async () => {
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "nope-0123456789abcd")).status, 404);
});

test("initialize and tools/list", async () => {
  const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.match(init.result.instructions, /エミット/);
  const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.ok(list.result.tools.some((t) => t.name === "line_followers_daily"));
  assert.ok(list.result.tools.every((t) => !("run" in t)));
});

test("followers_daily computes day-over-day changes", async () => {
  const r = await call("line_followers_daily", { from: "2026-11-01", to: "2026-11-03" });
  const data = JSON.parse(r.content[0].text);
  assert.equal(data.rows.length, 3);
  assert.equal(data.rows[0].newFollowers, undefined);
  assert.equal(data.rows[1].newFollowers, 3);
  assert.equal(data.rows[2].newBlocks, 1);
  assert.equal(data.rows[2].reachChange, 2);
});

test("quota merges two endpoints", async () => {
  const data = JSON.parse((await call("line_message_quota")).content[0].text);
  assert.equal(data.quota.value, 200);
  assert.equal(data.consumption.totalUsage, 12);
});

test("API errors come back as tool errors", async () => {
  const r = await call("line_demographic");
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /401/);
});

test("dates", () => {
  assert.equal(jstDate(0, new Date("2026-11-12T16:00:00Z")), "20261113");
  assert.equal(normalizeDate("2026/11/05"), "20261105");
  assert.throws(() => normalizeDate("11月5日"));
});

test("range over 31 days is refused", async () => {
  const r = await call("line_followers_daily", { from: "2026-09-01", to: "2026-11-01" });
  assert.equal(r.isError, true);
});
