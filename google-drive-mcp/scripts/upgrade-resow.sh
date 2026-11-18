#!/bin/bash
# Drive_resow を Google Workspace 全般（読み書き）に広げる。Mac のターミナルで 1 回だけ実行する。
#   cd ~/Documents/wonder_jugaad && git fetch origin claude/project-thread-cxv6xw && git checkout claude/project-thread-cxv6xw && bash google-drive-mcp/scripts/upgrade-resow.sh
set -e
cd "$(dirname "$0")/.."
SECRET_FILE=~/.drive_resow_secret
if [ ! -s "$SECRET_FILE" ]; then echo "$SECRET_FILE が見つかりません。止めます。"; exit 1; fi

echo "== 1/3 新しいコードを Cloudflare に出します =="
npx wrangler deploy --env resow

echo
echo "== 2/3 ブラウザで Google にログインし直します =="
echo "tsujii.k@resow.co.jp を選び、ドライブ・Gmail・カレンダーなどの許可を「許可」してください。"
open "https://google-drive-resow.tsujii.workers.dev/auth/$(cat "$SECRET_FILE")"

echo
echo "== 3/3 ブラウザに出た長い文字列を、下に貼り付けて Enter =="
npx wrangler secret put GOOGLE_REFRESH_TOKEN --env resow

echo
echo "完了です。ブラウザのページは閉じてください。claude.ai のコネクタはそのまま使えます（新しい会話から新しいツールが見えます）。"
