import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, loadSpec, operationsFromSpec } from "../src/openapi.js";

const SPEC = new URL("./fixtures/sample-swagger.json", import.meta.url).pathname;

test("読み取り専用では GET だけがツールになる", async () => {
  const ops = operationsFromSpec(await loadSpec(SPEC), { allowWrite: false });
  assert.deepEqual(ops.map((o) => o.toolName).sort(), ["get_api_v1_applications_by_id", "listapplications"]);
});

test("書き込み許可で POST が増え、$ref と循環参照が展開される", async () => {
  const ops = operationsFromSpec(await loadSpec(SPEC), { allowWrite: true });
  const create = ops.find((o) => o.toolName === "createapplication")!;
  assert.equal(create.method, "POST");
  assert.deepEqual(create.inputSchema.required, ["body"]);
  assert.equal(create.inputSchema.properties.body.properties.title.type, "string");
  assert.ok(JSON.stringify(create.inputSchema).length < 20000);
});

test("引数がパス・クエリ・ボディに振り分けられる", async () => {
  const ops = operationsFromSpec(await loadSpec(SPEC), { allowWrite: true });
  const detail = ops.find((o) => o.path === "/api/v1/applications/{id}")!;
  assert.equal(buildRequest(detail, { id: 42 }).path, "/api/v1/applications/42");
  const list = ops.find((o) => o.toolName === "listapplications")!;
  assert.deepEqual(buildRequest(list, { status: "pending" }).query, { status: "pending" });
});

test("OpenAPI 3 の requestBody を扱える", () => {
  const ops = operationsFromSpec(
    {
      openapi: "3.0.0",
      paths: { "/x": { post: { requestBody: { required: true, content: { "application/json": { schema: { type: "object", nullable: true } } } } } } },
    },
    { allowWrite: true },
  );
  assert.equal(ops[0].hasBody, true);
  assert.equal(ops[0].inputSchema.properties.body.nullable, undefined);
});
