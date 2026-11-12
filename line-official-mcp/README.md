# line-official-mcp（LINE公式アカウントを読むコネクタ）

LINE公式アカウントの友だち数・ブロック数・属性・配信数を、LINE Messaging API で読むための MCP サーバー。
Cloudflare Workers に置き、claude.ai の「カスタムコネクタ」に登録して使う。**読み取り専用**（GET だけ。送信や設定変更はしない）。

## できること

| ツール | 中身 |
| --- | --- |
| line_account_info | 表示名・ベーシックID |
| line_followers | 指定日の友だち累計・ターゲットリーチ・ブロック累計 |
| line_followers_daily | 期間（31日まで）の日ごとの数字と前日比（友だち追加・ブロック） |
| line_demographic | 性別・年代・地域・OS・友だち期間の割合 |
| line_delivery_counts | 指定日の配信数（一斉配信・自動応答・UTAGEなどAPI経由 など） |
| line_message_quota | 今月の無料通数の上限と使用数 |
| line_unit_list / line_unit_stats | 集計単位ごとの開封・クリック（API配信で集計単位を付けた場合のみ） |

**友だち追加の経路（どの広告から来たか）は LINE の API では取れない。** 媒体別の登録数は UTAGE の「流入経路」で追う。

## 必要なもの

1. **チャネルアクセストークン（長期）**：LINE Developers コンソール → エミットのプロバイダー → Messaging API チャネル → 「Messaging API設定」タブの一番下。
   - ⚠️ UTAGE とつないでいるなら、UTAGE が同じトークンを使っている。**「再発行」は押さない**（UTAGE の配信が止まる）。表示されている文字列をコピーするだけ。
2. Cloudflare アカウント（google-drive-mcp と同じ tsujii@okigarunet.com）

## デプロイ（Mac のターミナルで 1 行ずつ）

```
cd ~/Documents/wonder_jugaad/line-official-mcp
npx wrangler deploy --env emit
openssl rand -hex 24          # 出てきた文字列が合言葉（MCP_SECRET）。~/.line_emit_secret などに保存
npx wrangler secret put MCP_SECRET --env emit
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env emit
```

## claude.ai への登録

設定 → コネクタ → カスタムコネクタを追加
- 名前：`LINE_emit`
- URL：`https://line-official-emit.<サブドメイン>.workers.dev/mcp/<MCP_SECRET>`

## ほかのアカウントを足すとき

`wrangler.toml` の `[env.emit]` をコピーして名前とラベルを変え、同じ手順でデプロイする。
