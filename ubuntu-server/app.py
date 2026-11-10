#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
蝦皮選品器 後台服務端（Ubuntu 版）
端口: 4180
功能: 接收油猴腳本採集數據、下發監控名單與抓取條件、提供爆品/品牌記憶/已採店鋪記憶、
      接收遠程調試日誌與通知，並附帶一個可視化看板。

與 shopee-selector.user.js v4.2.19 的接口對齊要點：
  - 鑑權: 請求頭 X-Crawler-Token / ?token= / JSON body 裡的 token
  - 所有經 serverCall 調用的接口，響應體必須帶 "ok": true，否則腳本會拋「服務器返回錯誤」
  - 腳本送出的 price 是蝦皮原始值（NT$ × 100000），入庫前換算成 TWD
  - /api/hot-products 返回 {"ok":true,"products":[...]}，products 是關鍵詞字符串陣列
  - /api/profit/select-collected-shops 必須返回 shops[].id（腳本用 Number(s.id) 與店鋪 shopid 比對）
"""
import os
import json
import time
import hashlib
import sqlite3
import logging
from contextlib import closing

from flask import Flask, request, jsonify, g, Response

# ============================== 基礎配置 ==============================
VERSION = "1.0.0"
AUTH_TOKEN = os.environ.get("XUANPIN_TOKEN", "xk_3f824111e24061a698569f26ac0f85c9")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("XUANPIN_DB", os.path.join(BASE_DIR, "xuanpin.db"))
PRICE_SCALE = 100000  # 腳本 price = TWD × 100000

DEFAULT_FILTERS = {
    "minPrice": 200,
    "maxPrice": 500,
    "minSales": 3,
    "maxSales": 60,
    "blockedBrands": [],
    "sourceTag": "tw",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("xuanpin")

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False


# ============================== 數據庫 ==============================
SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemid TEXT UNIQUE NOT NULL,
    shopid INTEGER,
    shop_username TEXT,
    shop_name TEXT,
    name TEXT,
    price REAL,              -- 新台幣，已從腳本原始值換算
    price_raw REAL,          -- 腳本原樣送來的 price
    price_before_discount REAL,
    sold INTEGER,            -- 月銷
    historical_sold INTEGER, -- 已售出
    rating REAL,
    liked_count INTEGER,
    stock INTEGER,
    url TEXT,
    image TEXT,
    listed_on TEXT,
    is_official_shop INTEGER,
    source_tag TEXT,
    first_seen TEXT,
    crawled_at TEXT
);

CREATE TABLE IF NOT EXISTS shops (
    username TEXT PRIMARY KEY,
    shopid INTEGER,
    shop_name TEXT,
    follower_count INTEGER,
    item_count INTEGER,
    rating_star REAL,
    location TEXT,
    interval_days INTEGER DEFAULT 7,
    filters TEXT,
    last_crawled_at TEXT,
    first_crawled_at TEXT,
    product_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crawled_at TEXT,
    shop_count INTEGER,
    product_count INTEGER,
    duplicate_count INTEGER,
    source_tag TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS brand_memory (
    itemid TEXT PRIMARY KEY,
    shopid INTEGER,
    brand TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    content TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS debug_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS debug_cmds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT,
    status TEXT DEFAULT 'pending',   -- pending / sent
    result TEXT,
    created_at TEXT,
    sent_at TEXT
);

CREATE TABLE IF NOT EXISTS hot_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT UNIQUE,
    created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_sold ON products(sold);
CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_username);
CREATE INDEX IF NOT EXISTS idx_products_crawled ON products(crawled_at);
"""


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with closing(connect()) as conn:
        conn.executescript(SCHEMA)
        conn.commit()


# ============================== 工具 ==============================
def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def to_int(value, default=0):
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def to_float(value, default=None):
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_price(raw):
    """腳本的 price 是 TWD×100000，換算回新台幣。"""
    value = to_float(raw)
    if value is None:
        return None
    if abs(value) >= 10000:          # 300 → 30,000,000
        return round(value / PRICE_SCALE, 2)
    return round(value, 2)


def json_body():
    if request.is_json:
        return request.get_json(silent=True) or {}
    raw = request.get_data(as_text=True) or ""
    if raw.strip().startswith("{"):
        try:
            return json.loads(raw)
        except ValueError:
            return {}
    return {}


