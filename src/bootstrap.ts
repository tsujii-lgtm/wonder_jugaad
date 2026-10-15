import { loadConfig } from "./config.js";
import { loadSpec, operationsFromSpec, type Operation } from "./openapi.js";

export async function bootstrap() {
  const config = loadConfig();
  let operations: Operation[] = [];
  if (config.openapiSource) {
    const spec = await loadSpec(config.openapiSource);
    operations = operationsFromSpec(spec, { allowWrite: config.allowWrite });
  }
  // stdio モードでは stdout が MCP 通信に使われるので、ログは stderr に出す
  console.error(
    `[jugaad-mcp] base=${config.baseUrl} spec=${config.openapiSource ?? "(なし)"} tools=${operations.length} ` +
      `write=${config.allowWrite} apiKey=${config.apiKey ? "設定済み" : "未設定"}`,
  );
  return { config, operations };
}
