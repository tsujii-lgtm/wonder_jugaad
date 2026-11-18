# google-drive-mcp

Claude（claude.ai）から、**Google アカウントごとに** Google ドライブとスプレッドシートを読むためのコネクタです。
Gmail_resow や Gmail_unistep と同じ考え方で、アカウントごとに 1 つずつ Cloudflare Workers（無料枠）に立てます。
既定は **読み取り専用** です（スコープは `drive.readonly` だけ）。
`wrangler.toml` で `ALLOW_SHEETS_WRITE = "true"` にした環境（今は unistep だけ）は、スプレッドシートへの書き込みもできます（ログイン時に `spreadsheets` の許可も求めます）。

## できること

| ツール | 内容 |
| --- | --- |
| `drive_search_files` | ファイル名・本文で探す（共有ドライブも含む）。種類で絞れる |
| `drive_list_recent` | 最近更新されたファイル |
| `drive_list_folder` | フォルダの中身 |
| `drive_get_file` | ファイルの情報（オーナー、更新日、リンクなど） |
| `drive_read_file` | 中身を文字で読む（ドキュメント・スライド・スプレッドシート・テキスト） |
| `sheets_get_spreadsheet` | スプレッドシートのシート（タブ）一覧 |
| `sheets_get_values` | セルの値を読む。シート名だけでも、範囲指定でも、全シートでも |

書き込みを許可した環境だけ、次の 2 つが増えます。

| ツール | 内容 |
| --- | --- |
| `sheets_update_values` | セルに書き込む（上書き）。数式も入る |
| `sheets_duplicate_sheet` | シート（タブ）を同じファイル内でコピーして名前を付ける |

ID の代わりに、共有リンクの URL をそのまま渡せます。

### Google Workspace 全般（`GWS_FULL = "true"`、今は resow だけ）

ログイン時に drive / spreadsheets / documents / presentations / gmail.modify / calendar の許可を求め、次のツールが増えます（上の書き込み 2 つも入ります）。

| 分野 | ツール |
| --- | --- |
| ドライブ | `drive_create_folder` `drive_create_file`（ドキュメント・シート・スライド・テキスト、中身つきも可） `drive_copy_file` `drive_update_file`（名前・説明・移動） `drive_list_permissions` |
| スプレッドシート | `sheets_append_values`（下に行を足す） `sheets_clear_values` `sheets_add_sheet` `sheets_batch_update`（書式など。シート削除は不可） |
| ドキュメント | `docs_get_document`（位置つき） `docs_append_text` `docs_insert_text` `docs_replace_text` `docs_batch_update` |
| スライド | `slides_get_presentation` `slides_replace_text` `slides_batch_update` |
| Gmail | `gmail_search` `gmail_read_message` `gmail_read_thread` `gmail_get_attachment` `gmail_list_labels` `gmail_modify_labels`（既読・アーカイブ・ラベル） `gmail_create_draft`（返信も可） `gmail_list_drafts` |
| カレンダー | `calendar_list_calendars` `calendar_list_events` `calendar_create_event`（招待なし） `calendar_update_event`（通知なし） |

`ALLOW_SEND = "true"` の環境だけ、外に出る・消える操作のツールが増えます。どれも `confirmed: true` が必須で、使う前に毎回チャットで本人の OK をもらう約束です。

`gmail_send_draft`（下書きを送る） `gmail_trash_message` `drive_trash_file`（ゴミ箱。30 日は戻せる） `drive_share_file` `calendar_invite`（招待メールが届く） `calendar_delete_event`

完全に消す（ゴミ箱を空にする）、シートを消す、のツールはありません。

#### 読み取り専用から広げるとき（resow は 2026-11-18）

1. Google Cloud（resow.co.jp > My First Project）で **Google Docs API / Google Slides API / Gmail API / Google Calendar API** を有効にする（Drive・Sheets は有効済み）。
2. Mac で `bash google-drive-mcp/scripts/upgrade-resow.sh` を実行する（デプロイ → ログインし直し → 新しいトークンの登録）。