def provided_token():
    body = json_body() if request.method in ("POST", "PUT", "PATCH") else {}
    return (
        request.headers.get("X-Crawler-Token", "")
        or request.args.get("token", "")
        or (body.get("token") if isinstance(body, dict) else "")
    )


def authorized():
    return provided_token() == AUTH_TOKEN


def deny():
    return jsonify({"ok": False, "error": "unauthorized"}), 401


@app.after_request
def add_headers(resp):
    # 腳本走 GM_xmlhttpRequest，理論上不需要 CORS；留著方便瀏覽器裡直接調試
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Crawler-Token"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


@app.route("/api/<path:_any>", methods=["OPTIONS"])
def cors_preflight(_any):
    return ("", 204)


# ============================== 採集入庫 ==============================
def upsert_shop(conn, shop, crawled_at, source_tag):
    info = shop.get("shop_info") or {}
    username = (shop.get("username") or info.get("username") or "").strip()
    if not username:
        return None
    shopid = to_int(info.get("shopid") or shop.get("shopid"), None)
    shop_name = info.get("name") or info.get("shop_name") or shop.get("shopName") or ""
    follower = to_int(info.get("follower_count"), None)
    item_count = to_int(info.get("item_count"), None)
    rating = to_float(info.get("rating_star"))
    location = info.get("location") or ""

    row = conn.execute("SELECT * FROM shops WHERE username=?", (username,)).fetchone()
    if row is None:
        conn.execute(
            """INSERT INTO shops (username, shopid, shop_name, follower_count, item_count,
                                  rating_star, location, interval_days, filters, last_crawled_at,
                                  first_crawled_at, product_count)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,0)""",
            (username, shopid, shop_name, follower, item_count, rating, location,
             7, json.dumps(DEFAULT_FILTERS), crawled_at, crawled_at),
        )
    else:
        conn.execute(
            """UPDATE shops SET shopid=COALESCE(?, shopid), shop_name=?, follower_count=?,
                   item_count=?, rating_star=?, location=?, last_crawled_at=?
               WHERE username=?""",
            (shopid, shop_name, follower, item_count, rating, location, crawled_at, username),
        )
    return username


