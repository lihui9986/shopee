# 蝦皮選品器 後台服務端（Ubuntu 版）

跑在 **192.168.139.130（Ubuntu 20.04，VMware NAT）**，端口 **4180**，與 `shopee-selector.user.js v4.2.19` 的接口契約完全對齊。

## 一、部署結果

| 項目 | 值 |
|---|---|
| 代碼 | `/opt/xuanpin/app.py`（本目錄 app.py 為源文件） |
| 數據庫 | `/opt/xuanpin/xuanpin.db`（SQLite，WAL） |
| 虛擬環境 | `/opt/xuanpin/venv`（Python 3.8.10 + Flask 3.0.3） |
| systemd | `xuanpin.service`，User=ubantu，`Restart=always`，已 enable（開機自啟） |
| 監聽 | `0.0.0.0:4180` |
| 令牌 | `xk_3f824111e24061a698569f26ac0f85c9`（與腳本默認 token 一致，可用環境變量 `XUANPIN_TOKEN` 覆蓋） |
| 看板 | 瀏覽器打開 `http://192.168.139.130:4180/` |

### 常用命令（SSH 進去執行）

```bash
sudo systemctl status xuanpin      # 看狀態
sudo systemctl restart xuanpin     # 重啟
sudo journalctl -u xuanpin -f      # 跟蹤日誌
curl -s http://127.0.0.1:4180/healthz
```

更新代碼：把新的 `app.py` 覆蓋到 `/opt/xuanpin/app.py` 後 `sudo systemctl restart xuanpin`。

## 二、腳本側怎麼配

油猴面板裡「工作台地址」填 `http://192.168.139.130:4180`，「令牌」用默認那個 `xk_...` 即可。
腳本走 `GM_xmlhttpRequest`，https 的 shopee.tw 頁面調 http 後台不會被混合內容攔截。

> 腳本裡硬編碼的默認地址是舊的 `http://192.168.142.111:4180`，記得在面板裡改一次，改完存在 localStorage。

## 三、接口契約（與腳本逐條對齊）

所有經 `serverCall` 調用的接口，響應體都必須帶 `"ok": true`，否則腳本會拋「服務器返回錯誤」。
鑑權：請求頭 `X-Crawler-Token`，或 `?token=`，或 JSON body 裡的 `token`。

| 方法 | 路徑 | 用途 | 關鍵響應 |
|---|---|---|---|
| POST | `/api/crawler/ingest` | 商品入庫 | `{ok, runId, shops, products(新增數), duplicates}` |
| GET | `/api/crawler/monitor-list` | 下發監控名單+抓取條件 | `{ok, shops:[{username,shopName,intervalDays,lastCrawledAt,filters}], filters}` |
| POST | `/api/crawler/shops` | 保存/更新名單（週期、單店 filters） | `{ok, saved}` |
| GET/POST | `/api/hot-products` | 一鍵填入昨日爆品關鍵詞 | `{ok, products:[關鍵詞字串]}` |
| GET/POST | `/api/profit/select-brand-memory` | 品牌記憶同步 | GET `{ok, items:[{itemid,shopid,brand}]}` / POST `{items:[...]}` |
| GET | `/api/profit/select-collected-shops` | 近 30 天已採店鋪 + 違規詞庫 | `{ok, shops:[{id(=shopid),...}], bannedKeywords, brandNames}` |
| GET | `/api/profit/select-debug/cmd` | 長輪詢取遠程調試指令 | 有指令 `{ok,id,code}`；無指令 `{ok:true}` |
| POST | `/api/profit/select-debug/debug` | 選品日誌上報（陣列） | `{ok}` |
| POST | `/api/profit/select-debug/result` | 指令執行結果回填 | `{ok}` |
| POST | `/api/notify` | 完成/異常通知 | `{ok}` |
| GET | `/api/crawler/products` | 商品列表（看板用） | `{ok, products}` |
| GET | `/api/crawler/status` | 統計 | `{ok, stats, lastBatch}` |
| GET | `/healthz` | 健康檢查 | `{ok, service, version}` |
| GET | `/` | 可視化看板（HTML） | — |

## 四、幾個必須知道的實現細節

1. **價格換算**：腳本送的 `price` 是蝦皮原始值（新台幣 × 100000，例如 NT$300 → `30000000`）。入庫時按 `>= 10000` 判定並除以 100000，`products.price` 存的才是 NT$ 數值，`price_raw` 保留原值。用 200–500 的價格區間做二次篩選時，請用 `price` 字段。
2. **`shops[].id` 必須是 shopid**：腳本對 `select-collected-shops` 返回的 `id` 做 `Number(s.id)` 並與卡片 shopid 比對，所以沒有 shopid 的行不會返回（返回了也匹配不上）。
3. **`/api/hot-products` 返回的是關鍵詞字串陣列**，不是商品物件。默認從近 48 小時入庫商品按月銷取 Top15，用標題第一個語義片段做關鍵詞；也可以用 `POST {"keywords":[...]}` 手動覆蓋（存 `hot_keywords` 表）。
4. **違規類目詞庫**在 `app.py` 裡的 `BANNED_KEYWORDS`，改完重啟即可下發到腳本（腳本把它用於本地過濾）。
5. **去重**靠 `products.itemid` 的 UNIQUE 約束：重複商品只更新最新欄位，並計入 `duplicates`，不會重複插入。

## 五、驗收記錄（2026-11-10）

在本機對 192.168.139.130 實測：

- `ingest` 首次：`{"ok":true,"runId":1,"shops":1,"products":2,"duplicates":0}`
- `ingest` 重複同一批：`{"products":0,"duplicates":2}` —— 去重生效
- `products` 價格換算：`1001 → price=300.0`、`1002 → price=250.0`（原值 30000000/25000000）✅
- `monitor-list` 返回店鋪 + 全局 filters ✅
- `hot-products` 返回 `["日系保溫杯 500ml 不鏽鋼","韓版手機支架 桌面"]` ✅
- `select-brand-memory` POST/GET 正常，中文無亂碼 ✅
- `select-collected-shops` 返回 `id=123456`（shopid）、`bannedKeywords`、`brandNames` ✅
- 錯誤 token 被 401 拒絕 ✅
- 看板 `/` 返回 HTTP 200，標題「蝦皮選品工作台」✅

驗收後已清空測試庫（`xuanpin.db` 重建），現在 `status` 為全 0，乾淨待用。

## 六、注意事項

- 這台 Ubuntu 的 `ufw` 目前是 **inactive**，所以 4180 對局域網直通。若哪天開了 ufw，記得 `sudo ufw allow 4180/tcp`。
- Flask 自帶的是開發服務器（日誌裡會提示），單機小流量夠用；要扛併發就換 `gunicorn -w 4 -b 0.0.0.0:4180 app:app`。
- 另一台 CentOS 7（192.168.139.100:4180）上的舊後端仍在跑，兩者數據各自獨立，別把腳本地址填混。
