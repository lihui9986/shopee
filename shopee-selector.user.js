// ==UserScript==
// @name         蝦皮選品器 v3.5.3（台灣/海外雙選品）
// @namespace    shopee-crawler
// @version      3.5.3
// @description  支持局域網/穿透地址回傳（GM 特權請求繞過混合內容限制）；按週期自動補抓；每店單獨條件；源頭過濾；抓當前店鋪實時拉取工作台條件；選品模式（關鍵詞→搜索篩選→最後頁向前→自動進店採集）；品牌記憶（先查記憶直接跳過品牌，進店前再確認一次並記錄）
// @match        https://shopee.tw/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @updateURL    https://raw.githubusercontent.com/lihui9986/shopee/main/shopee-selector.user.js
// @downloadURL  https://raw.githubusercontent.com/lihui9986/shopee/main/shopee-selector.user.js
// ==/UserScript==

(function () {
  "use strict";
  if (window.__spCrawlerV15) return;
  window.__spCrawlerV15 = true;

  const SETTINGS_KEY = "sp_crawler_settings_v14";
  const QUEUE_KEY = "sp_crawler_queue_v14";
  const AUTO_KEY = "sp_crawler_auto_v14";
  const SELECT_STATE_KEY = "sp_select_state_v1";
  const SELECT_FLAG = "sp_crawler_select_v1";
  const STATUS_KEY = "sp_crawler_status_v14";
  // 运行状态用sessionStorage，多标签页互不冲突；设置和记忆仍用localStorage
  const tabStore = sessionStorage;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const HDRS = { "x-api-source": "pc", "X-Requested-With": "XMLHttpRequest" };
  const state = { running: false };
  const captured = { shopBases: [], items: [], itemDetails: new Map() };

  // 看门狗：超过10分钟无活动就发邮件+自动刷新
  let lastActivity = Date.now();
  let watchdogNotified = false;
  function touch() { lastActivity = Date.now(); }
  setInterval(() => {
    // 只要选品标志在就监控，不依赖其他条件
    if (!tabStore.getItem(SELECT_FLAG)) return;
    const idle = (Date.now() - lastActivity) / 1000;
    if (idle > 600 && !watchdogNotified) { // 10分钟
      watchdogNotified = true;
      sendNotify("⚠️ 脚本卡住了", `已 ${Math.round(idle/60)} 分钟无活动，自动刷新页面恢复。\n时间: ` + new Date().toLocaleString());
      setTimeout(() => location.reload(), 5000);
    }
  }, 30000); // 每30秒检查一次

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) {}
    if (!s.server) s.server = "http://192.168.142.111:4180";
    if (!s.token) s.token = "xk_3f824111e24061a698569f26ac0f85c9";
    return s;
  }
  function saveSettings(patch) {
    const next = { ...loadSettings(), ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }
  function setStatus(msg) { tabStore.setItem(STATUS_KEY, msg); }

  // 全局崩潰上報：未捕獲的異步異常打到面板狀態+調試通道，杜絕無聲卡死（頁面自身的 error 事件太吵，不掛）
  window.addEventListener("unhandledrejection", (event) => {
    try {
      const reason = event.reason;
      const text = reason && (reason.stack || reason.message) ? String(reason.stack || reason.message) : String(reason);
      const msg = `💥 選品異常: ${text.slice(0, 300)}`;
      setStatus(msg);
      dbgLog(msg);
    } catch (_) { /* 忽略 */ }
  });

  // 服務器請求走 GM 特權通道：不受 https 頁面調 http 的混合內容限制（其他設備也能推數據）
  function gmRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || "GET",
        url,
        headers: options.headers || {},
        data: options.body || null,
        timeout: 30000,
        onload: (response) => {
          try { resolve(JSON.parse(response.responseText)); }
          catch (_) { reject(new Error("服務器返回格式錯誤")); }
        },
        onerror: () => reject(new Error("網絡錯誤，請確認伺服器地址與防火牆")),
        ontimeout: () => reject(new Error("請求超時")),
      });
    });
  }

  async function serverCall(path, options = {}) {
    const settings = loadSettings();
    const server = (settings.server || "").replace(/\/+$/, "");
    const token = settings.token || "";
    if (!server || !token) throw new Error("請先填寫伺服器地址與令牌");
    const headers = { "X-Crawler-Token": token, ...(options.headers || {}) };
    const result = await gmRequest(server + path, { ...options, headers });
    if (!result.ok) throw new Error(result.error || "服務器返回錯誤");
    return result;
  }

  function installHooks() {
    if (window.__spHooksInstalled) return;
    window.__spHooksInstalled = true;
    // @grant 模式下頁面的 fetch/XHR 在 unsafeWindow 上，必須鉤那裡才能截獲頁面請求
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const origFetch = pageWindow.fetch;
    if (origFetch) {
      pageWindow.fetch = async function (...args) {
        const response = await Reflect.apply(origFetch, pageWindow, args);
        try {
          const url = String((args[0] && args[0].url) || args[0] || "");
          if (url.includes("/api/v4/shop/get_shop_base")) captured.shopBases.push(await response.clone().json());
          else if (url.includes("/api/v4/shop/search_items")) captured.items.push(await response.clone().json());
          else if (url.includes("/api/v4/pdp/get_pc") || url.includes("/api/v4/item/get")) captureItemDetail(await response.clone().json());
        } catch (_) { /* 忽略 */ }
        return response;
      };
    }
    const origOpen = pageWindow.XMLHttpRequest.prototype.open;
    const origSend = pageWindow.XMLHttpRequest.prototype.send;
    pageWindow.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__spUrl = String(url || "");
      return origOpen.apply(this, [method, url, ...rest]);
    };
    pageWindow.XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", () => {
        try {
          if (!this.__spUrl) return;
          if (this.__spUrl.includes("/api/v4/shop/get_shop_base")) captured.shopBases.push(JSON.parse(this.responseText));
          else if (this.__spUrl.includes("/api/v4/shop/search_items")) captured.items.push(JSON.parse(this.responseText));
          else if (this.__spUrl.includes("/api/v4/pdp/get_pc") || this.__spUrl.includes("/api/v4/item/get")) captureItemDetail(JSON.parse(this.responseText));
        } catch (_) { /* 忽略 */ }
      });
      return origSend.apply(this, args);
    };
  }

  // 商品詳情 API 的品牌信息：pdp/get_pc 與 item/get 兩代接口兼容解析，按 itemid 存最新一份
  function captureItemDetail(body) {
    try {
      const item = (body && body.data && body.data.item) || (body && body.item) || null;
      if (!item || item.itemid === undefined) return;
      const brand = item.brand || item.display_brand || null;
      const brandName = brand && typeof brand === "object" ? String(brand.name || brand.display_name || "") : "";
      const brandidRaw = brand && typeof brand === "object" ? brand.brandid : brand;
      const brandid = Number(brandidRaw);
      captured.itemDetails.set(Number(item.itemid), {
        itemid: Number(item.itemid),
        shopid: item.shopid !== undefined && item.shopid !== null ? Number(item.shopid) : null,
        brandName: brandName.slice(0, 80),
        brandid: Number.isFinite(brandid) && brandid > 0 ? brandid : null,
      });
      if (captured.itemDetails.size > 60) {
        captured.itemDetails.delete(captured.itemDetails.keys().next().value);
      }
    } catch (_) { /* 忽略 */ }
  }

  function parseNumber(text) {
    const m = String(text || "").replace(/,/g, "").match(/(\d+(\.\d+)?)/);
    return m ? Number(m[1]) : null;
  }

  function parseCard(a) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/-i\.(\d+)\.(\d+)/);
    if (!m) return null;
    const text = (a.innerText || "").trim();
    if (!text) return null;
    const container = a.closest("li") || a.parentElement;
    const containerText = container ? (container.innerText || "") : text;
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);

    let price = null;
    let rating = null;
    for (const line of lines) {
      if (rating === null) {
        const rm = line.match(/^(?:★\s*)?([0-5](?:\.\d+)?)$/);
        if (rm) { rating = Number(rm[1]); continue; }
      }
      if (price === null) {
        const pm = line.match(/^(?:NT)?[$＄sS]([\d,]+(?:\.\d+)?)(?:\s.*)?$/);
        if (pm) { price = parseNumber(pm[1]); continue; }
        if (/^[\d,]+$/.test(line)) {
          const n = parseNumber(line);
          if (n !== null && (n > 5 || line.includes(","))) price = n;
        }
      }
    }
    if (rating === null) {
      const rm2 = text.match(/([0-5](?:\.\d+)?)\s*(?:已售出|月銷)/);
      if (rm2) rating = Number(rm2[1]);
    }

    const listedMatch = containerText.match(/Listed On:?\s*(\d{4}-\d{2}-\d{2})/);
    const likesMatch = containerText.match(/Likes:?\s*(\d+)/);

    // 主图：卡片里的 img，取 data-src 或 src（蝦皮懶加載）
    const imgNode = a.querySelector("img");
    const imgRaw = imgNode ? (imgNode.getAttribute("data-src") || imgNode.getAttribute("src") || "") : "";
    const cardImage = imgRaw.startsWith("http") && !imgRaw.includes("gif;base64") ? imgRaw.split("?")[0] : "";

    return {
      itemid: Number(m[2]),
      shopid: Number(m[1]),
      name: (lines.reduce(
        (best, line) => (line.length > best.length && !/^(?:NT)?[$＄sS][\d,]/.test(line) && !/^[\d,]+(\.\d+)?[%折]?$/.test(line) ? line : best),
        "",
      ) || `商品 ${m[2]}`).slice(0, 300),
      url: `https://shopee.tw${href.split("?")[0]}`,
      price: price !== null ? Math.round(price * 100000) : null,
      price_before_discount: null,
      sold: parseNumber((text.match(/月銷[量]?\s*([\d,]+)/) || [])[1]),
      historical_sold: parseNumber((text.match(/已售出\s*([\d,]+)/) || [])[1]),
      stock: null,
      liked_count: likesMatch ? Number(likesMatch[1]) : null,
      rating_star: rating,
      item_rating: { rating_star: rating },
      ctime: listedMatch ? listedMatch[1] : null,
      t_ctime: listedMatch ? listedMatch[1] : "",
      item_status: "normal",
      is_official_shop: false,
      is_on_flash_sale: false,
      image: cardImage,
    };
  }

  function mergeItem(target, incoming) {
    for (const [key, value] of Object.entries(incoming)) {
      if (value === null || value === undefined || value === "") continue;
      if (key === "item_rating") {
        const existing = target.item_rating && target.item_rating.rating_star;
        target.item_rating = { rating_star: value.rating_star !== null ? value.rating_star : existing ?? null };
        continue;
      }
      if (target[key] === null || target[key] === undefined || target[key] === "") target[key] = value;
      else if (key === "name" && String(value).length > String(target[key]).length) target[key] = value;
    }
  }

  function mergeApiItems(seen) {
    for (const body of captured.items) {
      for (const entry of body.items || []) {
        const item = entry.item_basic || {};
        if (item.image === undefined && entry.image) item.image = entry.image;
        if (!item || item.itemid === undefined) continue;
        if (!item.url && item.shopid && item.itemid) item.url = `https://shopee.tw/product-i.${item.shopid}.${item.itemid}`;
        const existing = seen.get(item.itemid);
        if (existing) mergeItem(existing, item);
        else seen.set(item.itemid, item);
      }
    }
  }

  function scrapeDomInto(seen) {
    document.querySelectorAll('a[href*="-i."]').forEach((a) => {
      try {
        const card = parseCard(a);
        if (!card) return;
        const existing = seen.get(card.itemid);
        if (existing) mergeItem(existing, card);
        else seen.set(card.itemid, card);
      } catch (_) { /* 單個卡片失敗不影響其他 */ }
    });
  }

  function findSortTab(label) {
    const elements = document.querySelectorAll('button, a, div[role="button"], span, div');
    for (const el of elements) {
      if (el.childElementCount === 0 && el.textContent.trim() === label) return el;
    }
    return null;
  }

  function scrapeShopInfoFromDom() {
    const text = document.body ? document.body.innerText : "";
    const fans = (text.match(/([\d,.]+[萬万千Kk]?)\s*(?:位)?粉絲/) || [])[1];
    const rating = (text.match(/評價[:：]?\s*([\d.]+)/) || [])[1];
    return {
      follower_count: fans ? parseNumber(fans) : null,
      rating_star: rating ? Number(rating) : null,
    };
  }

  function pickShopInfo(username) {
    for (let i = captured.shopBases.length - 1; i >= 0; i -= 1) {
      const data = captured.shopBases[i] && captured.shopBases[i].data;
      if (data && (!username || (data.account && data.account.username === username) || data.username === username)) return data;
    }
    return captured.shopBases.length ? captured.shopBases[captured.shopBases.length - 1].data : null;
  }

  async function scrollCollect(seen, log) {
    let lastCount = -1;
    let stable = 0;
    let round = 0;
    while (stable < 3 && round < 80 && state.running) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1200);
      round += 1;
      scrapeDomInto(seen);
      mergeApiItems(seen);
      if (seen.size === lastCount) stable += 1; else stable = 0;
      lastCount = seen.size;
      log(`   已讀取 ${seen.size} 個商品（第 ${round} 輪）`);
    }
  }

  function describeFilters(filters) {
    const f = filters || {};
    const parts = [];
    if (f.soldMin !== null && f.soldMin !== undefined) parts.push(`月銷≥${f.soldMin}`);
    if (f.soldMax !== null && f.soldMax !== undefined) parts.push(`月銷≤${f.soldMax}`);
    if (f.histMin !== null && f.histMin !== undefined) parts.push(`總銷≥${f.histMin}`);
    if (f.histMax !== null && f.histMax !== undefined) parts.push(`總銷≤${f.histMax}`);
    if (f.priceMin !== null && f.priceMin !== undefined) parts.push(`金額≥${f.priceMin}`);
    if (f.priceMax !== null && f.priceMax !== undefined) parts.push(`金額≤${f.priceMax}`);
    return parts.length ? parts.join("，") : "無限制";
  }

  function applySourceFilter(items, filters, log) {
    const f = filters || {};
    // 默认价格过滤200-500，服务器没配也强制生效
    if (f.priceMin === null || f.priceMin === undefined) f.priceMin = 200;
    if (f.priceMax === null || f.priceMax === undefined) f.priceMax = 500;
    const hasFilter = ["soldMin", "soldMax", "histMin", "histMax", "priceMin", "priceMax"].some((k) => f[k] !== null && f[k] !== undefined);
    if (!hasFilter) return items;
    const kept = items.filter((item) => {
      const checks = [["soldMin", "sold", "<"], ["soldMax", "sold", ">"], ["histMin", "historical_sold", "<"], ["histMax", "historical_sold", ">"], ["priceMin", "price", "<"], ["priceMax", "price", ">"]];
      for (const [bound, field, direction] of checks) {
        const limit = f[bound];
        if (limit === null || limit === undefined) continue;
        const raw = item[field];
        if (raw === null || raw === undefined) return false;
        // 價格欄存的是 ×100000 原始刻度，換算回 NT$ 再比較
        const value = field === "price" ? raw / 100000 : raw;
        if (direction === "<" && value < limit) return false;
        if (direction === ">" && value > limit) return false;
      }
      return true;
    });
    log(`   源頭過濾：${items.length} 個中 ${kept.length} 個符合條件`);
    return kept;
  }

  async function pushShops(shops, log, sourceTag) {
    try {
      const result = await serverCall("/api/crawler/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: loadSettings().token, crawledAt: new Date().toISOString(), shops, sourceTag: sourceTag || "" }),
      });
      log(`✅ 已入庫：批次 #${result.runId}，${result.shops} 店鋪 / ${result.products} 商品`);
      if (result.duplicates) log(`⚠️ 提醒：其中 ${result.duplicates} 個商品之前已採集過，本次記錄為最新批次`);
      touch();
      return true;
    } catch (error) {
      log("❌ 入庫失敗：" + error.message);
      return false;
    }
  }

  async function fetchMonitorList(log) {
    try {
      const result = await serverCall("/api/crawler/monitor-list");
      return result;
    } catch (error) {
      log("❌ 同步名單失敗：" + error.message);
      return null;
    }
  }

  function isShopDue(shop, now) {
    if (!shop.intervalDays) return true;
    if (!shop.lastCrawledAt) return true;
    const last = new Date(shop.lastCrawledAt).getTime();
    if (!Number.isFinite(last)) return true;
    return now - last >= shop.intervalDays * DAY_MS;
  }

  // 抓當前店鋪前先從工作台拉最新條件：店鋪單獨條件優先，不在名單則用全局條件（實時同步）
  async function captureHereWithFreshFilters(log) {
    const username = (location.pathname.split("/")[1] || "").trim();
    if (!username || location.pathname.includes("/verify/")) {
      log("⚠️ 請先打開一家店鋪的頁面");
      return null;
    }
    let entry = null;
    try {
      const listResult = await serverCall("/api/crawler/monitor-list");
      const shops = listResult.shops || [];
      const match = shops.find((shop) => shop.username === username);
      if (match) {
        entry = { filters: match.filters };
        log(`📋 已取得「${username}」最新抓取條件`);
      } else if (listResult.filters) {
        entry = { filters: listResult.filters };
        log("📋 該店不在監控名單，改用工作台全局抓取條件");
      }
    } catch (error) {
      log("❌ 無法從工作台取得抓取條件：" + error.message);
      log("   拿不到條件本次不入庫；請檢查工作台地址與令牌後重試。");
      return null;
    }
    return captureCurrentShop(entry, log);
  }

  async function captureCurrentShop(shopEntry, log) {
    const username = (location.pathname.split("/")[1] || "").trim();
    if (!username || location.pathname.includes("/verify/")) {
      log("⚠️ 請先打開一家店鋪的頁面");
      return null;
    }
    state.running = true;
    log(`🧲 開始讀取頁面商品：${username}（抓取條件：${describeFilters(shopEntry && shopEntry.filters)}）`);
    await sleep(2500);
    const seen = new Map();
    let lastCount = -1;
    let stable = 0;
    let round = 0;
    while (stable < 3 && round < 80 && state.running) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1200);
      round += 1;
      scrapeDomInto(seen);
      mergeApiItems(seen);
      if (seen.size === lastCount) stable += 1; else stable = 0;
      lastCount = seen.size;
      log(`   已讀取 ${seen.size} 個商品（第 ${round} 輪）`);
    }
    // 第二遍：切「月銷熱賣」頁簽讀取月銷量（綜合排名視圖只有已售出）
    const monthlyTab = findSortTab("月銷熱賣");
    if (monthlyTab) {
      log("🔁 切換到「月銷熱賣」頁簽讀取月銷量…");
      monthlyTab.click();
      await sleep(3000);
      let mStable = 0;
      let mRound = 0;
      let mLast = seen.size;
      while (mStable < 3 && mRound < 80 && state.running) {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(1200);
        mRound += 1;
        scrapeDomInto(seen);
        mergeApiItems(seen);
        if (seen.size === mLast) mStable += 1; else mStable = 0;
        mLast = seen.size;
        log(`   月銷讀取 ${seen.size} 個（第 ${mRound} 輪）`);
      }
      const backTab = findSortTab("綜合排名");
      if (backTab) backTab.click();
    } else {
      log("⚠️ 沒有找到「月銷熱賣」頁簽，本次只採集已售出口徑");
    }
    if (!seen.size) {
      log("❌ 沒有讀到商品；請確認這是店鋪頁面且商品已顯示");
      state.running = false;
      return null;
    }
    const counts = new Map();
    for (const item of seen.values()) counts.set(item.shopid, (counts.get(item.shopid) || 0) + 1);
    let ownShopid = null;
    let best = 0;
    for (const [shopid, count] of counts) if (count > best) { best = count; ownShopid = shopid; }
    let items = ownShopid ? [...seen.values()].filter((item) => item.shopid === ownShopid) : [...seen.values()];
    items = applySourceFilter(items, shopEntry && shopEntry.filters, log);
    if (!items.length) {
      log("⚠️ 過濾後沒有符合條件的商品，本次不入庫");
      state.running = false;
      return null;
    }
    const hookBase = pickShopInfo(username);
    const domInfo = scrapeShopInfoFromDom();
    const shopInfo = {
      username,
      shopid: (hookBase && hookBase.shopid) || ownShopid,
      name: (hookBase && hookBase.name) || "",
      follower_count: (hookBase && hookBase.follower_count) || domInfo.follower_count,
      item_count: (hookBase && hookBase.item_count) || items.length,
      rating_star: (hookBase && hookBase.rating_star) || domInfo.rating_star,
      shop_rating: hookBase && hookBase.shop_rating,
      ctime: hookBase && hookBase.ctime,
      location: hookBase && hookBase.location,
      account: { username },
    };
    log(`🚀 推送 ${username}：${items.length} 個商品…`);
    const ok = await pushShops([{ username, shop_info: shopInfo, items }], log);
    state.running = false;
    return ok ? { username, count: items.length } : null;
  }

  // 同步名單並抓取：抓取全部監控店鋪（忽略週期）
  async function startSyncAllMode(log) {
    const listResult = await fetchMonitorList(log);
    if (!listResult) return;
    const all = listResult.shops || [];
    if (!all.length) { log("⚠️ 工作台名單為空，請先在「竞店爬虫」欄目保存名單"); return; }
    const queue = all.map((shop) => ({ username: shop.username, filters: shop.filters }));
    tabStore.setItem(QUEUE_KEY, JSON.stringify(queue));
    tabStore.setItem(AUTO_KEY, "1");
    setStatus(`同步抓取：0/${queue.length}`);
    log(`🤖 開始抓取全部 ${queue.length} 家監控店鋪，正在跳轉到第一家…`);
    state.running = true;
    location.href = "https://shopee.tw/" + queue[0].username;
  }

  // 抓取到期店鋪：只抓超過週期沒抓的
  async function startDueMode(log) {
    const listResult = await fetchMonitorList(log);
    if (!listResult) return;
    const now = Date.now();
    const all = listResult.shops || [];
    if (!all.length) { log("⚠️ 工作台名單為空，請先在「竞店爬虫」欄目保存名單"); return; }
    const due = all.filter((shop) => isShopDue(shop, now));
    const skipped = all.length - due.length;
    if (skipped) log(`⏭ ${skipped} 家店鋪未到抓取週期，已跳過`);
    if (!due.length) { log("✅ 所有店鋪都未到抓取週期，無需抓取"); return; }
    const queue = due.map((shop) => ({ username: shop.username, filters: shop.filters }));
    tabStore.setItem(QUEUE_KEY, JSON.stringify(queue));
    tabStore.setItem(AUTO_KEY, "1");
    setStatus(`補抓到期：0/${queue.length}`);
    log(`🤖 補抓 ${queue.length} 家到期店鋪，正在跳轉到第一家…`);
    state.running = true;
    location.href = "https://shopee.tw/" + queue[0].username;
  }

  async function continueAutoMode(log) {
    const queue = JSON.parse(tabStore.getItem(QUEUE_KEY) || "[]");
    if (!queue.length) {
      // 全部采完后等60秒自动重新拉爆款列表循环
      setStatus("等待60秒後自動重新拉爆款列表...");
      log("🔄 全部完成，60秒後自動重新拉取最新爆款列表繼續採集...");
      await sleep(60000);
      location.href = "https://shopee.tw/";
      return;
    }
    state.running = true;
    setStatus(`自動模式：進行中，剩餘 ${queue.length} 家`);
    await sleep(3000);
    const entry = queue[0];
    const result = await captureCurrentShop(entry, log);
    const rest = queue.slice(1);
    tabStore.setItem(QUEUE_KEY, JSON.stringify(rest));
    if (rest.length) {
      setStatus(`自動模式：已處理，剩餘 ${rest.length} 家`);
      log(`➡️ 3 秒後前往下一家：${rest[0].username}`);
      await sleep(3000);
      location.href = "https://shopee.tw/" + rest[0].username;
    } else {
      setStatus("等待60秒後自動重新拉爆款列表...");
      log("🔄 全部完成，60秒後自動重新拉取最新爆款列表繼續採集...");
      await sleep(60000);
      location.href = "https://shopee.tw/";
    }
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.style.cssText = "position:fixed;top:80px;right:16px;z-index:999999;width:320px;background:#fff;border:2px solid #ee4d2d;border-radius:8px;padding:10px;font:12px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)";
    const settings = loadSettings();
    panel.innerHTML =
      '<div style="font-weight:bold;color:#ee4d2d;margin-bottom:6px">蝦皮選品器 v3.5.3 · 台灣/海外雙選品</div>' +
      '<input class="sp-server" autocomplete="off" placeholder="工作台地址，其他電腦填 http://伺服器IP:4180" style="width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:4px 6px;margin-bottom:4px">' +
      '<input class="sp-token" autocomplete="off" placeholder="連接令牌（工作台爬虫欄目複製）" style="width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:4px 6px;margin-bottom:6px">' +
      '<label style="display:flex;align-items:center;gap:6px;margin-bottom:6px;cursor:pointer"><input type="checkbox" class="sp-auto-check"> 打開蝦皮時自動補抓到期店鋪</label>' +
      '<div style="margin:6px 0;display:flex;gap:6px">' +
      '<button class="sp-sync" style="flex:2;background:#ee4d2d;color:#fff;border:0;border-radius:4px;padding:6px;cursor:pointer">同步名單並抓取</button>' +
      '<button class="sp-due" style="flex:1;background:#b7791f;color:#fff;border:0;border-radius:4px;padding:6px;cursor:pointer">到期補抓</button>' +
      "</div>" +
      '<div style="margin:6px 0;display:flex;gap:6px">' +
      '<button class="sp-here" style="flex:1;background:#444;color:#fff;border:0;border-radius:4px;padding:6px;cursor:pointer">抓當前店鋪</button>' +
      '<button class="sp-stop" style="flex:1;background:#888;color:#fff;border:0;border-radius:4px;padding:6px;cursor:pointer">停止</button>' +
      "</div>" +
      '<div class="sp-status" style="margin-bottom:4px;color:#2b6cb0"></div>' +
      '<div class="sp-log" style="max-height:200px;overflow:auto;background:#f7f7f7;border-radius:4px;padding:6px;white-space:pre-wrap"></div>' +
        '<div style="margin:8px 0 4px;border-top:1px dashed #ddd;padding-top:6px">' +
      '<div style="font-weight:bold;color:#2b6cb0;margin-bottom:4px">選品模式（自動搜索→進店→採集）</div>' +
      '<input class="sp-sel-kw" autocomplete="off" placeholder="搜索關鍵詞（多個用逗號分隔，如：包包,手機殼）" style="width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:4px 6px;margin-bottom:4px">' +
      '<button class="sp-hot" style="width:100%;margin-bottom:4px;background:#e74c3c;color:#fff;border:0;border-radius:4px;padding:5px;cursor:pointer;font-size:12px">🔥 一鍵填入昨日爆品 Top15</button>' +
      '<div style="margin-bottom:4px">' +
      '<input class="sp-sel-min" autocomplete="off" placeholder="價格≥" style="width:49%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:5px 8px;font-size:12px">' +
      '<input class="sp-sel-maxp" autocomplete="off" placeholder="價格≤" style="width:49%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:5px 8px;font-size:12px">' +
      '</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:4px">' +
      '<input class="sp-sel-sold" autocomplete="off" placeholder="月銷≥" style="width:49%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:5px 8px;font-size:12px">' +
      '<input class="sp-sel-maxsold" autocomplete="off" placeholder="月銷≤" style="width:49%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:5px 8px;font-size:12px">' +
      '</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:4px">' +
      '<input class="sp-sel-stores" autocomplete="off" placeholder="店鋪上限" style="width:49%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:5px 8px;font-size:12px">' +
      '<input class="sp-sel-minpage" autocomplete="off" placeholder="頁碼下限(台灣)" style="width:49%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:5px 8px;font-size:12px">' +
      '</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:4px">' +
      '<input class="sp-sel-pages" autocomplete="off" placeholder="頁數上限(海外)" style="width:49%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:5px 8px;font-size:12px">' +
      '<input disabled placeholder="台灣不用頁數上限" style="width:49%;box-sizing:border-box;border:1px dashed #ddd;border-radius:4px;padding:5px 8px;font-size:12px;color:#aaa;background:#fafafa">' +
      '</div>' +
      '</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:4px">' +
      '<button class="sp-sel-start-tw" style="width:50%;background:#2b6cb0;color:#fff;border:0;border-radius:4px;padding:6px;cursor:pointer;font-weight:bold">🚀 台灣選品</button>' +
      '<button class="sp-sel-start-os" style="width:50%;background:#2f855a;color:#fff;border:0;border-radius:4px;padding:6px;cursor:pointer;font-weight:bold">🌏 海外選品</button>' +
      '</div>' +
      '<div style="display:flex;gap:4px;margin-top:4px">' +
      '<button class="sp-sel-pause" style="width:33%;background:#b7791f;color:#fff;border:0;border-radius:4px;padding:5px;cursor:pointer">⏸ 暫停</button>' +
      '<button class="sp-sel-resume" style="width:33%;background:#2f855a;color:#fff;border:0;border-radius:4px;padding:5px;cursor:pointer">▶ 繼續</button>' +
      '<button class="sp-sel-stop" style="width:33%;background:#718096;color:#fff;border:0;border-radius:4px;padding:5px;cursor:pointer">⏹ 停止</button>' +
      '</div>' +
      '<p style="margin:4px 0 0;font-size:11px;color:#888">條件固定：台灣發貨+月銷熱賣+>7天到+非品牌+非商城/優選+無Shopdora水印；從最後一頁向前跑。品牌商品會記入記憶，下次選品直接跳過。</p>' +
      '</div>' +
      '<div class="sp-bye" style="margin-top:4px;color:#999;cursor:pointer;text-align:right">收起面板</div>';
    document.body.appendChild(panel);

    const serverInput = panel.querySelector(".sp-server");
    const tokenInput = panel.querySelector(".sp-token");
    const autoCheck = panel.querySelector(".sp-auto-check");
    serverInput.value = settings.server || "";
    tokenInput.value = settings.token || "";
    // 選品參數記憶：自動回填上一次使用的值
    const selGet = (key, fallback) => {
      const v = tabStore.getItem("sp_sel_" + key);
      return v === null || v === "" ? fallback : v;
    };
    const prefill = (cls, key, fallback, numeric) => {
      const el = panel.querySelector(cls);
      if (!el) return;
      let v = selGet(key, fallback);
      if (numeric) { const n = Number(v); v = Number.isFinite(n) && n >= 0 ? String(n) : String(fallback); }
      if (key === "kw" && /^https?:\/\//.test(v)) { tabStore.removeItem("sp_sel_kw"); v = ""; }
      el.value = v;
    };
    prefill(".sp-sel-kw", "kw", "");
    prefill(".sp-sel-min", "min", "");
    prefill(".sp-sel-maxp", "maxPrice", "");
    prefill(".sp-sel-sold", "minSold", "");
    prefill(".sp-sel-maxsold", "maxSold", "");
    prefill(".sp-sel-stores", "stores", 10, true);
    prefill(".sp-sel-minpage", "minPage", 5, true);
    prefill(".sp-sel-pages", "maxPages", 30, true);
    const locEl = panel.querySelector(".sp-sel-loc");
    if (locEl) locEl.value = selGet("loc", "tw") === "overseas" ? "overseas" : "tw";
    // 🔥 一鍵填入昨日爆品
    panel.querySelector(".sp-hot").addEventListener("click", async () => {
      const btn = panel.querySelector(".sp-hot");
      btn.disabled = true; btn.textContent = "⏳ 載入中…";
      try {
        const s = loadSettings();
        const srv = (s.server || "").replace(/\/+$/, "");
        const resp = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: "GET", url: srv + "/api/hot-products",
            headers: { "X-Crawler-Token": s.token || "" }, timeout: 10000,
            onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch(_) { reject(new Error("解析失敗")); } },
            onerror: () => reject(new Error("網絡錯誤")),
          });
        });
        if (resp.ok && resp.products && resp.products.length) {
          const kwEl = panel.querySelector(".sp-sel-kw");
          kwEl.value = resp.products.join(",");
          kwEl.dispatchEvent(new Event("input", { bubbles: true }));
          log(`🔥 已填入 ${resp.products.length} 個昨日爆品關鍵詞`);
        } else {
          log("⚠️ 沒有查到昨日爆品數據");
        }
      } catch (e) {
        log("❌ 獲取爆品失敗: " + e.message);
      } finally {
        btn.disabled = false; btn.textContent = "🔥 一鍵填入昨日爆品 Top15";
      }
    });
    autoCheck.checked = Boolean(settings.autoCheck);
    const saveFromInputs = () => {
      const server = serverInput.value.trim();
      const token = tokenInput.value.trim();
      if (server && token) saveSettings({ server, token, autoCheck: autoCheck.checked });
      return { server, token };
    };
    serverInput.addEventListener("input", saveFromInputs);
    tokenInput.addEventListener("input", saveFromInputs);
    autoCheck.addEventListener("change", () => {
      saveSettings({ autoCheck: autoCheck.checked });
      log(autoCheck.checked ? "✅ 已開啟自動補抓：打開蝦皮頁面時會自動抓取到期店鋪" : "已關閉自動補抓");
    });

    const logBox = panel.querySelector(".sp-log");
    const statusBox = panel.querySelector(".sp-status");
    const log = (msg) => {
      const line = document.createElement("div");
      line.textContent = msg;
      logBox.appendChild(line);
      logBox.scrollTop = logBox.scrollHeight;
    };
    const savedStatus = tabStore.getItem(STATUS_KEY);
    if (savedStatus) statusBox.textContent = savedStatus;

    const toggleRunning = () => {
      panel.querySelector(".sp-sync").disabled = state.running;
      panel.querySelector(".sp-due").disabled = state.running;
      panel.querySelector(".sp-here").disabled = state.running;
    };
    const finishTask = () => { state.running = false; toggleRunning(); };
    panel.querySelector(".sp-sync").addEventListener("click", () => { if (!state.running) { saveFromInputs(); state.running = true; toggleRunning(); startSyncAllMode(log).catch((e) => { const m = `💥 任務異常: ${e && e.message ? e.message : e}`; log(m); setStatus(m); sendNotify("💥 抓取任務異常", m); }).finally(finishTask); } });
    panel.querySelector(".sp-due").addEventListener("click", () => { if (!state.running) { saveFromInputs(); state.running = true; toggleRunning(); startDueMode(log).catch((e) => { const m = `💥 任務異常: ${e && e.message ? e.message : e}`; log(m); setStatus(m); }).finally(finishTask); } });
    panel.querySelector(".sp-here").addEventListener("click", () => { if (!state.running) { saveFromInputs(); state.running = true; toggleRunning(); captureHereWithFreshFilters(log).catch((e) => { const m = `💥 任務異常: ${e && e.message ? e.message : e}`; log(m); setStatus(m); }).finally(finishTask); } });
    panel.querySelector(".sp-stop").addEventListener("click", () => { state.running = false; tabStore.removeItem(AUTO_KEY); tabStore.removeItem(SELECT_FLAG); saveSelectState(null); log("⏹ 已停止"); });
    panel.querySelector(".sp-sel-start-tw").addEventListener("click", () => { if (!state.running) { state.running = true; tabStore.setItem("sp_crawler_loop", "1"); toggleRunning(); startSelectMode(log, "tw").catch((e) => selLog(log, `💥 啟動異常: ${e && e.message ? e.message : e}`)).finally(finishTask); } });
    panel.querySelector(".sp-sel-start-os").addEventListener("click", () => { if (!state.running) { state.running = true; tabStore.setItem("sp_crawler_loop", "1"); toggleRunning(); startSelectMode(log, "os").catch((e) => selLog(log, `💥 啟動異常: ${e && e.message ? e.message : e}`)).finally(finishTask); } });
    panel.querySelector(".sp-sel-stop").addEventListener("click", () => {
      state.running = false;
      tabStore.removeItem(SELECT_FLAG);
      tabStore.removeItem("sp_crawler_loop");
      saveSelectState(null);
      setStatus("選品模式：已停止");
      log("⏹ 選品已停止（進度清除）");
    });
    panel.querySelector(".sp-sel-pause").addEventListener("click", () => {
      const sel = loadSelectState();
      if (!sel || !tabStore.getItem(SELECT_FLAG)) { log("沒有進行中的選品任務"); return; }
      sel.paused = true;
      saveSelectState(sel);
      state.running = false;
      setStatus("選品模式：已暫停");
      log("⏸ 已暫停——進度已保存，點「繼續」恢復運行");
    });
    panel.querySelector(".sp-sel-resume").addEventListener("click", () => {
      const sel = loadSelectState();
      if (!sel || !sel.paused) { log("沒有已暫停的選品任務"); return; }
      sel.paused = false;
      saveSelectState(sel);
      state.running = true;
      setStatus("選品模式：繼續");
      log("▶ 繼續運行未完成任務…");
      continueSelectMode(log);
    });
    for (const [cls, key, numeric] of [[".sp-sel-kw", "kw"], [".sp-sel-min", "min"], [".sp-sel-maxp", "maxPrice"], [".sp-sel-sold", "minSold"], [".sp-sel-maxsold", "maxSold"], [".sp-sel-stores", "stores", 1], [".sp-sel-minpage", "minPage", 1], [".sp-sel-pages", "maxPages", 1], [".sp-sel-loc", "loc"]]) {
      const el = panel.querySelector(cls);
      if (el) el.addEventListener("input", () => {
        let v = el.value.trim();
        if (numeric) { const n = Number(v); v = Number.isFinite(n) && n >= 0 ? String(n) : ""; }
        tabStore.setItem("sp_sel_" + key, v);
      });
    }
    panel.querySelector(".sp-bye").addEventListener("click", () => panel.remove());

    // 選品模式續跑：標誌存在時任何頁面載入都繼續流程
    if (!window.__spDbgLoop && loadSettings().token) { window.__spDbgLoop = true; dbgCommandLoop(); }
    if (tabStore.getItem(SELECT_FLAG)) {
      log("🔁 選品模式繼續…");
      continueSelectMode(log).catch((e) => { const msg = `💥 續跑異常: ${e && e.message ? e.message : e}`; log(msg); setStatus(msg); dbgLog(msg); });
      return;
    }
    // 自動循環：首頁載入時如果循環模式開著，自動拉爆款列表開始
    if (tabStore.getItem("sp_crawler_loop") === "1" && (location.pathname === "/" || location.pathname === "")) {
      log("🔄 循環模式：自動拉取最新爆款列表...");
      setTimeout(() => document.querySelector(".sp-hot")?.click(), 3000);
      return;
    }
    // 定時補抓：開關打開時，首頁載入後自動檢查到期店鋪並開始抓取
    if (settings.autoCheck && !tabStore.getItem(AUTO_KEY) && (location.pathname === "/" || location.pathname === "")) {
      log("🕐 自動補抓檢查中…");
      startDueMode(log);
      return;
    }
    if (tabStore.getItem(AUTO_KEY) === "1") {
      if (location.pathname.includes("/verify/")) {
        tabStore.removeItem(AUTO_KEY);
        setStatus("自動模式被風控中斷");
        log("❌ 蝦皮風控攔截了頁面。請稍等幾分鐘再試，或換一個節點後重新點「同步名單並抓取」。");
        sendNotify("⚠️ 被蝦皮風控攔截", "自動抓取被風控中斷，請檢查頁面。\n時間: " + new Date().toLocaleString());
        return;
      }
      continueAutoMode(log);
    }
  }

  function selLog(log, text) { log(text); dbgLog(text); }
  // ==================== 選品模式（關鍵詞→搜索→最後頁向前→進店採集） ====================
  // 遠程調試通道：選品日誌同步到本機調試服務，管理員可實時觀察並下發檢測指令
  let dbgQueue = [];
  let dbgBusy = false;
  function dbgPost(path, body) {
    const settings = loadSettings();
    const server = (settings.server || "").replace(/\/+$/, "");
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `${server}/api/profit/select-debug${path}`,
        headers: { "Content-Type": "application/json", "X-Crawler-Token": settings.token || "" },
        data: JSON.stringify(body),
        timeout: 8000,
        onload: () => resolve(true),
        onerror: () => resolve(false),
        ontimeout: () => resolve(false),
      });
    });
  }
  function dbgFlush() {
    // 發後即忘：不因單次失敗卡死後續日誌
    while (dbgQueue.length) {
      const batch = dbgQueue.splice(0, 20);
      dbgPost("/debug", batch);
    }
  }
  function dbgLog(text) {
    dbgQueue.push(text);
    dbgFlush();
  }
  async function dbgCommandLoop() {
    // 長輪詢取指令：eval 任意檢測代碼並回傳結果（僅調試期間開啟）
    while (true) {
      const settings2 = loadSettings();
      const server2 = (settings2.server || "").replace(/\/+$/, "");
      const raw = await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: `${server2}/api/profit/select-debug/cmd`,
          headers: { "X-Crawler-Token": settings2.token || "" },
          timeout: 30000,
          onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch (_) { resolve(null); } },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      });
      if (raw && raw.code) {
        let result = "";
        try { result = String(await eval(raw.code)); }
        catch (e) { result = "ERROR: " + (e && e.message); }
        dbgPost("/result", { id: raw.id, result: result.slice(0, 7000) });
      }
      // 成功 400ms 輪詢；失敗/超時退避 5s，避免工作台關閉時高頻空打
      await sleep(raw ? 400 : 5000);
    }
  }


  // ---- 郵件通知：完成/異常/風控時推送 ----
  function sendNotify(title, content) {
    try {
      const settings = loadSettings();
      const server = (settings.server || "").replace(/\/+$/, "");
      if (!server || !settings.token) return;
      GM_xmlhttpRequest({
        method: "POST",
        url: server + "/api/notify",
        headers: { "Content-Type": "application/json", "X-Crawler-Token": settings.token || "" },
        data: JSON.stringify({ title: title, content: content }),
        timeout: 10000,
        onload: () => { try { dbgLog("📧 通知已發送: " + title); } catch(_){} },
        onerror: () => {},
      });
    } catch (_) {}
  }

  function loadSelectState() {
    try { return JSON.parse(tabStore.getItem(SELECT_STATE_KEY)) || null; } catch (_) { return null; }
  }
  function saveSelectState(st) {
    if (st === null) tabStore.removeItem(SELECT_STATE_KEY);
    else tabStore.setItem(SELECT_STATE_KEY, JSON.stringify(st));
  }

  function buildApiItemMap() {
    const map = new Map();
    for (const body of captured.items) {
      for (const entry of body.items || []) {
        const basic = entry.item_basic || entry;
        if (basic && basic.itemid !== undefined) map.set(Number(basic.itemid), basic);
      }
    }
    return map;
  }

  // 卡片選品過濾：>7天到、非隔天/後天、非優選、非商城、非品牌、無 Shopdora 覆蓋
  function cardQualifiesSelect(container, apiItem, minSold, maxSold, mode) {
    const text = (container.innerText || "");
    if (mode === "tw") {
      if (!text.includes(">7天到")) return "非>7天到";
      if (/隔天到|後天到|次日到|當天到/.test(text)) return "隔天/後天到";
    }
    if (apiItem && apiItem.name && /代購|代购/.test(apiItem.name)) return "代購商品";
    if (/蝦皮商城|官方旗艦/.test(text)) return "商城/官方店";
    if (container.querySelector('img[alt*="商城"], img[alt*="官方"], img[alt*="旗艦"], img[alt*="優選"]')) return "商城/官方店徽標";
    if (/蝦皮優選|優選/.test(text)) return "蝦皮優選";
    const link = container.matches && container.matches('a[href*="-i."]') ? container : container.querySelector('a[href*="-i."]');
    const href = link ? (link.getAttribute("href") || "") : "";
    if (/\/mall\//.test(href)) return "商城店";
    // 月銷過濾只在店內採集階段做（用戶規則：搜索頁不管月銷）
    if (apiItem) {
      if (apiItem.is_official_shop) return "商城/官方店";
      if (apiItem.brand && apiItem.brand.name) return "品牌商品";
      for (const key of Object.keys(apiItem)) {
        if (/preferred/i.test(key) && apiItem[key]) return "蝦皮優選";
      }
    }
    return "";
  }

  // 仿人節奏：隨機延遲（基礎 ms 的 100%~160%）
  function humanSleep(base) {
    touch();
    const SLOW = 1.6; // 风控期减速系数：1=正常，>1=更慢更安全
    return sleep(base * SLOW + Math.floor(Math.random() * base * SLOW * 0.5));
  }

  // 等頁面真的出卡片（仿真人等加載），最多 timeoutMs
  async function waitForCards(minCount, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (state.running === false) return false;
      if (document.querySelectorAll('a[href*="-i."]').length >= minCount) { touch(); return true; }
      await sleep(700 + Math.floor(Math.random() * 700));
    }
    return document.querySelectorAll('a[href*="-i."]').length > 0;
  }

  // 解析搜索結果總頁數（右上角 1/17 樣式）
  function setNativeValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function withPage(url, page) {
    try {
      const u = new URL(url);
      u.searchParams.set("page", page);
      return u.toString();
    } catch (_) {
      return url + (url.includes("?") ? "&" : "?") + "page=" + page;
    }
  }

  function findTextButton(text) {
    for (const el of document.querySelectorAll('button, a, div[role="button"], span')) {
      if (el.childElementCount <= 1 && (el.textContent || "").trim() === text) return el;
    }
    return null;
  }

  // 像真人一樣在搜索頁上應用篩選：月銷熱賣 → 台灣 → 價格區間
  async function applySelectFilters(sel, log) {
    // 1) 月銷熱賣排序（點擊後驗證 URL 變化，失敗重試最多 3 次）
    let sortOk = false;
    for (let sortTry = 0; sortTry < 3 && !sortOk; sortTry += 1) {
      const sortTab = findSortTab("月銷熱賣");
      if (!sortTab) { selLog(log, "❌ 找不到月銷熱賣按鈕"); break; }
      sortTab.click();
      await humanSleep(3000);
      if (location.href.includes("sortBy=sales")) {
        sortOk = true;
        selLog(log, "✅ 月銷熱賣排序已生效");
      } else {
        selLog(log, `⚠️ 月銷熱賣點擊未生效（第 ${sortTry + 1} 次），重試…`);
      }
    }
    if (!sortOk) selLog(log, "⚠️ 排序可能未生效，繼續後續篩選");
    // 2) 出貨地點：按面板選擇點 台灣 或 海外
    const locText = sel.loc === "overseas" ? "海外" : "台灣";
    const locRe = new RegExp("^" + locText);
    let locDone = false;
    for (const box of document.querySelectorAll('input[type="checkbox"]')) {
      const holder = box.closest("label") || box.parentElement;
      const t = ((holder && holder.innerText) || "").trim();
      if (locRe.test(t)) {
        if (!box.checked) box.click();
        locDone = true;
        break;
      }
    }
    if (!locDone) {
      for (const el of document.querySelectorAll("label, div, span")) {
        if (el.childElementCount > 2) continue;
        const t = (el.innerText || "").trim();
        if (locRe.test(t)) {
          const target = el.querySelector("input") || el;
          target.click();
          locDone = true;
          break;
        }
      }
    }
    if (locDone) {
      // 驗證 checkbox 實際生效
      let verified = false;
      for (const box of document.querySelectorAll('input[type="checkbox"]')) {
        const holder = box.closest("label") || box.parentElement;
        const t = ((holder && holder.innerText) || "").trim();
        if (locRe.test(t) && box.checked) { verified = true; break; }
      }
      if (verified) {
        selLog(log, `✅ 已勾選出貨地「${locText}」（已驗證）`);
      } else {
        selLog(log, `⚠️ 出貨地「${locText}」點擊了但未確認生效，繼續`);
      }
      await humanSleep(2600);
    } else {
      selLog(log, `❌ 出貨地「${locText}」複選框沒找到——請手動勾選後重跑`);
    }
    // 3) 價格範圍（最低/最高輸入框 + 使用按鈕）
    if (sel.min > 0 || sel.maxPrice > 0) {
      const maxInput = document.querySelector('input[placeholder*="最大"], input[placeholder*="最高"]');
      if (maxInput) {
        const boxRow = maxInput.closest("div");
        const inputs = (boxRow ? boxRow.querySelectorAll("input") : []);
        let minInput = null;
        for (const el of inputs) { if (el !== maxInput && /最低|最小|低/.test(el.placeholder || "")) minInput = el; }
        if (!minInput) { for (const el of inputs) { if (el !== maxInput) minInput = el; } }
        if (sel.min > 0 && minInput) setNativeValue(minInput, String(sel.min));
        if (sel.maxPrice > 0) setNativeValue(maxInput, String(sel.maxPrice));
        await humanSleep(600);
        const applyBtn = findTextButton("使用") || findTextButton("確定") || findTextButton("套用");
        if (applyBtn) {
          applyBtn.click();
          await humanSleep(2000);
          const urlOk = location.href.includes("fe_filter_options") || location.href.includes("lowestPrice");
          selLog(log, urlOk ? `✅ 已填價格 ${sel.min}~${sel.maxPrice || "∞"} 並點「使用」（URL 已生效）` : `⚠️ 價格已填但 URL 未確認，繼續`);
        }
        else { maxInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); selLog(log, "✅ 已填價格並回車"); }
        await humanSleep(2800);
      } else {
        selLog(log, "❌ 價格輸入框沒找到（佔位符不是最大值/最高值）——請手動填後重跑");
      }
    }
  }

  // 分頁器：找「1/9」樣式的頁碼指示
  function findPagerInfo() {
    const all = document.querySelectorAll("*");
    for (const el of all) {
      const t = (el.innerText || "").replace(/\s/g, "");
      if (t.length > 12) continue;
      const m = t.match(/^(\d{1,3})\/(\d{1,4})$/);
      if (m && Number(m[2]) >= Number(m[1]) && Number(m[2]) >= 2) return { el, cur: Number(m[1]), total: Number(m[2]) };
    }
    return null;
  }

  // 從「1/9」元素向右找下一頁箭頭：比較水平位置取最右的可點擊按鈕
  function findPagerNext(pagerEl) {
    const pr = pagerEl.getBoundingClientRect();
    let box = pagerEl.parentElement;
    for (let level = 0; level < 6 && box; level += 1) {
      const btns = [...box.querySelectorAll("button, a, [role=\"button\"], [class*=\"btn\"]")].filter((b) => {
        if (b === pagerEl || pagerEl.contains(b)) return false;
        const r = b.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const t = (b.innerText || "").trim();
        if (/^\d+$/.test(t)) return false;
        return r.left >= pr.left - 20;
      });
      if (btns.length) {
        btns.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return btns[btns.length - 1];
      }
      box = box.parentElement;
    }
    return null;
  }

  // 診斷：把頁面上所有含「數字/數字」的元素樣本回傳（定位失敗時用）
  function pagerDiagnostics() {
    const samples = [];
    for (const el of document.querySelectorAll("*")) {
      const t = (el.innerText || "").replace(/\s/g, "");
      if (t.length <= 12 && /\d\/.+\d/.test(t) && el.childElementCount === 0 && samples.length < 6) {
        samples.push(t.slice(0, 20) + "|" + (el.className || "").toString().slice(0, 40));
      }
    }
    return samples;
  }

  // 在分頁器附近找「下一頁」按鈕（> 箭頭）
  function findPagerNext(pagerEl) {
    let box = pagerEl.parentElement;
    for (let i = 0; i < 4 && box; i += 1) {
      const btns = [...box.querySelectorAll("button, a")].filter((b) => {
        const t = (b.innerText || "").trim();
        const label = (b.getAttribute("aria-label") || "") + b.className;
        return t === ">" || /next/i.test(label) || /arrow.*right|right.*arrow/i.test(label);
      });
      if (btns.length) return btns[btns.length - 1];
      box = box.parentElement;
    }
    return null;
  }

  // 店鋪頁頭資料卡內的商城/優選徽標：從「聊聊」按鈕向上找含 關注+聊聊 的頁頭卡片，只查該卡片文字（避免頁腳誤判）
  function shopHeaderMallHit() {
    let chatBtn = null;
    for (const el of document.querySelectorAll("button, a, div")) {
      if (el.childElementCount > 1) continue;
      const t = (el.textContent || "").trim();
      if (t === "聊聊") { chatBtn = el; break; }
    }
    if (!chatBtn) return false;
    let box = chatBtn.parentElement;
    for (let i = 0; i < 6 && box; i += 1) {
      const t = box.innerText || "";
      if (t.includes("關注") && t.includes("聊聊")) {
        return /蝦皮商城|蝦皮優選/.test(t);
      }
      box = box.parentElement;
    }
    return false;
  }

  // 店鋪採集記憶：30 天內採集過的店不再重複採集
  const SHOP_MEMORY_KEY = "sp_sel_shop_memory";
  const SHOP_MEMORY_DAYS = 30;
  function loadShopMemory() {
    try { return JSON.parse(localStorage.getItem(SHOP_MEMORY_KEY)) || []; } catch (_) { return []; }
  }
  function saveShopMemory(list) {
    localStorage.setItem(SHOP_MEMORY_KEY, JSON.stringify(list.slice(-300)));
  }
  function wasShopCollectedRecently(shopid) {
    return recentShopCollector(shopid) !== "";
  }

  // 返回近 30 天內採集過該店的賬號名（跨全部員工賬號），未採集返回 ""
  function recentShopCollector(shopid) {
    const id = Number(shopid);
    if (!id) return "";
    for (const s of window.__spCollectedShops || []) {
      if (Number(s.id) === id) return s.by || "其他賬號";
    }
    const cutoff = Date.now() - SHOP_MEMORY_DAYS * 24 * 60 * 60 * 1000;
    for (const e of loadShopMemory().filter((e) => e.at >= cutoff)) {
      if (Number(e.id) === id) return "本地記憶";
    }
    return "";
  }
  function rememberShopCollected(shopid, name) {
    if (!shopid) return;
    const list = loadShopMemory().filter((e) => Number(e.id) !== Number(shopid));
    list.push({ id: Number(shopid), name: String(name || "").slice(0, 60), at: Date.now() });
    saveShopMemory(list);
  }

  // ==================== 品牌記憶：確認過的品牌商品，下次選品在搜索頁就直接跳過 ====================
  // 本地 localStorage 存檔 + 服務器 /api/profit/select-brand-memory 同步（跨設備有效，180 天窗口）
  const BRAND_MEMORY_KEY = "sp_sel_brand_memory";
  const BRAND_MEMORY_DAYS = 180;
  const brandMemoryIds = new Set();
  let brandMemoryLoaded = false;
  let brandServerQueue = [];
  let brandServerTimer = null;

  function loadBrandMemoryLocal() {
    try {
      const cutoff = Date.now() - BRAND_MEMORY_DAYS * DAY_MS;
      return (JSON.parse(localStorage.getItem(BRAND_MEMORY_KEY)) || [])
        .filter((e) => e && Number.isFinite(Number(e.i)) && Number(e.i) > 0 && Number(e.at) >= cutoff);
    } catch (_) { return []; }
  }

  function ensureBrandMemoryLoaded() {
    if (brandMemoryLoaded) return;
    brandMemoryLoaded = true;
    for (const entry of loadBrandMemoryLocal()) brandMemoryIds.add(Number(entry.i));
  }

  function isKnownBrandItem(itemid) {
    ensureBrandMemoryLoaded();
    const id = Number(itemid);
    return Number.isFinite(id) && id > 0 && brandMemoryIds.has(id);
  }

  // 品牌名記憶：同名品牌的其他商品也跳過（名字 >= 3 字符才比對，避免誤判）
  function isKnownBrandName(name) {
    ensureBrandMemoryLoaded();
    const n = String(name || "").trim().toLowerCase();
    if (n.length < 3) return false;
    for (const entry of loadBrandMemoryLocal()) {
      const b = String(entry.b || "").trim().toLowerCase();
      if (b.length >= 3 && (n === b || n.includes(b))) return true;
    }
    return false;
  }

  // 登記品牌商品：本地立即生效，稍後合併批量同步到服務器
  function rememberBrandItem(itemid, shopid, brandName) {
    const id = Number(itemid);
    if (!Number.isFinite(id) || id <= 0) return;
    ensureBrandMemoryLoaded();
    if (brandMemoryIds.has(id)) return;
    brandMemoryIds.add(id);
    const list = loadBrandMemoryLocal().filter((e) => Number(e.i) !== id);
    list.push({ i: id, s: Number(shopid) || null, b: String(brandName || "").slice(0, 80), at: Date.now() });
    while (list.length > 2000) list.shift();
    try { localStorage.setItem(BRAND_MEMORY_KEY, JSON.stringify(list)); } catch (_) { /* 存滿不影響流程 */ }
    queueBrandSync({ itemid: id, shopid: Number(shopid) || null, brand: String(brandName || "").slice(0, 80) });
  }

  function queueBrandSync(entry) {
    brandServerQueue.push(entry);
    if (brandServerTimer) return;
    brandServerTimer = setTimeout(() => {
      brandServerTimer = null;
      const batch = brandServerQueue.splice(0, 100);
      const settings = loadSettings();
      const server = (settings.server || "").replace(/\/+$/, "");
      if (!batch.length || !server || !settings.token) return;
      GM_xmlhttpRequest({
        method: "POST",
        url: `${server}/api/profit/select-brand-memory`,
        headers: { "Content-Type": "application/json", "X-Crawler-Token": settings.token || "" },
        data: JSON.stringify({ items: batch }),
        timeout: 15000,
      });
    }, 4000);
  }

  // 啟動選品時從服務器合併品牌記憶（其他設備登記過的也生效）
  function applyServerBrandMemory(items) {
    ensureBrandMemoryLoaded();
    let applied = 0;
    const local = loadBrandMemoryLocal();
    const known = new Set(local.map((e) => Number(e.i)));
    for (const row of Array.isArray(items) ? items : []) {
      const id = Number(row && row.itemid);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (!brandMemoryIds.has(id)) applied += 1;
      brandMemoryIds.add(id);
      if (!known.has(id)) {
        known.add(id);
        local.push({ i: id, s: Number(row.shopid) || null, b: String(row.brand || "").slice(0, 80), at: Date.now() });
      }
    }
    while (local.length > 2000) local.shift();
    try { localStorage.setItem(BRAND_MEMORY_KEY, JSON.stringify(local)); } catch (_) { /* 存滿不影響流程 */ }
    return applied;
  }

  // 商品頁品牌判定：先查詳情 API 捕獲（權威），拿不到再兜底掃「品牌：xxx」規格行
  function currentProductBrand() {
    const m = location.pathname.match(/-i\.(\d+)\.(\d+)/);
    const itemid = m ? Number(m[2]) : null;
    if (!itemid) return null;
    const detail = captured.itemDetails.get(itemid);
    if (detail) {
      return (detail.brandName || detail.brandid) ? { itemid, shopid: detail.shopid, name: detail.brandName || `品牌ID:${detail.brandid}` } : null;
    }
    const lines = (document.body ? document.body.innerText : "").split("\n").map((s) => s.trim());
    for (let i = 0; i < lines.length; i += 1) {
      let value = "";
      const inline = lines[i].match(/^品牌[:：]\s*(.{1,40})$/);
      if (inline) value = inline[1].trim();
      else if (lines[i] === "品牌" && lines[i + 1] && lines[i + 1].length <= 40) value = lines[i + 1];
      if (!value) continue;
      if (/^(無品牌|無|沒有|沒有品牌|no brand|none|n\/?a|other|其他|其他品牌|不適用|自有品牌)/i.test(value)) return null;
      return { itemid, shopid: m ? Number(m[1]) : null, name: value };
    }
    return null;
  }

  // 標題命中品牌詞庫表格（工作台品牌词库.xlsx，用戶可維護）
  function brandSheetHit(name) {
    const list = window.__spSheetBrands || [];
    if (!list.length || !name) return "";
    const n = String(name).toLowerCase();
    if (!n) return "";
    for (const b of list) {
      const bn = String(b || "").trim().toLowerCase();
      if (!bn) continue;
      if (/^[a-z0-9'.& ]+$/.test(bn)) {
        // 拉丁品牌：詞邊界匹配（避免 MK 匹配單詞內部）
        const re = new RegExp("(^|[^a-z0-9])" + bn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9]|$)");
        if (re.test(n)) return b;
      } else if (n.includes(bn)) {
        return b;
      }
    }
    return "";
  }

  // 標題命中違規類目詞庫（工作台可維護，簡繁都要加）
  function bannedKeywordHit(name) {
    const list = window.__spBannedKeywords || [];
    if (!list.length || !name) return "";
    const n = String(name);
    for (const kw of list) {
      if (kw && n.toLowerCase().includes(kw.toLowerCase())) return kw;
    }
    return "";
  }

  function currentSearchPageParam() {
    const m = location.href.match(/[?&]page=(\d+)/);
    return m ? Number(m[1]) : 1;
  }

  async function selectModeSearchPhase(sel, log) {
    if (state.running === false) { selLog(log, "⏹ 已停止"); return; }
    sel.page = currentSearchPageParam();
    selLog(log, `🔎 搜索頁第 ${sel.page} 頁，等待加載…`);
    // 空結果頁檢測（不等加載超時，直接看文案）
    const bodyNow = document.body ? document.body.innerText : "";
    const isEmptyPage = /找不到任何商品|找不到結果|找不到相關結果/.test(bodyNow);
    if (isEmptyPage) {
      const step = sel.emptyStep || 0;
      if (step === 0) {
        // 第一次：先刷新頁面，看是否恢復
        sel.emptyStep = 1;
        saveSelectState(sel);
        selLog(log, "⚠️ 空結果頁——先刷新頁面看看是否恢復…");
        await humanSleep(2000);
        location.reload();
        return;
      }
      if (step === 1) {
        // 刷新後仍空：點左上角「蝦皮購物」Logo 重置回首頁
        sel.emptyStep = 2;
        saveSelectState(sel);
        selLog(log, "⚠️ 刷新後仍空——點蝦皮購物 Logo 回首頁重置");
        const logo = [...document.querySelectorAll("a")].find((a) => (a.getAttribute("href") || "") === "/" && /蝦皮/.test(a.innerText || a.innerHTML || ""));
        if (logo) { logo.click(); await humanSleep(3000); }
        location.href = "https://shopee.tw/";
        return;
      }
      // Logo 重置後從搜索詞重新開始（記憶會自動跳過已採集的店）
      if (sel.restartCount === undefined) sel.restartCount = 0;
      sel.restartCount += 1;
      sel.emptyStep = 0;
      sel.page = 1;
      sel.jumped = false;
      sel.refilteredCurrent = false;
      sel.pendingCards = [];
      sel.phase = "search";
      saveSelectState(sel);
      if (sel.restartCount > 2) {
        selLog(log, "❌ 重啟後仍找不到商品，選品結束（可放寬條件後重試）");
        selectModeFinish(log);
        return;
      }
      selLog(log, `🔄 第 ${sel.restartCount} 次從搜索詞重新開始…`);
      await humanSleep(2500);
      location.href = `https://shopee.tw/search?keyword=${encodeURIComponent(sel.kw)}`;
      return;
    }
    const ready = await waitForCards(8, 20000);
    // 第一次：像真人一樣應用篩選（月銷熱賣→台灣→價格），然後記下蝦皮自己生成的篩選 URL
    if (!sel.filtersApplied) {
      await humanSleep(2000);
      await applySelectFilters(sel, log);
      sel.filtersApplied = true;
      await humanSleep(2200);
      await waitForCards(8, 15000);
      sel.searchUrl = location.href.split("#")[0];
      saveSelectState(sel);
      selLog(log, `📎 篩選後網址：${sel.searchUrl.slice(0, 120)}`);
    }
    // 跳最後一頁（僅台灣模式）：像真人一樣連點「下一頁」按鈕直到最後頁
    if (sel.mode === "tw" && !sel.jumped) {
      const pg = findPagerInfo();
      if (pg && pg.total > sel.minPage && pg.cur < pg.total) {
        sel.jumped = true;
        saveSelectState(sel);
        selLog(log, `⏭ 共 ${pg.total} 頁，像真人一樣逐頁點到最後一頁…`);
        let stuck = 0;
        while (state.running) {
          const info = findPagerInfo();
          if (!info || info.cur >= info.total) { sel.page = info ? info.cur : sel.page; break; }
          const before = info.cur;
          const nextBtn = findPagerNext(info.el);
          if (!nextBtn) { selLog(log, "⚠️ 沒找到下一頁按鈕，改用網址翻頁"); break; }
          nextBtn.click();
          await humanSleep(2600);
          const after = findPagerInfo();
          if (after && after.cur === before) {
            stuck += 1;
            selLog(log, `⚠️ 第 ${before} 頁點擊無效（第 ${stuck} 次），改用網址翻頁`);
            if (stuck >= 2) break;
          }
          sel.page = after ? after.cur : before + 1;
          if (sel.page % 3 === 0) selLog(log, `   已翻到第 ${sel.page}/${info.total} 頁`);
        }
        saveSelectState(sel);
        if (stuck >= 2) {
          selLog(log, "↪️ 改用網址翻到最後一頁");
          const pg2 = findPagerInfo();
          const target = pg2 ? pg2.total : 50;
          sel.page = Math.min(target, 100);
          saveSelectState(sel);
          await humanSleep(2500);
          location.href = withPage(sel.searchUrl || `https://shopee.tw/search?keyword=${encodeURIComponent(sel.kw)}`, sel.page);
          return;
        }
        selLog(log, `✅ 已到第 ${sel.page} 頁（最後一頁），開始篩選本頁商品`);
        await humanSleep(2000);
      } else if (pg && pg.total <= sel.minPage) {
        sel.jumped = true;
        selLog(log, `ℹ️ 篩選後僅 ${pg.total} 頁，未達頁碼下限 ${sel.minPage}，無深度頁可篩，結束`);
        selectModeFinish(log);
        return;
      } else {
        sel.jumped = true;
        selLog(log, "ℹ️ 分頁資訊不足（單頁或解析失敗），從當前頁開始篩選");
      }
    }
    selLog(log, `   慢速滾動載入卡片（仿人工）…`);
    for (let i = 0; i < 4 && state.running; i += 1) {
      window.scrollTo(0, document.body.scrollHeight);
      await humanSleep(1400);
      scrapeDomInto(new Map());
      mergeApiItems(new Map());
    }
    if (state.running === false) { selLog(log, "⏸ 已暫停，本頁進度保留"); return; }
    const apiMap = buildApiItemMap();
    if (!sel.apiKeysLogged) {
      sel.apiKeysLogged = true;
      saveSelectState(sel);
      const firstBody = captured.items.length ? captured.items[0] : null;
      selLog(log, "🔍 API回應欄位：" + (firstBody ? Object.keys(firstBody).join(",") : "無捕獲") + (firstBody ? " | total_count=" + (firstBody.total_count ?? firstBody.nominal_total_count ?? "無") : ""));
    }
    const cards = document.querySelectorAll('a[href*="-i."]');
    const seenCard = new Set();
    const pending = [];
    for (const a of cards) {
      try {
        const parsed = parseCard(a);
        if (!parsed || seenCard.has(parsed.itemid)) continue;
        seenCard.add(parsed.itemid);
        const container = a.closest("li") || a.closest('[data-sqe="link"]') || a.parentElement;
        if (/代購|代购/.test(parsed.name || "")) { selLog(log, `   跳過「${(parsed.name || "").slice(0, 14)}…」：代購商品`); continue; }
        const bannedHit = bannedKeywordHit(parsed.name);
        if (bannedHit) { selLog(log, `   跳過「${(parsed.name || "").slice(0, 14)}…」：違規類目「${bannedHit}」`); continue; }
        if (isKnownBrandItem(parsed.itemid) || isKnownBrandName(parsed.name)) { selLog(log, `   跳過「${(parsed.name || "").slice(0, 14)}…」：品牌商品（記憶命中）`); continue; }
        if ((sel.visitedShopIds || []).includes(Number(parsed.shopid))) { selLog(log, `   跳過「${(parsed.name || "").slice(0, 14)}…」：該賣場已採集`); continue; }
        const collector = recentShopCollector(parsed.shopid);
        if (collector) { selLog(log, `   跳過「${(parsed.name || "").slice(0, 14)}…」：該賣場近 30 天已由「${collector}」採集`); continue; }
        const apiItem = apiMap.get(parsed.itemid);
        if (apiItem && apiItem.brand && apiItem.brand.name) rememberBrandItem(parsed.itemid, parsed.shopid, apiItem.brand.name);
        const sheetBrand = brandSheetHit(parsed.name) || brandSheetHit(apiItem && apiItem.name);
        if (sheetBrand) { selLog(log, `   跳過「${(parsed.name || "").slice(0, 14)}…」：品牌詞庫「${sheetBrand}」`); continue; }
        const reason = cardQualifiesSelect(container, apiItem, sel.minSold || 0, sel.maxSold || 0, sel.mode);
        if (reason) { selLog(log, `   跳過「${(parsed.name || "").slice(0, 14)}…」：${reason}`); continue; }
        pending.push(parsed.url);
        if (pending.length >= 40) break;
      } catch (_) {}
    }
    selLog(log, `   本頁符合條件商品：${pending.length} 個`);
    if (!pending.length) { sel.refilteredCurrent = true; await selectModeNextPage(sel, log); return; }
    sel.pendingCards = pending;
    sel.phase = "product";
    saveSelectState(sel);
    if (state.running === false) { selLog(log, "⏸ 已暫停，本頁進度保留"); return; }
    await humanSleep(3200);
    location.href = pending[0];
  }
  async function selectModeNextPage(sel, log) {
    if (!state.running) { selLog(log, sel.paused ? "⏸ 已暫停，任務保留" : "⏹ 已停止"); return; }
    if (sel.storesDone >= sel.maxStores) { selectModeFinish(log); return; }
    if (sel.mode === "tw") {
      // 台灣：第一輪篩完 → 刷新本頁再篩一次；第二輪沒新的 → 前一頁；到頁碼下限為止
      if (!sel.refilteredCurrent) {
        sel.refilteredCurrent = true;
        saveSelectState(sel);
        selLog(log, `🔄 第 ${sel.page} 頁第一輪完成，刷新本頁再篩一次（抓新出現的賣場）`);
        await humanSleep(3200);
        location.href = withPage(sel.searchUrl || `https://shopee.tw/search?keyword=${encodeURIComponent(sel.kw)}`, sel.page);
        return;
      }
      if (sel.page - 1 < sel.minPage) {
        selLog(log, `⏭ 已到頁碼下限（第 ${sel.minPage} 頁），1~${sel.minPage} 頁跳過，選品結束`);
        selectModeFinish(log);
        return;
      }
      sel.page -= 1;
      sel.refilteredCurrent = false;
      sel.phase = "search";
      saveSelectState(sel);
      selLog(log, `⬅️ 前進到第 ${sel.page} 頁，開始篩選賣場`);
      await humanSleep(3500);
      location.href = withPage(sel.searchUrl || `https://shopee.tw/search?keyword=${encodeURIComponent(sel.kw)}`, sel.page);
      return;
    }
    // 海外：從當前頁正向翻頁，頁數達上限或翻完所有頁即結束
    const pg = findPagerInfo();
    if (pg && pg.cur >= pg.total) { selLog(log, "✅ 已翻完所有頁面，海外選品結束"); selectModeFinish(log); return; }
    if (sel.pagesUsed >= sel.maxPages) { selLog(log, `✅ 已採集 ${sel.maxPages} 頁（頁數上限），海外選品結束`); selectModeFinish(log); return; }
    sel.page += 1;
    sel.pagesUsed += 1;
    sel.phase = "search";
    saveSelectState(sel);
    selLog(log, `⬅️ 海外選品前進到第 ${sel.page} 頁`);
    await humanSleep(3500);
    location.href = withPage(sel.searchUrl || `https://shopee.tw/search?keyword=${encodeURIComponent(sel.kw)}`, sel.page);
  }

  function selectModeFinish(log) {
    const sel = loadSelectState();
    const kwList = (sel && sel.kwList) || [sel ? sel.kw : ""];
    const kwIndex = (sel && sel.kwIndex) || 0;
    if (kwIndex + 1 < kwList.length) {
      // 還有下一個關鍵詞，自動切換
      const nextKw = kwList[kwIndex + 1];
      selLog(log, `\n🎯 關鍵詞「${sel.kw}」採集完畢，自動切換下一個：「${nextKw}」`);
      sel.kwIndex = kwIndex + 1;
      sel.kw = nextKw;
      sel.page = 1;
      sel.pagesUsed = 0;
      sel.storesDone = 0;
      sel.pendingCards = [];
      sel.visitedShops = [];
      sel.visitedShopIds = [];
      sel.phase = "search";
      sel.jumped = false;
      sel.refilteredCurrent = false;
      sel.filtersApplied = false;
      sel.restartCount = 0;
      sel.emptyStep = 0;
      saveSelectState(sel);
      sendNotify("✅ 完成一個關鍵詞", `「${sel.kw}」採集完畢，自動開始下一個：「${nextKw}」\n時間: ` + new Date().toLocaleString());
      setTimeout(() => { location.href = `https://shopee.tw/search?keyword=${encodeURIComponent(nextKw)}`; }, 3000);
      return;
    }
    // 所有關鍵詞都跑完了 → 從服務器拉最新Top20爆款，重新開始輪詢
    selLog(log, `🔄 全部跑完，正在從服務器拉最新Top20爆款…`);
    sendNotify("🔄 本輪完成，拉取最新爆款", `即將自動開始新一輪爆款採集。\n時間: ` + new Date().toLocaleString());
    if (sel) {
      const settings0 = loadSettings();
      const server0 = (settings0.server || "").replace(/\/+$/, "");
      GM_xmlhttpRequest({
        method: "GET", url: server0 + "/api/hot-products",
        headers: { "X-Crawler-Token": settings0.token || "" }, timeout: 10000,
        onload: (r) => {
          try {
            const resp = JSON.parse(r.responseText);
            if (resp.ok && resp.products && resp.products.length) {
              const newKw = resp.products.slice(0, 20);
              selLog(log, `🔥 拉到 ${newKw.length} 個最新爆款：${newKw.slice(0,3).join("、")}...`);
              sel.kwList = newKw;
              sel.kwIndex = 0;
              sel.kw = newKw[0];
            } else {
              selLog(log, "⚠️ 拉取爆款失敗，用原列表循環");
              sel.kwIndex = 0;
              sel.kw = kwList[0];
            }
          } catch(e) {
            selLog(log, "⚠️ 拉取出錯，用原列表循環");
            sel.kwIndex = 0;
            sel.kw = kwList[0];
          }
          sel.page = 1; sel.pagesUsed = 0; sel.storesDone = 0;
          sel.pendingCards = []; sel.visitedShops = []; sel.visitedShopIds = [];
          sel.phase = "search"; sel.jumped = false; sel.refilteredCurrent = false;
          sel.filtersApplied = false; sel.restartCount = 0; sel.emptyStep = 0;
          saveSelectState(sel);
          setTimeout(() => { location.href = `https://shopee.tw/search?keyword=${encodeURIComponent(sel.kw)}`; }, 8000);
        },
        onerror: () => {
          sel.kwIndex = 0; sel.kw = kwList[0];
          sel.page = 1; sel.pagesUsed = 0; sel.storesDone = 0;
          sel.phase = "search"; saveSelectState(sel);
          setTimeout(() => { location.href = `https://shopee.tw/search?keyword=${encodeURIComponent(sel.kw)}`; }, 8000);
        }
      });
    }
  }

  async function selectModeProductPhase(sel, log) {
    if (state.running === false) { selLog(log, "⏹ 已停止"); return; }
    await waitForCards(1, 15000);
    await humanSleep(2600);
    if (!state.running) return;
    // 品牌記憶：確認過的品牌商品，連商品頁都不用看直接換下一個
    const urlItemMatch = location.pathname.match(/-i\.(\d+)\.(\d+)/);
    if (urlItemMatch && isKnownBrandItem(urlItemMatch[2])) {
      selLog(log, "⏭ 跳過品牌商品（記憶命中）");
      await selectModeNextCard(sel, log);
      return;
    }
    // 標題區徽標檢測：優選/商城徽標就標在商品標題旁（用戶規則：有徽標直接跳過）
    const h1 = document.querySelector("h1");
    if (h1) {
      let titleBox = h1.parentElement;
      let badgeHit = "";
      for (let i = 0; i < 3 && titleBox; i += 1) {
        const m = (titleBox.innerText || "").match(/蝦皮優選|蝦皮商城/);
        if (m) { badgeHit = m[0]; break; }
        titleBox = titleBox.parentElement;
      }
      if (badgeHit) {
        selLog(log, `⏭ 跳過${badgeHit}店商品（標題區徽標）`);
        await selectModeNextCard(sel, log);
        return;
      }
      const sheetHit = brandSheetHit(h1.innerText || "");
      if (sheetHit) {
        selLog(log, `⏭ 跳過品牌店商品（標題含「${sheetHit}」）`);
        await selectModeNextCard(sel, log);
        return;
      }
    }
    // 商品頁滾一輪觸發 API 抓取
    window.scrollTo(0, 400);
    await humanSleep(1600);
    // 進店前品牌確認：詳情 API 拿品牌信息，命中就登記記憶並跳過（不進店浪費時間）
    const brandHit = currentProductBrand();
    if (brandHit) {
      rememberBrandItem(brandHit.itemid, brandHit.shopid, brandHit.name);
      selLog(log, `⏭ 跳過品牌商品「${brandHit.name.slice(0, 20)}」，已記入品牌記憶`);
      await selectModeNextCard(sel, log);
      return;
    }
    // 找「查看賣場」
    let shopAnchor = null;
    for (const a of document.querySelectorAll("a")) {
      const t = (a.textContent || "").trim();
      if ((t === "查看賣場" || t === "造訪賣場" || t.includes("查看賣場")) && a.getAttribute("href")) {
        shopAnchor = a;
        break;
      }
    }
    if (!shopAnchor) {
      selLog(log, "⚠️ 沒找到「查看賣場」，跳下一個商品");
      await selectModeNextCard(sel, log);
      return;
    }
    // 商城店檢測：查看賣場所在賣場卡片向上 5 層 + 頁面標題（用戶規則：商城/優選不可選）
    let cardBox = shopAnchor.parentElement;
    let mallHit = false;
    for (let i = 0; i < 5 && cardBox; i += 1) {
      if (/蝦皮商城|官方旗艦/.test(cardBox.innerText || "")) { mallHit = true; break; }
      cardBox = cardBox.parentElement;
    }
    if (!mallHit && document.title.includes("蝦皮商城")) mallHit = true;
    if (mallHit) {
      selLog(log, "⏭ 跳過商城店商品");
      await selectModeNextCard(sel, log);
      return;
    }
    const shopHref = shopAnchor.getAttribute("href");
    const abs = shopHref.startsWith("http") ? shopHref : `https://shopee.tw${shopHref}`;
    const shopUrl = abs.split("?")[0];
    sel.phase = "shop";
    sel.shopTry = shopUrl;
    saveSelectState(sel);
    if (state.running === false) { selLog(log, "⏸ 已暫停，本店進度保留"); return; }
    selLog(log, `🏬 進入賣場：${shopUrl.slice(24)}`);
    await humanSleep(3000);
    location.href = shopUrl;
  }

  async function selectModeShopPhase(sel, log) {
    if (state.running === false) { selLog(log, "⏹ 已停止"); return; }
    await waitForCards(5, 20000);
    await humanSleep(2800);
    if (shopHeaderMallHit()) {
      selLog(log, "⏭ 商城/優選店，跳過該賣場（頁頭徽標檢測）");
      await selectModeNextCard(sel, log);
      return;
    }
    // 記憶檢查：這家店 30 天內採集過 → 直接返回換下一個商品
    const shopIdHere = Number((location.pathname.match(/\/shop\/(\d+)/) || [])[1] || (pickShopInfo() && pickShopInfo().shopid) || 0);
    const collectorHere = shopIdHere ? recentShopCollector(shopIdHere) : "";
    if (collectorHere) {
      selLog(log, `⏭ 該賣場近 30 天已由「${collectorHere}」採集，返回換下一個商品`);
      await selectModeNextCard(sel, log);
      return;
    }
    // 店內流程：先點「所有商品」分頁，再切「月銷熱賣」排序（和人工操作一致）
    let allTab = null;
    for (const el of document.querySelectorAll("a, div, button, span")) {
      if ((el.textContent || "").trim() === "所有商品") { allTab = el; break; }
    }
    if (allTab) {
      allTab.click();
      selLog(log, "✅ 已點「所有商品」分頁");
      await humanSleep(2600);
      await waitForCards(5, 15000);
    } else {
      selLog(log, "⚠️ 沒找到「所有商品」分頁，直接嘗試排序");
    }
    const shopSortTab = findSortTab("月銷熱賣");
    if (shopSortTab) {
      shopSortTab.click();
      selLog(log, "✅ 店內已切「月銷熱賣」");
      await humanSleep(2600);
      await waitForCards(5, 15000);
    }
    const info = pickShopInfo();
    const username = info && info.account && info.account.username ? info.account.username : "";
    if (info && info.name && /代購|代购/.test(info.name)) {
      selLog(log, `⏭ 跳過代購店「${info.name}」（基本是品牌無法跟賣）`);
      await selectModeNextCard(sel, log);
      return;
    }
    if (!username) {
      selLog(log, "⚠️ 沒拿到賣場名稱，跳下一個商品");
      await selectModeNextCard(sel, log);
      return;
    }
    selLog(log, `📥 採集賣場「${username}」月銷熱賣商品…`);
    const seen = new Map();
    await scrollCollect(seen, log);
    // 店內卡片到貨標識
    const deliveryOk = new Map();
    document.querySelectorAll('a[href*="-i."]').forEach((a) => {
      try {
        const parsed = parseCard(a);
        if (!parsed) return;
        const container = a.closest("li") || a.closest('[data-sqe="link"]') || a.parentElement;
        const text = (container.innerText || "");
        // 店內規則（用戶定義）：默認全部符合，僅隔日到貨/隔天到等快速到貨徽標 → 拒
        deliveryOk.set(Number(parsed.itemid), !/隔日到貨|隔天到|後天到|明天到|次日到|當天到|快速到貨/.test(text));
      } catch (_) {}
    });
    const apiMap = buildApiItemMap();
    const items = [...seen.values()].filter((item) => {
      if (/代購|代购/.test(item.name || "")) return false;
      if (brandSheetHit(item.name)) return false;
      if (bannedKeywordHit(item.name)) return false;
      if (sel.mode === "tw" && deliveryOk.size && deliveryOk.get(Number(item.itemid)) !== true) return false;
      const basic = apiMap.get(Number(item.itemid));
      if (sel.min > 0 || sel.maxPrice > 0) {
        const priceNt = item.price !== undefined && item.price !== null ? Number(item.price) / 100000 : null;
        if (priceNt !== null) {
          if (sel.min > 0 && priceNt < sel.min) return false;
          if (sel.maxPrice > 0 && priceNt > sel.maxPrice) return false;
        }
      }
      if (sel.minSold > 0 || sel.maxSold > 0) {
        const soldN = item.sold !== undefined && item.sold !== null ? Number(item.sold) : null;
        if (soldN === null) return false;
        if (sel.minSold > 0 && soldN < sel.minSold) return false;
        if (sel.maxSold > 0 && soldN > sel.maxSold) return false;
      }
      if (basic) {
        if (basic.is_official_shop) return false;
        if (basic.brand && basic.brand.name) {
          rememberBrandItem(basic.itemid, basic.shopid, basic.brand.name);
          return false;
        }
        for (const key of Object.keys(basic)) {
          if (/preferred/i.test(key) && basic[key]) return false;
        }
      }
      return true;
    });
    if (!items.length) {
      selLog(log, "⚠️ 該賣場沒有符合選品條件的商品");
      await selectModeNextCard(sel, log);
      return;
    }
    if (state.running === false) { selLog(log, "⏸ 已暫停——本次未入庫，繼續後將重新採集本店"); return; }
    selLog(log, `   條件過濾後剩 ${items.length} 個商品，推送入庫…`);
    const ok = await pushShops([{ username, shop_info: info || { username }, items }], log, sel.loc === "overseas" ? "海外" : "台灣");
    if (ok) {
      sel.storesDone += 1;
      sel.visitedShops.push(username);
      const firstShopId = items.length && items[0].shopid ? Number(items[0].shopid) : null;
      if (firstShopId) {
        sel.visitedShopIds = sel.visitedShopIds || [];
        sel.visitedShopIds.push(firstShopId);
      }
      rememberShopCollected(firstShopId, username);
      if (window.__spCollectedShops) window.__spCollectedShops.push(firstShopId);
      saveSelectState(sel);
      setStatus(`選品：已完成 ${sel.storesDone}/${sel.maxStores} 家店`);
    }
    await selectModeNextCard(sel, log);
  }


  async function selectModeNextCard(sel, log) {
    if (!state.running) { selLog(log, sel.paused ? "⏸ 已暫停，任務保留" : "⏹ 已停止"); return; }
    if (sel.storesDone >= sel.maxStores) { selectModeFinish(log); return; }
    if (sel.pendingCards && sel.pendingCards.length) {
      sel.pendingCards.shift();
      saveSelectState(sel);
      if (sel.pendingCards.length) {
        sel.phase = "product";
        saveSelectState(sel);
        await humanSleep(3200);
        location.href = sel.pendingCards[0];
        return;
      }
    }
    await selectModeNextPage(sel, log);
  }

  async function startSelectMode(log, mode) {
    if (!window.__spDbgLoop) { window.__spDbgLoop = true; dbgCommandLoop(); }
    const selGet = (key, fallback) => {
      const v = tabStore.getItem("sp_sel_" + key);
      return v === null || v === "" ? fallback : v;
    };
    let kwRaw = ((document.querySelector(".sp-sel-kw") || {}).value || selGet("kw", ""));
    if (/^https?:\/\//.test(kwRaw.trim())) kwRaw = "";
    // 解析多關鍵詞：支援逗號/頓號分隔
    const kwList = kwRaw.split(/[,，、\n]/).map(s => s.trim()).filter(Boolean);
    if (!kwList.length) { selLog(log, "❌ 請填寫搜索關鍵詞"); return; }
    const kw = kwList[0];
    selLog(log, `📋 共 ${kwList.length} 個關鍵詞：${kwList.join("、")}`);
    const min = Math.max(0, Number(((document.querySelector(".sp-sel-min") || {}).value) || selGet("min", 200)));
    const maxStores = Math.max(1, Math.min(50, Number(((document.querySelector(".sp-sel-stores") || {}).value) || selGet("stores", 20))));
    const minPage = Math.max(1, Math.min(200, Number(((document.querySelector(".sp-sel-minpage") || {}).value) || selGet("minPage", 5))));
    const maxPages = Math.max(1, Math.min(200, Number(((document.querySelector(".sp-sel-pages") || {}).value) || selGet("maxPages", 30))));
    const minSold = Math.max(0, Number(((document.querySelector(".sp-sel-sold") || {}).value) || selGet("minSold", 0)));
    const maxPrice = Math.max(0, Number(((document.querySelector(".sp-sel-maxp") || {}).value) || selGet("maxPrice", 500)));
    const maxSold = Math.max(0, Number(((document.querySelector(".sp-sel-maxsold") || {}).value) || selGet("maxSold", 0)));
    const loc = mode === "os" ? "overseas" : "tw";
    if (!kw.trim()) { selLog(log, "❌ 請填寫搜索關鍵詞"); return; }
    tabStore.setItem("sp_sel_kw", kw.trim());
    tabStore.setItem("sp_sel_min", String(min));
    tabStore.setItem("sp_sel_maxPrice", String(maxPrice));
    tabStore.setItem("sp_sel_minSold", String(minSold));
    tabStore.setItem("sp_sel_maxSold", String(maxSold));
    tabStore.setItem("sp_sel_stores", String(maxStores));
    tabStore.setItem("sp_sel_minPage", String(minPage));
    tabStore.setItem("sp_sel_maxPages", String(maxPages));
    tabStore.setItem("sp_sel_loc", loc);
    // 從工作台拉取近 30 天採集過的店鋪（記憶以工作台數據為準，跨設備有效）
    const settings0 = loadSettings();
    const server0 = (settings0.server || "").replace(/\/+$/, "");
    let recentMeta = null;
    const recent = await new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: `${server0}/api/profit/select-collected-shops`,
        headers: { "X-Crawler-Token": settings0.token || "" },
        timeout: 15000,
        onload: (r) => { try { const d = JSON.parse(r.responseText); recentMeta = d; resolve(d.shops || []); } catch (_) { resolve([]); } },
        onerror: () => resolve([]),
        ontimeout: () => resolve([]),
      });
    });
    window.__spCollectedShops = recent.map((s) => Number(s.id)).filter(Number.isFinite);
    window.__spBannedKeywords = (recentMeta && recentMeta.bannedKeywords) || [];
    window.__spSheetBrands = (recentMeta && recentMeta.brandNames) || [];
    selLog(log, `🧠 記憶加載：近 30 天已採集 ${window.__spCollectedShops.length} 家店鋪｜違規類目 ${window.__spBannedKeywords.length} 個｜品牌詞庫 ${window.__spSheetBrands.length} 個`);
    // 品牌記憶：從服務器合併（含其他設備登記的），搜索頁直接跳過已知品牌商品
    const brandRemote = await new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: `${server0}/api/profit/select-brand-memory`,
        headers: { "X-Crawler-Token": settings0.token || "" },
        timeout: 15000,
        onload: (r) => { try { resolve(JSON.parse(r.responseText).items || []); } catch (_) { resolve([]); } },
        onerror: () => resolve([]),
        ontimeout: () => resolve([]),
      });
    });
    const brandNew = applyServerBrandMemory(brandRemote);
    ensureBrandMemoryLoaded();
    selLog(log, `🏷️ 品牌記憶：共 ${brandMemoryIds.size} 個品牌商品，本次合併新增 ${brandNew} 個`);
    try {
      const state = { kw: kw, kwList: kwList, kwIndex: 0, min, maxPrice, minSold, maxSold, maxStores, minPage, maxPages, loc, mode, page: 1, pagesUsed: 0, pendingCards: [], visitedShops: [], visitedShopIds: [], storesDone: 0, phase: "search", refilteredCurrent: false };
      saveSelectState(state);
      tabStore.setItem(SELECT_FLAG, "1");
      state.running = true;
      setStatus("選品模式：啟動");
      selLog(log, `🚀 ${loc === "overseas" ? "海外" : "台灣"}選品啟動：「${kw.trim()}」價格 ${min}${maxPrice ? "~" + maxPrice : "~∞"}｜月銷 ${minSold || 0}${maxSold ? "~" + maxSold : "~∞"}｜店鋪≤${maxStores}${loc === "tw" ? "｜篩到第 " + minPage + " 頁" : "｜從第 1 頁向後採 " + maxPages + " 頁"}`);
      location.href = `https://shopee.tw/search?keyword=${encodeURIComponent(kw.trim())}`;
    } catch (error) {
      selLog(log, `💥 啟動失敗: ${error && error.message ? error.message : String(error)}`);
    }
  }

  async function continueSelectMode(log) {
    try {
      const sel = loadSelectState();
      if (!sel || !sel.phase || !sel.kw || sel.min === undefined || sel.maxPrice === undefined || sel.minSold === undefined || sel.maxSold === undefined || sel.maxStores === undefined || sel.minPage === undefined || sel.maxPages === undefined) {
        // 舊版/殘缺狀態（篩選參數不全）：清掉讓用戶重新啟動，避免用錯誤參數採集
        tabStore.removeItem(SELECT_FLAG);
        saveSelectState(null);
        setStatus("選品狀態無效，請重新點開始選品");
        selLog(log, "❌ 選品狀態無效或參數不全，已清除——請確認面板參數後重新點「開始選品」啟動");
        return;
      }
      sel.minPage = sel.minPage || 5;
      sel.maxPages = sel.maxPages || 30;
      sel.pagesUsed = sel.pagesUsed || 0;
      sel.page = sel.page || 1;
      sel.storesDone = sel.storesDone || 0;
      sel.pendingCards = sel.pendingCards || [];
      if (sel.paused) {
        setStatus("選品模式：已暫停");
        selLog(log, "⏸ 選品已暫停，點面板「繼續」恢復");
        return;
      }
      state.running = true;
      setStatus(`選品模式：${sel.phase === "search" ? "搜索篩選" : sel.phase === "product" ? "查看商品" : "採集店鋪"}（完成 ${sel.storesDone || 0}/${sel.maxStores}）`);
      selLog(log, `🔁 選品續跑：階段=${sel.phase} 頁=${sel.page} 已完成店鋪=${sel.storesDone || 0}`);
      if (location.pathname.includes("/verify/")) {
        setStatus("等待手動過驗證…");
        selLog(log, "⚠️ 蝦皮風控攔截！請在手動完成驗證（滑塊/短信），完成後腳本會自動繼續。");
        sendNotify("⚠️ 被蝦皮風控攔截", "請手動完成驗證，完成後腳本會自動繼續。\n時間: " + new Date().toLocaleString());
        // 輪詢等待人工過驗證
        state.running = false;
        const waitForVerify = setInterval(() => {
          if (!tabStore.getItem(SELECT_FLAG)) { clearInterval(waitForVerify); return; }
          if (!location.pathname.includes("/verify/")) {
            clearInterval(waitForVerify);
            selLog(log, "✅ 驗證已通過，自動繼續選品…");
            setStatus("選品模式：繼續");
            state.running = true;
            continueSelectMode(log).catch((e) => selLog(log, `💥 恢復後異常: ${e && e.message ? e.message : e}`));
          }
        }, 5000);
        return;
      }
      if (sel.storesDone >= sel.maxStores) { selectModeFinish(log); return; }
      // 頁面類型判定：shop 階段且頁面是賣場（有「所有商品」導航、沒有「查看賣場」）→ 永不再找查看賣場
      const bodyText = document.body ? document.body.innerText : "";
      const looksLikeShop = bodyText.includes("所有商品") && !bodyText.includes("查看賣場") && bodyText.includes("粉絲");
      const isShopUrl = sel.shopTry && location.href.split("?")[0] === sel.shopTry.split("?")[0];
      if (sel.emptyStep === 2 && (location.pathname === "/" || location.pathname === "")) {
        // Logo 重置後回到首頁：重置進度，從搜索詞重新開始
        sel.emptyStep = 0;
        sel.restartCount = (sel.restartCount || 0) + 1;
        sel.page = 1;
        sel.jumped = false;
        sel.refilteredCurrent = false;
        sel.pendingCards = [];
        sel.phase = "search";
        saveSelectState(sel);
        if (sel.restartCount > 2) {
          selLog(log, "❌ 重啟後仍找不到商品，選品結束（可放寬條件後重試）");
          selectModeFinish(log);
          return;
        }
        selLog(log, `🔄 第 ${sel.restartCount} 次從搜索詞重新開始…`);
        await humanSleep(2000);
        location.href = `https://shopee.tw/search?keyword=${encodeURIComponent(sel.kw)}`;
        return;
      }
      if (location.pathname.startsWith("/search")) await selectModeSearchPhase(sel, log);
      else if (sel.phase === "shop" && (isShopUrl || looksLikeShop || location.pathname.startsWith("/shop/"))) await selectModeShopPhase(sel, log);
      else if (sel.phase === "product" && isShopUrl) {
        // 進店後 URL 保存正確但階段標記丟失的情況：直接走店內流程
        sel.phase = "shop";
        saveSelectState(sel);
        await selectModeShopPhase(sel, log);
      }
      else await selectModeProductPhase(sel, log);
    } catch (error) {
      dbgLog("💥 選品崩潰：" + (error && error.message) + " @ " + location.pathname);
      dbgFlush();
      setStatus("選品出錯，即將自動刷新恢復…");
      // 不清SELECT_FLAG，讓看門狗自動刷新恢復
      sendNotify("💥 選品腳本崩潰", "錯誤: " + (error && error.message ? error.message : error) + "\n頁面: " + location.pathname + "\n時間: " + new Date().toLocaleString());
      // 30秒後自動刷新
      setTimeout(() => location.reload(), 30000);
    }
  }

  installHooks();
  if (document.body) buildPanel();
  else window.addEventListener("DOMContentLoaded", buildPanel);
})();