def upsert_item(conn, username, shop_name, item, crawled_at, source_tag):
    itemid = str(item.get("itemid") or "").strip()
    if not itemid:
        return "skip"
    rating = to_float((item.get("item_rating") or {}).get("rating_star"))
    if rating is None:
        rating = to_float(item.get("rating_star"))
    price_raw = to_float(item.get("price"))
    values = (
        itemid,
        to_int(item.get("shopid"), None),
        username,
        shop_name,
        (item.get("name") or "")[:300],
        normalize_price(item.get("price")),
        price_raw,
        normalize_price(item.get("price_before_discount")),
        to_int(item.get("sold"), None),
        to_int(item.get("historical_sold"), None),
        rating,
        to_int(item.get("liked_count"), None),
        to_int(item.get("stock"), None),
        (item.get("url") or "")[:400],
        (item.get("image") or "")[:400],
        item.get("ctime") or item.get("t_ctime") or "",
        1 if item.get("is_official_shop") else 0,
        source_tag,
        crawled_at,
    )
    exists = conn.execute("SELECT id FROM products WHERE itemid=?", (itemid,)).fetchone()
    if exists:
        conn.execute(
            """UPDATE products SET shopid=?, shop_username=?, shop_name=?, name=?, price=?,
                   price_raw=?, price_before_discount=?, sold=?, historical_sold=?, rating=?,
                   liked_count=?, stock=?, url=?, image=?, listed_on=?, is_official_shop=?,
                   source_tag=?, crawled_at=?
               WHERE itemid=?""",
            values[1:] + (itemid,),
        )
        return "duplicate"
    conn.execute(
        """INSERT INTO products (itemid, shopid, shop_username, shop_name, name, price, price_raw,
               price_before_discount, sold, historical_sold, rating, liked_count, stock, url, image,
               listed_on, is_official_shop, source_tag, crawled_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        values,
    )
    return "new"


@app.route("/api/crawler/ingest", methods=["POST"])
def ingest():
    if not authorized():
        return deny()
    data = json_body()
    shops = data.get("shops") or []
    crawled_at = data.get("crawledAt") or now_iso()
    source_tag = data.get("sourceTag") or data.get("source_tag") or ""

    conn = get_db()
    new_products = 0
    duplicates = 0
    touched_shops = []

    for shop in shops:
        if not isinstance(shop, dict):
            continue
        username = upsert_shop(conn, shop, crawled_at, source_tag)
        if not username:
            continue
        if username not in touched_shops:
            touched_shops.append(username)
        shop_name = ((shop.get("shop_info") or {}).get("name") or shop.get("shopName") or "")
        items = shop.get("items") or []
        for item in items:
            if not isinstance(item, dict):
                continue
            state = upsert_item(conn, username, shop_name, item, crawled_at, source_tag)
            if state == "new":
                new_products += 1
            elif state == "duplicate":
                duplicates += 1

    shop_count = len(touched_shops)
    if touched_shops:
        placeholders = ",".join("?" * len(touched_shops))
        conn.execute(
            "UPDATE shops SET product_count=(SELECT COUNT(*) FROM products WHERE products.shop_username=shops.username) "
            "WHERE username IN (%s)" % placeholders,
            touched_shops,
        )

    conn.execute(
        """INSERT INTO batches (crawled_at, shop_count, product_count, duplicate_count, source_tag, created_at)
           VALUES (?,?,?,?,?,?)""",
        (crawled_at, shop_count, new_products, duplicates, source_tag, now_iso()),
    )
    conn.commit()
    run_id = conn.execute("SELECT MAX(id) FROM batches").fetchone()[0]

    log.info("ingest run=%s shops=%s new=%s dup=%s tag=%s",
             run_id, shop_count, new_products, duplicates, source_tag)
    return jsonify({
        "ok": True,
        "runId": run_id,
        "shops": shop_count,
        "products": new_products,
        "duplicates": duplicates,
        "crawledAt": crawled_at,
    })


# ============================== 監控名單 ==============================
@app.route("/api/crawler/monitor-list", methods=["GET"])
def monitor_list():
    if provided_token() and not authorized():
        return deny()
    conn = get_db()
    rows = conn.execute(
        """SELECT username, shopid, shop_name, interval_days, last_crawled_at, filters, product_count
           FROM shops ORDER BY last_crawled_at DESC"""
    ).fetchall()
    shops = []
    for row in rows:
        try:
            filters = json.loads(row["filters"]) if row["filters"] else dict(DEFAULT_FILTERS)
        except ValueError:
            filters = dict(DEFAULT_FILTERS)
        shops.append({
            "username": row["username"],
            "shopid": row["shopid"],
            "shopName": row["shop_name"] or row["username"],
            "intervalDays": row["interval_days"] or 7,
            "lastCrawledAt": row["last_crawled_at"],
            "productCount": row["product_count"] or 0,
            "filters": filters,
        })
    return jsonify({"ok": True, "shops": shops, "filters": DEFAULT_FILTERS})


@app.route("/api/crawler/shops", methods=["POST"])
def save_shops():
    """保存/更新監控名單（interval_days、每店 filters 覆蓋）。"""
    if not authorized():
        return deny()
    data = json_body()
    entries = data.get("shops") or []
    conn = get_db()
    saved = 0
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        username = (entry.get("username") or "").strip()
        if not username:
            continue
        interval = to_int(entry.get("intervalDays"), 7)
        filters = entry.get("filters")
        row = conn.execute("SELECT username FROM shops WHERE username=?", (username,)).fetchone()
        if row:
            conn.execute(
                "UPDATE shops SET interval_days=?, filters=COALESCE(?, filters) WHERE username=?",
                (interval, json.dumps(filters) if filters else None, username),
            )
        else:
            conn.execute(
                """INSERT INTO shops (username, shop_name, interval_days, filters, first_crawled_at)
                   VALUES (?,?,?,?,?)""",
                (username, entry.get("shopName") or username, interval,
                 json.dumps(filters) if filters else json.dumps(DEFAULT_FILTERS), now_iso()),
            )
        saved += 1
    conn.commit()
    return jsonify({"ok": True, "saved": saved})


# ============================== 爆品關鍵詞 ==============================
def derive_keyword(name):
    """從商品標題提煉可用作搜索詞的短語。"""
    text = (name or "").strip()
    for sep in ("｜", "|", "/", "【", "】", "，", ",", "(", "（", "-", "–"):
        if sep in text:
            head = text.split(sep)[0].strip()
            if 2 <= len(head) <= 30:
                return head
    return text[:20]


@app.route("/api/hot-products", methods=["GET", "POST"])
def hot_products():
    if provided_token() and not authorized():
        return deny()
    conn = get_db()
    if request.method == "POST":
        if not authorized():
            return deny()
        data = json_body()
        keywords = data.get("keywords") or data.get("products") or []
        conn.execute("DELETE FROM hot_keywords")
        for kw in keywords:
            kw = str(kw).strip()
            if kw:
                try:
                    conn.execute("INSERT OR IGNORE INTO hot_keywords (keyword, created_at) VALUES (?,?)",
                                 (kw, now_iso()))
                except sqlite3.IntegrityError:
                    pass
        conn.commit()

    seeded = [r["keyword"] for r in conn.execute("SELECT keyword FROM hot_keywords LIMIT 20").fetchall()]
    if seeded:
        return jsonify({"ok": True, "products": seeded, "source": "manual"})

    since = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(time.time() - 48 * 3600))
    rows = conn.execute(
        """SELECT name FROM products
           WHERE crawled_at >= ?
           ORDER BY COALESCE(sold,0) DESC, COALESCE(historical_sold,0) DESC, id DESC
           LIMIT 15""",
        (since,),
    ).fetchall()
    keywords = []
    for row in rows:
        kw = derive_keyword(row["name"])
        if kw and kw not in keywords:
            keywords.append(kw)
    return jsonify({"ok": True, "products": keywords[:15], "source": "auto"})


# ============================== 品牌記憶 ==============================
@app.route("/api/profit/select-brand-memory", methods=["GET", "POST"])
def brand_memory():
    if provided_token() and not authorized():
        return deny()
    conn = get_db()
    if request.method == "POST":
        if not authorized():
            return deny()
        data = json_body()
        items = data.get("items") or []
        saved = 0
        for row in items:
            if not isinstance(row, dict):
                continue
            itemid = str(row.get("itemid") or "").strip()
            if not itemid:
                continue
            conn.execute(
                """INSERT INTO brand_memory (itemid, shopid, brand, updated_at) VALUES (?,?,?,?)
                   ON CONFLICT(itemid) DO UPDATE SET shopid=excluded.shopid, brand=excluded.brand,
                                                     updated_at=excluded.updated_at""",
                (itemid, to_int(row.get("shopid"), None), (row.get("brand") or "")[:80], now_iso()),
            )
            saved += 1
        conn.commit()
        return jsonify({"ok": True, "saved": saved})

    rows = conn.execute(
        "SELECT itemid, shopid, brand FROM brand_memory ORDER BY updated_at DESC LIMIT 2000"
    ).fetchall()
    return jsonify({
        "ok": True,
        "items": [{"itemid": to_int(r["itemid"]), "shopid": r["shopid"], "brand": r["brand"]} for r in rows],
        "count": len(rows),
    })


# ============================== 已採集店鋪（30 天） ==============================
@app.route("/api/profit/select-collected-shops", methods=["GET"])
def collected_shops():
    if provided_token() and not authorized():
        return deny()
    conn = get_db()
    since = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(time.time() - 30 * 86400))
    rows = conn.execute(
        """SELECT shop_username AS username, shopid, shop_name, MAX(crawled_at) AS last_at, COUNT(*) AS items
           FROM products
           WHERE crawled_at >= ?
           GROUP BY shop_username, shopid, shop_name
           ORDER BY last_at DESC""",
        (since,),
    ).fetchall()
    shops = []
    for row in rows:
        if row["shopid"] is None:
            continue   # 腳本用 Number(s.id) 與卡片 shopid 比對，沒有 shopid 的行沒有意義
        shops.append({
            "id": int(row["shopid"]),
            "username": row["username"],
            "shopName": row["shop_name"],
            "lastCrawledAt": row["last_at"],
            "itemCount": row["items"],
        })

    brands = [r["brand"] for r in conn.execute(
        "SELECT DISTINCT brand FROM brand_memory WHERE brand <> '' LIMIT 500").fetchall()]
    return jsonify({
        "ok": True,
        "shops": shops,
        "bannedKeywords": BANNED_KEYWORDS,
        "brandNames": brands,
    })


# 違規類目詞庫（腳本讀走後在本地參與過濾；按需在這裡增刪）
BANNED_KEYWORDS = [
    "代購", "代购", "醫療", "医疗", "藥品", "药品", "保健品", "成人", "情趣",
    "仿品", "高仿", "A貨", "a货", "電子煙", "电子烟", "煙油",
]


# ============================== 遠程調試通道 ==============================
@app.route("/api/profit/select-debug/debug", methods=["POST"])
def debug_push():
    if not authorized():
        return deny()
    payload = request.get_data(as_text=True)
    conn = get_db()
    conn.execute("INSERT INTO debug_logs (payload, created_at) VALUES (?,?)", (payload[:20000], now_iso()))
    total = conn.execute("SELECT COUNT(*) FROM debug_logs").fetchone()[0]
    if total > 3000:   # 只留最近 3000 條
        conn.execute("DELETE FROM debug_logs WHERE id <= ?", (total - 3000,))
    conn.commit()
    return jsonify({"ok": True})


@app.route("/api/profit/select-debug/result", methods=["POST"])
def debug_result():
    if not authorized():
        return deny()
    data = json_body()
    conn = get_db()
    conn.execute(
        "UPDATE debug_cmds SET result=?, status='done' WHERE id=?",
        ((data.get("result") or "")[:7000], to_int(data.get("id"))),
    )
    conn.commit()
    return jsonify({"ok": True})


@app.route("/api/profit/select-debug/cmd", methods=["GET"])
def debug_cmd():
    if provided_token() and not authorized():
        return deny()
    conn = get_db()
    row = conn.execute(
        "SELECT id, code FROM debug_cmds WHERE status='pending' ORDER BY id ASC LIMIT 1"
    ).fetchone()
    if row is None:
        return jsonify({"ok": True})
    conn.execute("UPDATE debug_cmds SET status='sent', sent_at=? WHERE id=?", (now_iso(), row["id"]))
    conn.commit()
    return jsonify({"ok": True, "id": row["id"], "code": row["code"]})


@app.route("/api/profit/select-debug", methods=["GET", "POST"])
@app.route("/api/profit/select-debug/<path:rest>", methods=["GET", "POST"])
def debug_generic(rest=""):
    """兜底：腳本會往 /api/profit/select-debug 及其子路徑投遞日誌。"""
    if provided_token() and not authorized():
        return deny()
    if request.method == "POST" and authorized():
        conn = get_db()
        conn.execute("INSERT INTO debug_logs (payload, created_at) VALUES (?,?)",
                     ((request.get_data(as_text=True) or "")[:20000], now_iso()))
        conn.commit()
    return jsonify({"ok": True, "path": "/" + rest})


# ============================== 通知 ==============================
@app.route("/api/notify", methods=["GET", "POST"])
def notify():
    if request.method == "GET":
        if provided_token() and not authorized():
            return deny()
        rows = get_db().execute(
            "SELECT id, title, content, created_at FROM notifications ORDER BY id DESC LIMIT 50"
        ).fetchall()
        return jsonify({"ok": True, "notifications": [dict(r) for r in rows]})

    if not authorized():
        return deny()
    data = json_body()
    conn = get_db()
    conn.execute("INSERT INTO notifications (title, content, created_at) VALUES (?,?,?)",
                 ((data.get("title") or "")[:200], (data.get("content") or "")[:5000], now_iso()))
    conn.commit()
    log.info("notify: %s", data.get("title"))
    return jsonify({"ok": True})


# ============================== 狀態 / 看板 ==============================
@app.route("/api/crawler/status", methods=["GET"])
def status():
    conn = get_db()
    stats = {
        "products": conn.execute("SELECT COUNT(*) FROM products").fetchone()[0],
        "shops": conn.execute("SELECT COUNT(*) FROM shops").fetchone()[0],
        "brands": conn.execute("SELECT COUNT(*) FROM brand_memory").fetchone()[0],
        "batches": conn.execute("SELECT COUNT(*) FROM batches").fetchone()[0],
    }
    last = conn.execute(
        "SELECT id, crawled_at, shop_count, product_count, duplicate_count, source_tag FROM batches ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return jsonify({
        "ok": True,
        "version": VERSION,
        "stats": stats,
        "lastBatch": dict(last) if last else None,
        "time": now_iso(),
    })


@app.route("/healthz", methods=["GET"])
def healthz():
    return jsonify({"ok": True, "service": "xuanpin", "version": VERSION})


DASHBOARD = """<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>蝦皮選品工作台</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{{font-family:-apple-system,"Noto Sans TC",Segoe UI,sans-serif;margin:0;background:#f6f7f9;color:#1f2328}}
header{{background:#ee4d2d;color:#fff;padding:14px 18px;font-size:18px;font-weight:600}}
.wrap{{padding:16px;max-width:1180px;margin:0 auto}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}}
.card{{background:#fff;border-radius:10px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}}
.card b{{display:block;font-size:26px;color:#ee4d2d;margin-top:4px}}
table{{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;font-size:13px}}
th,td{{padding:8px 10px;border-bottom:1px solid #eee;text-align:left}}
th{{background:#fff7f4;color:#7a2a16;font-weight:600}}
td a{{color:#0b69ff;text-decoration:none}}
.muted{{color:#888;font-size:12px}}
h3{{margin:18px 0 8px}}
</style></head><body>
<header>蝦皮選品工作台 · 後台服務 v{version}</header>
<div class="wrap">
  <div class="cards" id="cards"></div>
  <h3>最近採集</h3><div id="last" class="muted"></div>
  <h3>商品（按月銷）</h3>
  <table><thead><tr><th>商品</th><th>店鋪</th><th>價格 NT$</th><th>月銷</th><th>已售出</th><th>評分</th><th>採集時間</th></tr></thead>
  <tbody id="rows"><tr><td colspan="7" class="muted">載入中…</td></tr></tbody></table>
</div>
<script>
const T={token_json};
async function j(u){{const r=await fetch(u,{{headers:{{'X-Crawler-Token':T}}}});return r.json();}}
(async()=>{{
  const s=await j('/api/crawler/status');
  const st=s.stats||{{}};
  document.getElementById('cards').innerHTML=
    `<div class="card">商品總數<b>${{st.products||0}}</b></div>
     <div class="card">店鋪數<b>${{st.shops||0}}</b></div>
     <div class="card">品牌記憶<b>${{st.brands||0}}</b></div>
     <div class="card">採集批次<b>${{st.batches||0}}</b></div>`;
  const lb=s.lastBatch;
  document.getElementById('last').textContent = lb ? `#${{lb.id}} · ${{lb.crawled_at}} · ${{lb.shop_count}} 店 / ${{lb.product_count}} 新商品 / ${{lb.duplicate_count}} 重複 · ${{lb.source_tag||''}}` : '暫無批次';
  const rows=await j('/api/crawler/products?limit=50');
  const tb=document.getElementById('rows');
  if(!rows.products||!rows.products.length){{tb.innerHTML='<tr><td colspan="7" class="muted">還沒有入庫數據</td></tr>';return;}}
  tb.innerHTML=rows.products.map(p=>`<tr>
    <td><a href="${{p.url}}" target="_blank">${{(p.name||'').slice(0,60)}}</a></td>
    <td>${{p.shop_name||p.shop_username||''}}</td>
    <td>${{p.price==null?'-':p.price}}</td>
    <td>${{p.sold==null?'-':p.sold}}</td>
    <td>${{p.historical_sold==null?'-':p.historical_sold}}</td>
    <td>${{p.rating==null?'-':p.rating}}</td>
    <td class="muted">${{p.crawled_at||''}}</td></tr>`).join('');
}})();
</script></body></html>"""


@app.route("/api/crawler/products", methods=["GET"])
def list_products():
    if provided_token() and not authorized():
        return deny()
    limit = min(max(to_int(request.args.get("limit"), 50), 1), 500)
    rows = get_db().execute(
        """SELECT itemid, name, shop_username, shop_name, price, sold, historical_sold, rating,
                  url, image, crawled_at
           FROM products ORDER BY COALESCE(sold,0) DESC, id DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    return jsonify({"ok": True, "count": len(rows), "products": [dict(r) for r in rows]})


@app.route("/", methods=["GET"])
def index():
    token_js = json.dumps(AUTH_TOKEN)
    return Response(DASHBOARD.format(version=VERSION, token_json=token_js), mimetype="text/html")


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"ok": False, "error": "not found"}), 404


@app.errorhandler(500)
def server_error(e):
    log.exception("server error: %s", e)
    return jsonify({"ok": False, "error": "internal error"}), 500


if __name__ == "__main__":
    init_db()
    log.info("蝦皮選品器後台啟動 http://0.0.0.0:4180  db=%s", DB_PATH)
    app.run(host="0.0.0.0", port=4180, threaded=True, debug=False)
