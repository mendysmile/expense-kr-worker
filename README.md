# expense-kr-worker

iPhone 控制中心一鍵記帳到 Notion 的 Cloudflare Worker — iOS Shortcut 送扁平 3 欄位 JSON，Worker 端取匯率、算台幣、寫進 Notion 韓國記帳 DB。

📝 設計過程與踩坑紀錄：[iOS Shortcut + Cloudflare Worker × Notion：把記帳搬到 iPhone 控制中心](https://stitch-balaur-0bc.notion.site/iOS-Shortcut-Cloudflare-Worker-Notion-iPhone-354685d200ff811b99faecf9db0a6995)

## 為什麼要 Worker 中介

iOS 18 的「取得 URL 內容」action 沒有 Raw Text body mode，「JSON」mode 不接受 nested dict 當 root。Notion API body 是 4 層 nested，Shortcut 沒辦法直接組。

把複雜邏輯往後端推：iPhone 只送扁平 3 欄位 `{item, amount, category}`，Worker 自己組複雜 nested body 給 Notion。

```
iPhone Shortcut（7 個 actions）
       │
       │  POST { item, amount, category }
       ▼
Cloudflare Worker（這個 repo）
       │
       │  + 取匯率 + 算台幣 + KST 日期 + 千分位 title
       │  + 加 Authorization header
       ▼
Notion API → 韓國記帳 DB
```

## 你需要

- Cloudflare 帳號（免費，自帶 Workers free tier 100,000 req/day）
- Notion workspace + 一個記帳 DB（schema 見下方）
- iPhone（iOS 17+）
- Node.js 18+ + `npx wrangler`

## 部署

### 1. Clone + 安裝

```bash
git clone https://github.com/mendysmile/expense-kr-worker.git
cd expense-kr-worker
```

### 2. 開 Notion integration（縮限到只能寫一個 DB）

到 https://www.notion.so/my-integrations 新建一個 integration，**Capabilities 只勾 `Insert content`**。建好後複製 Internal Integration Secret。

打開你的記帳 DB → 右上 ⋯ → Connections → Add connection → 找剛建的 integration。

### 3. 改 wrangler.toml + index.js

`wrangler.toml`：

```toml
[vars]
NOTION_DATA_SOURCE_ID = "你的 Notion data_source_id"
```

`data_source_id` 從哪抓：用 main token call `GET /v1/databases/{db_id}` → 看 `data_sources[0].id`。

`index.js`：改 `PAYER_NAME` 跟 `properties` block 的欄位名 / select options 對齊你自己的 DB schema。

### 4. 部署 Worker

```bash
npx wrangler@latest login
npx wrangler@latest deploy
```

第一次部署會問你註冊 `workers.dev` subdomain — 隨便挑個英文小寫名稱即可。

### 5. 設兩個 secret

```bash
echo "你的 Notion integration token" | npx wrangler@latest secret put NOTION_TOKEN_EXPENSE_KR
echo "你自己取的隨機字串" | npx wrangler@latest secret put SHORTCUT_SECRET
```

`SHORTCUT_SECRET` 是 URL query param 的 secret，防陌生人從網路掃到 Worker URL 亂打。

### 6. 建 iOS Shortcut（7 個 actions）

| # | Action | 設定 |
|---|---|---|
| 1 | 要求輸入 | 類型「文字」，提示「記什麼?」，命名 `項目` |
| 2 | 要求輸入 | 類型「數字」，禁小數負數，命名 `金額` |
| 3 | 文字 | 10 行類別清單（一行一個，例：餐飲 / 交通 / 超商 / 生活用品 / 娛樂 / 運動 / 房租 / 水電 / 電信 / 其他） |
| 4 | 分割文字 | 來源拖上面文字，分隔符「換行」 |
| 5 | **從列表中選擇** | 來源拖分割結果，提示「選類別」 |
| 6 | 取得 URL 內容 | URL `https://expense-kr.<subdomain>.workers.dev?secret=<你的SHORTCUT_SECRET>`、POST、Header `Content-Type: application/json`、請求主體選 **JSON** + 三個欄位 `item`(文字→項目)/`amount`(數字→金額)/`category`(文字→從列表中選擇結果) |
| 7 | 顯示通知 | 標題「✅ 已記入」 |

**重點**：類別這段一定要用「**從列表中選擇**」，不是「從選單中選擇」— 後者的變數作用域有坑會抓到金額。

完成後設定 → 控制中心 → 新增控制項 → 加 Shortcut widget 指向這個捷徑。

## API 合約（Worker 期待的 JSON）

```json
{
  "item": "咖啡",
  "amount": 4500,
  "category": "餐飲"
}
```

成功回 Notion API 200 + page object，失敗回對應狀態碼 + error message。

## Notion DB schema（這個 Worker 寫入的 9 個欄位）

| 欄位 | type | Worker 寫什麼 |
|---|---|---|
| 標題 | title | `${item} - ₩${千分位金額}` |
| 金額韓元 | number | KRW 整數 |
| 金額台幣 | number | round(KRW × 匯率) |
| 匯率 | number | open.er-api.com 的 rates.TWD，失敗 fallback `0.023` |
| 類別 | select | iPhone 端選的 |
| 付款人 | select | 寫死 `PAYER_NAME` 常數 |
| 日期 | date | KST 當天，強制 `Asia/Seoul` |
| 店名 | rich_text | 跟 item 同 |
| 備註 | rich_text | `無收據手動記`（匯率 fallback 時補註） |

如果你的 schema 不一樣，改 `index.js` 的 `properties` block。

## 安全考量

| 項目 | 風險評級 | 說明 |
|---|---|---|
| Notion token 外洩 | 低 | integration 縮限到只能 insert 單一 DB，最壞情況只能塞垃圾 page，不能讀 / 刪 / 改 schema |
| SHORTCUT_SECRET 外洩 | 低 | iCloud sync 風險。重設 5 秒 (`wrangler secret put SHORTCUT_SECRET`)，舊的立即失效 |
| Cloudflare 自動扣錢 | **0** | Workers Free Plan 不會自動升級到 Paid，超過免費額度只 throttle |

## 改成你自己的記帳場景

這個 Worker 是「韓國記帳」場景的範本，但架構通用 — 任何 iOS Shortcut → Notion DB 的單向寫入都能 fork 改：

- 換貨幣：把 `KRW → TWD` 換成你需要的對（例：JPY → TWD）
- 換時區：把 `Asia/Seoul` 換成 `Asia/Tokyo` 之類
- 換 DB schema：改 `properties` block 對齊你的 Notion DB

## License

MIT
