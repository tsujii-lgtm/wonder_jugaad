# lineworks-bot-mcp

LINE WORKS（ReSow）の Bot から、決めたトークルームにメッセージを送るためのコネクタです。
Cloudflare Workers で動くリモート MCP サーバーで、作り方は line-official-mcp・google-drive-mcp と同じです。

- 送れるのは `LW_ALLOWED_CHANNEL_IDS` に入れたトークルームだけ。
- トークの中身は読みません（監査APIは使いません）。
- 最初の用途：ワンダーB型向け「PC作業の新着リスト」を毎朝トークに流す。

## ツール

| ツール | 内容 |
| --- | --- |
| `lineworks_send_message` | 許可したトークルームにテキストを送る（2000字を超えたら分けて送る） |
| `lineworks_list_targets` | Bot名と、送ってよいトークルームIDの一覧 |
| `lineworks_create_channel` | Botとメンバーで新しいグループトークを作る（`LW_ALLOW_CREATE_CHANNEL = "true"` のときだけ） |

## セットアップ

### 1. Developer Console（https://dev.worksmobile.com/ ）

1. 「アプリの新規追加」→ アプリ名「お仕事さがし連携」→ 同意して作成。
2. 「OAuth Scopes」の「管理」で **bot** にチェック → 保存。
3. 「Service Account」の「発行」→ 続けて「Private Key」の「発行/再発行」。`private_…key` がダウンロードされる。
4. 画面の **Client ID / Client Secret / Service Account** を控える（チャットには貼らない）。
5. 左メニュー「Bot」→「登録」→ Bot名「お仕事さがしBot」、説明を入れ、Callback URL は Off、
   Bot Policy で「複数人のトークルームに招待可能」にチェック、主担当に自分 → 保存。**Bot ID** を控える。

### 2. 管理者画面（https://admin.worksmobile.com/ ）

「サービス」→「Bot」→「Bot追加」→「お仕事さがしBot」を選んで追加 → 公開範囲を設定して保存。

### 3. Mac のターミナル（1行ずつ）

```sh
cd ~/Documents/wonder_jugaad
git fetch origin claude/project-thread-0fhje4 && git checkout claude/project-thread-0fhje4 && git pull
cd lineworks-bot-mcp
openssl rand -hex 24
npx wrangler secret put MCP_SECRET
npx wrangler secret put LW_CLIENT_ID
npx wrangler secret put LW_CLIENT_SECRET
npx wrangler secret put LW_SERVICE_ACCOUNT
npx wrangler secret put LW_BOT_ID
npx wrangler secret put LW_PRIVATE_KEY < ~/Downloads/private_*.key
npx wrangler deploy
```

- `openssl rand -hex 24` の文字列を控え、`MCP_SECRET` で貼り付ける。ほかは聞かれたら控えた値を貼る。
- `deploy` の最後に出る `https://lineworks-bot-resow.<アカウント>.workers.dev` を控える。

### 4. claude.ai にコネクタを登録

設定 →「コネクタ」→「カスタムコネクタを追加」→ 名前 `LINEWORKS_resow`、URL `https://lineworks-bot-resow.<アカウント>.workers.dev/mcp/<MCP_SECRET>`。

### 5. トークルームを決める

Claude が `lineworks_create_channel` で Bot 入りのグループトークを作り、返ってきた ID を
`wrangler.toml` の `LW_ALLOWED_CHANNEL_IDS` に入れ、`LW_ALLOW_CREATE_CHANNEL` を `"false"` に戻して、もう一度 `npx wrangler deploy`。

## テスト

```sh
npm test
```
