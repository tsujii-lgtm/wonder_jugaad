import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import worker from "../src/index.js";
import { splitText, resetTokenCache } from "../src/lineworks.js";

const SECRET = "s3cret-0123456789abcdef";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  MCP_SECRET: SECRET,
  LW_CLIENT_ID: "cid",
  LW_CLIENT_SECRET: "csec",
  LW_SERVICE_ACCOUNT: "sa@example",
  LW_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
  LW_BOT_ID: "123",
  LW_ALLOWED_CHANNEL_IDS: "ch-a,ch-b",
};
const seen = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  seen.push({ u, init });
  if (u.hostname === "auth.worksmobile.com") {
    const p = new URLSearchParams(init.body);
    assert.equal(p.get("scope"), "bot");
    assert.equal(p.get("assertion").split(".").length, 3);
    return Response.json({ access_token: "tok", expires_in: 86400 });
  }
  assert.equal(init.headers.Authorization, "Bearer tok");
  if (u.pathname === "/v1.0/bots/123" && (init.method ?? "GET") === "GET") return Response.json({ botName: "お仕事Bot" });
  if (u.pathname.startsWith("/v1.0/bots/123/channels/") && init.method === "POST") return new Response(null, { status: 201 });
  if (u.pathname === "/v1.0/bots/123/channels" && init.method === "POST") return Response.json({ channelId: "new-ch" });
  return new Response("unexpected", { status: 500 });
};

const rpc = (body, e = env, secret = SECRET) =>
  worker.fetch(new Request(`https://x.dev/mcp/${secret}`, { method: "POST", body: JSON.stringify(body) }), e);
const call = async (name, args = {}, e = env) =>
  (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, e)).json()).result;

test("wrong secret is 404", async () => {
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, env, "nope-0123456789abcd")).status, 404);
});

test("tools/list", async () => {
  const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["lineworks_create_channel", "lineworks_list_targets", "lineworks_send_message"]);
});

test("send to default channel with signed JWT", async () => {
  resetTokenCache();
  seen.length = 0;
  const r = await call("lineworks_send_message", { text: "こんにちは" });
  assert.ok(!r.isError, r.content[0].text);
  const post = seen.find((s) => s.u.pathname.includes("/channels/ch-a/messages"));
  assert.deepEqual(JSON.parse(post.init.body), { content: { type: "text", text: "こんにちは" } });
});

test("refuses channels not allowed", async () => {
  const r = await call("lineworks_send_message", { text: "x", channelId: "other" });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /送れません/);
});

test("long text is split", async () => {
  seen.length = 0;
  const r = await call("lineworks_send_message", { text: ("あ".repeat(100) + "\n").repeat(45) });
  assert.equal(JSON.parse(r.content[0].text).messages, 3);
  assert.ok(splitText("a".repeat(4500)).every((c) => c.length <= 2000));
});

test("create channel is off by default", async () => {
  assert.ok((await call("lineworks_create_channel", { title: "t", members: ["a@b"] })).isError);
  const r = await call("lineworks_create_channel", { title: "t", members: ["a@b"] }, { ...env, LW_ALLOW_CREATE_CHANNEL: "true" });
  assert.equal(JSON.parse(r.content[0].text).channelId, "new-ch");
});

test("missing settings are reported", async () => {
  const r = await call("lineworks_list_targets", {}, { MCP_SECRET: SECRET });
  assert.match(r.content[0].text, /設定が足りません/);
});
