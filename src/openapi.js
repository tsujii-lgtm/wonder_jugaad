// Swagger 2.0 / OpenAPI 3.x（JSON）を MCP ツール定義に変換する。

const METHODS = ["get", "post", "put", "patch", "delete"];
const MAX_REF_DEPTH = 6;

function resolveRef(spec, ref) {
  if (!ref.startsWith("#/")) return {};
  return (
    ref
      .slice(2)
      .split("/")
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((node, key) => node?.[key], spec) ?? {}
  );
}

// $ref を展開した JSON Schema を返す（循環参照は深さで打ち切る）
function deref(spec, schema, depth = 0) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((s) => deref(spec, s, depth));
  if (schema.$ref) {
    if (depth >= MAX_REF_DEPTH) return { type: "object", description: `(${schema.$ref})` };
    return deref(spec, resolveRef(spec, schema.$ref), depth + 1);
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "discriminator" || k === "xml" || k === "example" || k === "nullable" || k.startsWith("x-")) continue;
    out[k] = typeof v === "object" ? deref(spec, v, depth) : v;
  }
  return out;
}

export function toolNameFor(method, path, operationId) {
  const raw = operationId ?? `${method}_${path.replace(/\{([^}]+)\}/g, "by_$1")}`;
  const name = raw
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return name.slice(0, 64) || `${method}_root`;
}

export function operationsFromSpec(spec, { allowWrite }) {
  const ops = [];
  const used = new Set();
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const shared = pathItem.parameters ?? [];
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      if (method !== "get" && !allowWrite) continue;

      const properties = {};
      const required = [];
      const params = [];
      let hasBody = false;

      for (const rawParam of [...shared, ...(op.parameters ?? [])]) {
        const p = rawParam.$ref ? resolveRef(spec, rawParam.$ref) : rawParam;
        if (p.in === "body") {
          hasBody = true;
          properties.body = { ...deref(spec, p.schema ?? {}), description: p.description ?? "リクエストボディ" };
          if (p.required) required.push("body");
          continue;
        }
        if (p.in === "formData") {
          hasBody = true;
          properties.body ??= { type: "object", properties: {}, description: "フォームデータ" };
          properties.body.properties[p.name] = { type: p.type ?? "string", description: p.description };
          continue;
        }
        if (!["path", "query", "header"].includes(p.in)) continue;
        if (params.some((x) => x.name === p.name)) continue;
        params.push({ name: p.name, in: p.in });
        const schema = p.schema
          ? deref(spec, p.schema)
          : { type: p.type ?? "string", ...(p.enum ? { enum: p.enum } : {}), ...(p.items ? { items: p.items } : {}) };
        properties[p.name] = { ...schema, description: [p.description, `(${p.in})`].filter(Boolean).join(" ") };
        if (p.required || p.in === "path") required.push(p.name);
      }

      if (op.requestBody) {
        const rb = op.requestBody.$ref ? resolveRef(spec, op.requestBody.$ref) : op.requestBody;
        const content = rb.content ?? {};
        const media = content["application/json"] ?? Object.values(content)[0];
        hasBody = true;
        properties.body = { ...deref(spec, media?.schema ?? { type: "object" }), description: rb.description ?? "リクエストボディ" };
        if (rb.required) required.push("body");
      }

      const base = toolNameFor(method, path, op.operationId);
      let toolName = base;
      for (let i = 2; used.has(toolName); i++) toolName = `${base.slice(0, 60)}_${i}`;
      used.add(toolName);

      const summary = [op.summary, op.description].filter(Boolean).join("\n\n");
      ops.push({
        toolName,
        method: method.toUpperCase(),
        path,
        description: `${summary || "(説明なし)"}\n\n${method.toUpperCase()} ${path}`.slice(0, 1024),
        params,
        hasBody,
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
      });
    }
  }
  return ops;
}

// ツールの引数をパス・クエリ・ヘッダ・ボディに振り分ける
export function buildRequest(op, args) {
  let path = op.path;
  const query = {};
  const headers = {};
  for (const p of op.params) {
    const v = args[p.name];
    if (v === undefined) continue;
    if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
    else if (p.in === "query") query[p.name] = v;
    else headers[p.name] = String(v);
  }
  return { method: op.method, path, query, headers, body: op.hasBody ? args.body : undefined };
}
