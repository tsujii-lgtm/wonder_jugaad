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
| `GOOGLE_SERVICE_ACCOUNT_JSON` | なし | サービスアカウントの鍵（JSON の中身）。設定するとスプレッドシートのツールが有効になる |
| `GOOGLE_APPLICATION_CREDENTIALS` | なし | 鍵ファイルのパス（上の代わりに使える） |
| `GOOGLE_ALLOW_WRITE` | `false` | `true` でスプレッドシートへの書き込みも許可 |
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

## Google スプレッドシートを読む（resow.co.jp など）

同じサーバーに Google スプレッドシート用のツール（`sheets_list_spreadsheets` / `sheets_get_spreadsheet` / `sheets_get_values`）も入っています。**サービスアカウント**（ロボット用の Google アカウント）で動くため、本人のパスワードや OAuth の同意画面は要りません。読めるのは、そのサービスアカウントに共有したシートだけです。

用意する手順（Google Workspace のアカウントで作業してください）：

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作り（会社の組織配下でも個人でも可）、「Google Sheets API」と「Google Drive API」を有効にします。
2. 「IAM と管理 → サービスアカウント」でサービスアカウントを作り、「キー → 鍵を追加 → JSON」で鍵ファイルをダウンロードします。組織のポリシーで鍵の作成が禁止されている場合は、Workspace 管理者に許可を依頼してください。
3. サービスアカウントのメールアドレス（`xxx@<project>.iam.gserviceaccount.com`）を、読ませたいスプレッドシート（またはフォルダ）に **閲覧者** として共有します。
4. 鍵ファイルの中身を、サーバーの環境変数 `GOOGLE_SERVICE_ACCOUNT_JSON` に設定します（デプロイ先のシークレット機能を使い、リポジトリには置かない）。ローカルなら `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` でも動きます。

書き込み（`sheets_update_values` / `sheets_append_values`）は、`GOOGLE_ALLOW_WRITE=true` にして、共有を **編集者** にしたときだけ使えます。

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
