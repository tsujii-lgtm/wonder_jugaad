// 模擬ジュガール API を立て、HTTP の MCP サーバー経由で呼べることを確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SPEC = new URL("./fixtures/sample-swagger.json", import.meta.url).pathname;

test("MCP 経由で模擬 API を呼べ、認証が効く", async (t) => {
  const seen: { url?: string; auth?: string } = {};
  const api = createHttpServer((req, res) => {
    seen.url = req.url;
    seen.auth = req.headers.authorization;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items: [{ id: 1, title: "出張申請" }] }));
  }).listen(0);
  await new Promise((r) => api.once("listening", r));
  t.after(() => {
    api.closeAllConnections();
    api.close();
  });

  const port = 18787 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      JUGAAD_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      JUGAAD_API_KEY: "dummy-key",
      JUGAAD_OPENAPI: SPEC,
      MCP_ACCESS_TOKEN: "secret123",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => proc.kill());
  await new Promise<void>((resolve) => proc.stderr!.on("data", (d) => String(d).includes("listening") && resolve()));

  const denied = await fetch(`http://127.0.0.1:${port}/mcp/wrong`, { method: "POST" });
  assert.equal(denied.status, 401);

  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/secret123`)));
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.ok(tools.some((x) => x.name === "listapplications"));
  assert.ok(!tools.some((x) => x.name === "createapplication"), "既定は読み取り専用");

  const res: any = await client.callTool({ name: "listapplications", arguments: { status: "pending" } });
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /出張申請/);
  assert.equal(seen.url, "/api/v1/applications?status=pending");
  assert.equal(seen.auth, "Bearer dummy-key");

  const blocked: any = await client.callTool({ name: "jugaad_api_request", arguments: { method: "POST", path: "/x" } });
  assert.equal(blocked.isError, true);
});
