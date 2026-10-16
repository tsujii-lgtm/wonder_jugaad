# wonder-jugaad-mcp

Claude（claude.ai）からジュガール（Jugaad）の API を読むためのコネクタです。
Cloudflare Workers（無料枠で足ります）で動くリモート MCP サーバーで、作り方は同じ作者の chatwork-mcp と同じです。

既定は **読み取り専用** です。申請の作成や承認など書き込みを許すときだけ、設定を変えます。

## できること

| ツール | 内容 |
| --- | --- |
| `jugaad_api_request` | ジュガール API を直接呼ぶ（既定は GET のみ） |
| `jugaad_list_endpoints` | Swagger に載っているエンドポイントの一覧 |
| （Swagger ごとに自動生成） | `JUGAAD_OPENAPI_URL` を設定すると、エンドポイントごとのツールができる |

`JUGAAD_API_KEY` を登録しないと、ツールは 1 つも出ません。

## 用意するもの

ジュガールの API は有料オプションで、公開ページには API キーの発行手順がありません。次の 3 つを、ジュガールのサポート窓口（https://smartflowhelp.zendesk.com/hc/ja/requests/new）に確認してください。

1. 契約中のプランで API 連携のオプションを申し込めるか
2. API キーの発行方法
3. Swagger 仕様の URL と、認証ヘッダの形式（`Authorization: Bearer ...` か `X-API-KEY: ...` か）

## セットアップ（初回だけ、15分ほど）

Cloudflare のアカウント（無料）を作り、Mac のターミナルで次のコマンドを **1 行ずつ** 実行します。

```sh
cd ~/Documents/wonder_jugaad
npm install --no-save wrangler
npx wrangler login
openssl rand -hex 24
npx wrangler secret put MCP_SECRET
npx wrangler secret put JUGAAD_API_KEY
npx wrangler deploy
```

- `openssl rand -hex 24` で表示された文字列をコピーして控え、次の `secret put MCP_SECRET` で貼り付けて Enter。
- `secret put JUGAAD_API_KEY` では、ジュガールで発行した API キーを貼り付けて Enter。
- 接続先や Swagger の URL は `wrangler.toml` の `[vars]` に書いてから `deploy` します（`JUGAAD_BASE_URL`、`JUGAAD_OPENAPI_URL`、認証ヘッダ）。

最後に `https://wonder-jugaad-mcp.<あなたのサブドメイン>.workers.dev` が表示されます。

### claude.ai にコネクタとして登録する

claude.ai の「設定」→「コネクタ」→「カスタムコネクタを追加」で、

- 名前: `ジュガール`
- URL: `https://wonder-jugaad-mcp.<あなたのサブドメイン>.workers.dev/mcp/<控えた MCP_SECRET>`

を入力して追加します。

## セキュリティ

- URL の末尾の `MCP_SECRET` を知っている人なら誰でも、あなたのジュガールを読めます。URL は他人に共有しないでください。
- 漏れた疑いがあるときは `npx wrangler secret put MCP_SECRET` で新しい値に変え、claude.ai のコネクタ URL も差し替えてください。
- API キーは Cloudflare のシークレットにだけ保存され、コードや GitHub には入りません。
- 書き込みを許すには `wrangler.toml` の `JUGAAD_ALLOW_WRITE` を `"true"` にして `deploy` し直します。

## 開発

```sh
npm test        # Node 20 以上。架空の Swagger と模擬 API で確認する
npx wrangler dev
```
