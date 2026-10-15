# jugaad-mcp

ジュガール（Jugaad, https://jugaad.co.jp/）の API を Claude から使うための MCP サーバーです。

ジュガールの Swagger / OpenAPI 仕様を読み込み、エンドポイントごとに MCP ツールを自動で作ります。仕様がまだ無くても、パスを指定して API を直接呼ぶ汎用ツール `jugaad_api_request` で使えます。

- 既定は **読み取り専用**（GET のみ）。申請の作成や承認を Claude にさせたいときだけ `JUGAAD_ALLOW_WRITE=true` にします。
- API キーなどの認証情報は環境変数で渡し、リポジトリには置きません（`.env` は `.gitignore` 済み）。

## 用意するもの

1. **ジュガールの API 契約と API キー**：API 連携オプション（https://jugaad.co.jp/api/）の申込みが必要です。
2. **Swagger / OpenAPI 仕様**：ジュガールから案内される Swagger の URL か、そこから保存した JSON / YAML。`spec/` に置くか URL を `JUGAAD_OPENAPI` に指定します。
3. **認証ヘッダの形式**：仕様の `securityDefinitions`（または `components.securitySchemes`）を見て、`Authorization: Bearer <キー>` 以外なら `JUGAAD_AUTH_HEADER` / `JUGAAD_AUTH_SCHEME` を合わせます。
4. **公開 HTTPS で動かす場所**（claude.ai から使う場合）：Cloud Run、Render、Fly.io など。`Dockerfile` をそのまま使えます。

## 設定（環境変数）

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `JUGAAD_BASE_URL` | `https://smartflow.vebuin.com` | API の接続先 |
| `JUGAAD_API_KEY` | なし | ジュガールの API キー |
| `JUGAAD_AUTH_HEADER` | `Authorization` | キーを載せるヘッダ名 |
| `JUGAAD_AUTH_SCHEME` | `Bearer` | ヘッダ値の前置き。空にするとキーのみを送る |
| `JUGAAD_OPENAPI` | なし | 仕様のファイルパスか URL |
| `JUGAAD_ALLOW_WRITE` | `false` | `true` で POST / PUT / PATCH / DELETE も許可 |
| `MCP_ACCESS_TOKEN` | なし（HTTP では必須） | 接続 URL に含める秘密の文字列 |
| `PORT` | `8787` | HTTP の待ち受けポート |

雛形は `.env.example` にあります。

## claude.ai のカスタムコネクタとして使う

1. `MCP_ACCESS_TOKEN` をランダムに生成します（例：`openssl rand -hex 24`）。
2. 上の環境変数を設定してサーバーをデプロイします（`npm run build && npm start`、または Docker）。
3. claude.ai の **設定 → コネクタ → カスタムコネクタを追加** で、URL に次を入れます。

   ```
   https://<デプロイ先のホスト>/mcp/<MCP_ACCESS_TOKEN>
   ```

   claude.ai のカスタムコネクタは任意のヘッダを送れないため、URL に秘密の文字列を含めて保護しています。この URL は API キーと同じように扱ってください。

## Claude Code / Claude Desktop からローカルで使う

```bash
npm install && npm run build
claude mcp add jugaad -e JUGAAD_API_KEY=... -e JUGAAD_OPENAPI=/path/to/swagger.json -- node /path/to/wonder_jugaad/dist/stdio.js
```

## 開発

```bash
npm install
npm run typecheck
npm test     # 架空の仕様と模擬 API でツール生成と呼び出しを確認
```
