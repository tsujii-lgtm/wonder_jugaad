// LINE Messaging API の「読むだけ」のツール群。チャネルアクセストークン（長期）を使う。
// 送信・設定変更の API は一切呼ばない（GET のみ）。

const API = "https://api.line.me";

// LINE の統計は日本時間の日付で区切られ、前日分が翌日に確定する。
export function jstDate(offsetDays = 0, now = new Date()) {
  const d = new Date(now.getTime() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export function normalizeDate(v, fallbackOffset = -1) {
  if (v === undefined || v === null || v === "") return jstDate(fallbackOffset);
  const s = String(v).replace(/[-/]/g, "");
  if (!/^\d{8}$/.test(s)) throw new Error(`日付は YYYY-MM-DD か YYYYMMDD で指定してください: ${v}`);
  return s;
}

function datesBetween(from, to) {
  const toDate = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
  const out = [];
  for (let d = toDate(from); d <= toDate(to); d = new Date(d.getTime() + 86400000)) {
    out.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
    if (out.length > 31) throw new Error("期間は31日までにしてください");
  }
  if (!out.length) throw new Error("from が to より後になっています");
  return out;
}

async function get(env, path, params = {}) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が未設定です（wrangler secret put で登録してください）");
  const url = new URL(path, API);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`LINE API ${res.status}: ${body.message || JSON.stringify(body)}`);
  return body;
}

const dateProp = (desc) => ({ type: "string", description: desc });

const TOOLS = [
  {
    name: "line_account_info",
    description: "このLINE公式アカウントの基本情報（表示名・ベーシックID・プレミアムID・チャットモード）を返す。",
    inputSchema: { type: "object", properties: {} },
    run: (env) => get(env, "/v2/bot/info"),
  },
  {
    name: "line_followers",
    description:
      "指定日（日本時間）の友だち数を返す。followers=友だち追加の累計、targetedReaches=配信できる人数（ターゲットリーチ）、blocks=ブロックの累計。前日分は翌日に確定する。date 省略時は昨日。",
    inputSchema: { type: "object", properties: { date: dateProp("YYYY-MM-DD。省略時は昨日") } },
    run: (env, a) => get(env, "/v2/bot/insight/followers", { date: normalizeDate(a.date) }),
  },
  {
    name: "line_followers_daily",
    description:
      "期間（最大31日）の友だち数を日ごとに並べ、前日からの増減（友だち追加・ブロック・ターゲットリーチ）も計算して返す。広告開始前後の比較などに使う。",
    inputSchema: {
      type: "object",
      properties: { from: dateProp("開始日 YYYY-MM-DD"), to: dateProp("終了日 YYYY-MM-DD。省略時は昨日") },
      required: ["from"],
    },
    run: async (env, a) => {
      const days = datesBetween(normalizeDate(a.from), normalizeDate(a.to));
      const rows = [];
      for (const date of days) {
        const r = await get(env, "/v2/bot/insight/followers", { date });
        rows.push({ date, status: r.status, followers: r.followers ?? null, targetedReaches: r.targetedReaches ?? null, blocks: r.blocks ?? null });
      }
      rows.forEach((r, i) => {
        const p = rows[i - 1];
        if (p && r.status === "ready" && p.status === "ready") {
          r.newFollowers = r.followers - p.followers;
          r.newBlocks = r.blocks - p.blocks;
          r.reachChange = r.targetedReaches - p.targetedReaches;
        }
      });
      return { note: "status が ready 以外の日は未確定か、統計の対象外です。増減は前日比。", rows };
    },
  },
  {
    name: "line_demographic",
    description: "友だちの属性（性別・年代・地域・OS・友だち期間）の割合を返す。ターゲットリーチが20人未満だと LINE が返さない。",
    inputSchema: { type: "object", properties: {} },
    run: (env) => get(env, "/v2/bot/insight/demographic"),
  },
  {
    name: "line_delivery_counts",
    description:
      "指定日（日本時間）に送ったメッセージ数を種類別に返す（broadcast=一斉配信、targeting=絞り込み配信、autoResponse=自動応答、welcomeResponse=あいさつ、chat=チャット、apiPush/apiMulticast/apiNarrowcast/apiReply=UTAGEなどAPI経由）。date 省略時は昨日。",
    inputSchema: { type: "object", properties: { date: dateProp("YYYY-MM-DD。省略時は昨日") } },
    run: (env, a) => get(env, "/v2/bot/insight/message/delivery", { date: normalizeDate(a.date) }),
  },
  {
    name: "line_message_quota",
    description: "今月の無料メッセージ通数の上限と、今月これまでに使った通数を返す。",
    inputSchema: { type: "object", properties: {} },
    run: async (env) => ({
      quota: await get(env, "/v2/bot/message/quota"),
      consumption: await get(env, "/v2/bot/message/quota/consumption"),
    }),
  },
  {
    name: "line_unit_stats",
    description:
      "API配信時に付けた集計単位（customAggregationUnits）ごとの開封・クリックなどの統計を期間で返す。集計単位を付けていない配信は出てこない。期間は最大30日。",
    inputSchema: {
      type: "object",
      properties: {
        unit: { type: "string", description: "集計単位の名前" },
        from: dateProp("開始日 YYYY-MM-DD"),
        to: dateProp("終了日 YYYY-MM-DD"),
      },
      required: ["unit", "from", "to"],
    },
    run: (env, a) =>
      get(env, "/v2/bot/insight/message/event/aggregation", { customAggregationUnit: a.unit, from: normalizeDate(a.from), to: normalizeDate(a.to) }),
  },
  {
    name: "line_unit_list",
    description: "今月使われた集計単位（customAggregationUnits）の名前一覧を返す。",
    inputSchema: { type: "object", properties: {} },
    run: (env) => get(env, "/v2/bot/message/aggregation/list", { limit: 100 }),
  },
];

export const lineTools = {
  definitions: TOOLS.map(({ run, ...d }) => d),
  call: async (env, name, args) => {
    const t = TOOLS.find((x) => x.name === name);
    return t ? t.run(env, args || {}) : undefined;
  },
};
