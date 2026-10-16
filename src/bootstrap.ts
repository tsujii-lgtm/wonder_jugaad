import { loadConfig } from "./config.js";
import { createSheetsTools, loadSheetsConfig } from "./google/sheets.js";
import { loadSpec, operationsFromSpec, type Operation } from "./openapi.js";

export async function bootstrap() {
  const config = loadConfig();
  let operations: Operation[] = [];
  if (config.openapiSource) {
    const spec = await loadSpec(config.openapiSource);
    operations = operationsFromSpec(spec, { allowWrite: config.allowWrite });
  }
  const sheetsConfig = loadSheetsConfig(process.env);
  const extra = sheetsConfig ? createSheetsTools(sheetsConfig) : undefined;
  // stdio モードでは stdout が MCP 通信に使われるので、ログは stderr に出す
  console.error(
    `[jugaad-mcp] base=${config.baseUrl} spec=${config.openapiSource ?? "(なし)"} tools=${operations.length} ` +
      `write=${config.allowWrite} apiKey=${config.apiKey ? "設定済み" : "未設定"} sheets=${sheetsConfig ? (sheetsConfig.allowWrite ? "読み書き" : "読み取り") : "無効"}`,
  );
  return { config, operations, extra };
}