## セットアップ（初回だけ、20〜30分）

例は ReSow（`tsujii.k@resow.co.jp`）。ユニステップなら `resow` を `unistep` に読み替えます。

### 1. Google Cloud で OAuth クライアントを用意する

Gmail_resow 用にすでに Google Cloud のプロジェクトがあれば、それを使って構いません。

1. https://console.cloud.google.com/ を **tsujii.k@resow.co.jp** で開く
2. 「API とサービス」→「ライブラリ」で **Google Drive API** と **Google Sheets API** を有効にする
3. 「OAuth 同意画面」を作る（まだなら）。ユーザーの種類は「内部」でよい（Workspace の場合）
4. 「認証情報」→「認証情報を作成」→「OAuth クライアント ID」
   - 種類: **ウェブ アプリケーション**
   - 承認済みのリダイレクト URI: `https://google-drive-resow.<あなたのサブドメイン>.workers.dev/oauth/callback`
     （サブドメインは手順 2 の deploy で表示されます。先に deploy してから追加しても構いません）
5. 表示された **クライアント ID** と **クライアント シークレット** を控える

### 2. Worker をデプロイする

Mac のターミナルで **1 行ずつ** 実行します。

```sh
cd ~/Documents/wonder_jugaad/google-drive-mcp
npm install --no-save wrangler
npx wrangler login
openssl rand -hex 24
npx wrangler secret put MCP_SECRET --env resow
npx wrangler secret put GOOGLE_CLIENT_ID --env resow
npx wrangler secret put GOOGLE_CLIENT_SECRET --env resow
npx wrangler deploy --env resow
```

- `openssl rand -hex 24` の文字列を控え、`MCP_SECRET` に貼り付けます。
- 最後に `https://google-drive-resow.<サブドメイン>.workers.dev` が表示されます。

### 3. Google にログインする

ブラウザで次を開き、**tsujii.k@resow.co.jp** でログインして許可します。

```
https://google-drive-resow.<サブドメイン>.workers.dev/auth/<控えた MCP_SECRET>
```

表示された画面の指示どおり、次のコマンドを実行して、画面の文字列を貼り付けます。

```sh
npx wrangler secret put GOOGLE_REFRESH_TOKEN --env resow
```

### 4. claude.ai にコネクタとして登録する

「設定」→「コネクタ」→「カスタムコネクタを追加」で、

- 名前: `Drive_resow`
- URL: `https://google-drive-resow.<サブドメイン>.workers.dev/mcp/<控えた MCP_SECRET>`

## うまくいかないとき

- **「アクセスをブロック」「管理者が制限」と出る**: Google Workspace の管理者が外部アプリを制限しています。管理コンソールの「セキュリティ」→「API の制御」で、このクライアント ID を信頼済みにしてもらいます。
- **トークン更新に失敗する**: OAuth 同意画面が「外部・テスト中」だと、トークンは 7 日で切れます。「内部」にするか「本番」に公開します。切れたら手順 3 をやり直します。
- **ファイルが見つからない**: そのファイルが、このアカウントに共有されていません。

## アカウントを増やす

`wrangler.toml` の `[env.resow]` のまとまりをコピーして、名前と `GOOGLE_ACCOUNT` を変え、手順 1〜4 を `--env <名前>` で繰り返します。OAuth クライアントには、新しい Worker のリダイレクト URI を追加します。

## セキュリティ

- URL 末尾の `MCP_SECRET` を知っている人は、このアカウントのドライブを読めます。URL は共有しないでください。漏れたら `secret put MCP_SECRET` で変えて、コネクタの URL も差し替えます。
- 秘密情報は Cloudflare のシークレットにだけ置き、コードや GitHub には入れません。
- 既定は読み取り専用です。書き込みは `ALLOW_SHEETS_WRITE` / `GWS_FULL` / `ALLOW_SEND` を付けた環境だけです。

## 開発

```sh
npm test   # Node 20 以上。Google の API は模擬で確認する
```
