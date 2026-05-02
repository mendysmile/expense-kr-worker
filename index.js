/**
 * Cloudflare Worker: expense-kr-proxy
 *
 * iOS Shortcut → Cloudflare Worker → Notion API
 *
 * iPhone Shortcut 只送扁平 3 欄位 JSON {item, amount, category}，
 * Worker 端組完整 Notion API body：取匯率 → 算台幣 → KST 日期 → 千分位 title。
 *
 * 為什麼要 Worker 中介：iOS 18 的「取得 URL 內容」JSON mode 不接 nested dict，
 * 「檔案」mode 會被包成 multipart 給 Notion API connection reset。
 * Worker 把 iPhone 端的 JSON 簡化成 3 欄位，後端組複雜 nested body。
 *
 * 安全：URL 帶 ?secret=xxx 驗身，Notion token 存 Worker secret。
 *
 * Fork 後你要改的地方：
 * 1. wrangler.toml [vars] NOTION_DATA_SOURCE_ID = "你的 Notion data_source_id"
 * 2. 下面的 PAYER_NAME 改成你自己的名字
 * 3. 下面 properties block 的欄位名 / select options 對齊你的 Notion DB schema
 */

const NOTION_API_URL = "https://api.notion.com/v1/pages";
const NOTION_VERSION = "2025-09-03";
const FALLBACK_TWD_RATE = 0.023;
const PAYER_NAME = "蔓蒂"; // 改成你自己

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 1. 驗 secret query param
    const url = new URL(request.url);
    const secret = url.searchParams.get("secret");
    if (!secret || secret !== env.SHORTCUT_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 2. 解析 Shortcut 送來的 3 欄位 JSON
    let payload;
    try {
      const body = await request.text();
      payload = JSON.parse(body);
    } catch {
      return new Response(
        JSON.stringify({ error: "body must be valid JSON" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const item = (payload.item ?? "").toString().trim();
    const amount = Number(payload.amount);
    const category = (payload.category ?? "").toString().trim();

    if (!item || !Number.isFinite(amount) || amount <= 0 || !category) {
      return new Response(
        JSON.stringify({
          error: "item, amount(>0), category 必填",
          got: { item, amount, category },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. 取 KRW → TWD 匯率（失敗 fallback 0.023）
    let rate = FALLBACK_TWD_RATE;
    let note = "無收據手動記";
    try {
      const rateRes = await fetch("https://open.er-api.com/v6/latest/KRW");
      if (rateRes.ok) {
        const rateData = await rateRes.json();
        const twdRate = rateData?.rates?.TWD;
        if (typeof twdRate === "number" && twdRate > 0) {
          rate = twdRate;
        } else {
          note = "無收據手動記｜匯率 fallback";
        }
      } else {
        note = "無收據手動記｜匯率 fallback";
      }
    } catch {
      note = "無收據手動記｜匯率 fallback";
    }

    const twd = Math.round(amount * rate);

    // 4. KST 日期 yyyy-MM-dd（強制 Asia/Seoul，不依賴 Worker 機器時區）
    const kstDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const krwFormatted = amount.toLocaleString("en-US");

    // 5. 組 Notion API body — 欄位名與 schema 對齊你自己的 DB
    const notionBody = {
      parent: {
        type: "data_source_id",
        data_source_id: env.NOTION_DATA_SOURCE_ID,
      },
      properties: {
        "標題": {
          title: [{ text: { content: `${item} - ₩${krwFormatted}` } }],
        },
        "金額韓元": { number: amount },
        "金額台幣": { number: twd },
        "匯率": { number: rate },
        "類別": { select: { name: category } },
        "付款人": { select: { name: PAYER_NAME } },
        "日期": { date: { start: kstDate } },
        "店名": { rich_text: [{ text: { content: item } }] },
        "備註": { rich_text: [{ text: { content: note } }] },
      },
    };

    // 6. POST 到 Notion
    const notionRes = await fetch(NOTION_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN_EXPENSE_KR}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(notionBody),
    });

    const notionResBody = await notionRes.text();

    return new Response(notionResBody, {
      status: notionRes.status,
      headers: { "Content-Type": "application/json" },
    });
  },
};
