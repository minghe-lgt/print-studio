# -*- coding: utf-8 -*-
"""
打印小站 —— 3D 打印工作室管理网站（后端服务）
纯 Python 标准库实现：HTTP 服务 + SQLite + JSON API，无任何第三方依赖。

启动:  py app.py            （或 python app.py）
访问:  http://127.0.0.1:8765
数据:  data/studio.db （SQLite 单文件，直接复制即可备份）
"""
import base64
import csv
import gc
import glob
import hashlib
import html as html_lib
import io
import json
import os
import re
import socket
import sqlite3
import sys
import threading
import traceback
import webbrowser
import urllib.request
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urljoin

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "studio.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
DEFAULT_PORT = 8765

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)


# ---------------------------------------------------------------- 基础工具

def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


class ApiError(Exception):
    """业务错误，返回 400 与中文提示"""


def log_op(conn, module, action, detail=""):
    conn.execute(
        "INSERT INTO operation_log(ts, module, action, detail) VALUES (?,?,?,?)",
        (now(), module, action, detail),
    )


def fnum(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def safe_url(u, field="链接"):
    """只接受空串、站内路径或 http(s) 链接，防 javascript: 注入"""
    u = (u or "").strip()
    if not u:
        return ""
    if u.startswith(("http://", "https://", "/uploads/", "/api/", "/static/")):
        return u
    raise ApiError(f"{field}需以 http(s):// 开头，或留空")


# ---------------------------------------------------------------- 建库与种子数据

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS materials(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '其它',
  brand TEXT DEFAULT '', spec TEXT DEFAULT '',
  unit TEXT NOT NULL DEFAULT '个',
  total_g REAL DEFAULT 0,
  unit_price REAL DEFAULT 0,
  min_stock REAL DEFAULT 0,
  note TEXT DEFAULT '',
  archived INTEGER DEFAULT 0,
  created_at TEXT);
CREATE TABLE IF NOT EXISTS stock_movements(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  ts TEXT NOT NULL, qty REAL NOT NULL, unit_cost REAL DEFAULT 0,
  ref_type TEXT DEFAULT 'manual', ref_id INTEGER, note TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_mov_material ON stock_movements(material_id);
CREATE TABLE IF NOT EXISTS purchases(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  supplier TEXT DEFAULT '', total REAL DEFAULT 0,
  status TEXT DEFAULT 'pending', note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS purchase_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL, qty REAL NOT NULL, unit_price REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS printers(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  model TEXT DEFAULT '', power_w REAL DEFAULT 120,
  note TEXT DEFAULT '', created_at TEXT);
CREATE TABLE IF NOT EXISTS print_jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, title TEXT NOT NULL,
  printer_id INTEGER, model_link_id INTEGER,
  planned_qty INTEGER DEFAULT 1, done_qty INTEGER DEFAULT 0,
  fail_qty INTEGER DEFAULT 0, hours REAL DEFAULT 0,
  status TEXT DEFAULT 'printing', note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS job_materials(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES print_jobs(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL, grams REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  model_link_id INTEGER, stock REAL DEFAULT 0, cost REAL DEFAULT 0,
  price REAL DEFAULT 0, note TEXT DEFAULT '', created_at TEXT);
CREATE TABLE IF NOT EXISTS sales(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  channel TEXT DEFAULT '闲鱼', buyer TEXT DEFAULT '',
  shipping REAL DEFAULT 0, discount REAL DEFAULT 0,
  total REAL DEFAULT 0, cost REAL DEFAULT 0, profit REAL DEFAULT 0,
  note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS sale_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL, qty REAL NOT NULL,
  unit_price REAL DEFAULT 0, cost_snapshot REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS model_links(
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, url TEXT NOT NULL,
  source TEXT DEFAULT '其它', image_url TEXT DEFAULT '', tags TEXT DEFAULT '',
  status TEXT DEFAULT 'want', rating INTEGER DEFAULT 0,
  note TEXT DEFAULT '', created_at TEXT);
CREATE TABLE IF NOT EXISTS ideas(
  id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
  done INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS operation_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  module TEXT, action TEXT, detail TEXT);
"""

DEFAULT_SETTINGS = {
    "shop_name": "打印小站",
    "electricity_price": "0.6",   # 元/度
    "machine_rate": "1.0",        # 机时费 元/小时
    "default_power": "120",       # 默认打印机功率 W
    "loss_rate": "5",             # 损耗率 %
    "maintain_hours": "200",      # 打印机保养提醒阈值（累计小时）
}


def init_db():
    conn = get_conn()
    conn.executescript(SCHEMA)
    for k, v in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?,?)", (k, v))
    # 首次运行写入少量示例数据，方便上手（均可删除）
    seeded = conn.execute("SELECT value FROM settings WHERE key='seeded'").fetchone()
    if not seeded:
        ts = now()
        conn.execute("INSERT INTO materials(name,category,brand,spec,unit,total_g,unit_price,min_stock,note,created_at)"
                     " VALUES (?,?,?,?,?,?,?,?,?,?)",
                     ("（示例）PLA 玛雅棕", "耗材", "拓竹", "1.75mm", "克", 1000, 0.02, 200, "示例数据，可删除或编辑", ts))
        conn.execute("INSERT INTO materials(name,category,brand,spec,unit,total_g,unit_price,min_stock,note,created_at)"
                     " VALUES (?,?,?,?,?,?,?,?,?,?)",
                     ("（示例）PLA 曜石黑", "耗材", "拓竹", "1.75mm", "克", 1000, 0.019, 200, "", ts))
        conn.execute("INSERT INTO materials(name,category,brand,spec,unit,total_g,unit_price,min_stock,note,created_at)"
                     " VALUES (?,?,?,?,?,?,?,?,?,?)",
                     ("（示例）0.4mm 喷嘴", "配件", "拓竹", "不锈钢", "个", 0, 3.5, 2, "", ts))
        conn.execute("INSERT INTO printers(name,model,power_w,note,created_at) VALUES (?,?,?,?,?)",
                     ("（示例）A1 mini", "拓竹 A1 mini", 100, "示例数据，可删除", ts))
        conn.execute("INSERT INTO model_links(title,url,source,tags,status,note,created_at) VALUES (?,?,?,?,?,?,?)",
                     ("（示例）关节龙", "https://makerworld.com/zh/models/123456", "MakerWorld",
                      "龙, articulated", "want", "示例数据，可删除", ts))
        conn.execute("INSERT INTO products(name,stock,cost,price,note,created_at) VALUES (?,?,?,?,?,?)",
                     ("（示例）可动关节龙", 5, 3.5, 19.9, "示例数据，可删除", ts))
        conn.execute("INSERT INTO settings(key,value) VALUES ('seeded','1')")
        log_op(conn, "系统", "初始化", "数据库创建完成，已写入示例数据")
    conn.commit()
    conn.close()


# ---------------------------------------------------------------- 旧库升级

def migrate():
    """给老数据库补新列（幂等）"""
    conn = get_conn()
    def add_col(table, col, ddl):
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
        if col not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")
    add_col("products", "img_url", "img_url TEXT DEFAULT ''")
    add_col("products", "xianyu_url", "xianyu_url TEXT DEFAULT ''")
    add_col("products", "weight_g", "weight_g REAL DEFAULT 0")
    add_col("sales", "ship_status", "ship_status TEXT DEFAULT 'pending'")
    add_col("sales", "tracking_no", "tracking_no TEXT DEFAULT ''")
    conn.commit()
    conn.close()


# ---------------------------------------------------------------- 查询辅助

MATERIAL_LIST_SQL = """
SELECT m.*,
  IFNULL((SELECT SUM(qty) FROM stock_movements sm WHERE sm.material_id = m.id), 0) AS stock
FROM materials m
"""


def material_row(r):
    d = dict(r)
    stock = d.pop("stock", 0)
    d["stock"] = round(stock, 2)
    d["low"] = bool(d["min_stock"]) and stock <= d["min_stock"]
    if d["category"] == "耗材" and d["total_g"]:
        d["spools"] = round(stock / d["total_g"], 2)
    else:
        d["spools"] = None
    return d


def get_material(conn, mid):
    r = conn.execute(MATERIAL_LIST_SQL + " WHERE m.id=?", (mid,)).fetchone()
    if not r:
        raise ApiError("物料不存在")
    return material_row(r)


def get_product(conn, pid):
    r = conn.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
    if not r:
        raise ApiError("商品不存在")
    return dict(r)


# ---------------------------------------------------------------- API：看板与设置

def api_stats(h, m, body, qs):
    conn = get_conn()
    month = now()[:7]
    out = {}
    out["shop_name"] = get_setting(conn, "shop_name")
    out["month_purchase"] = conn.execute(
        "SELECT IFNULL(SUM(total),0) FROM purchases WHERE substr(ts,1,7)=?", (month,)).fetchone()[0]
    row = conn.execute("SELECT IFNULL(SUM(total),0), IFNULL(SUM(profit),0) FROM sales WHERE substr(ts,1,7)=?",
                       (month,)).fetchone()
    out["month_sales"], out["month_profit"] = row[0], row[1]
    mats = [material_row(r) for r in conn.execute(MATERIAL_LIST_SQL + " WHERE m.archived=0")]
    out["material_value"] = round(sum(x["stock"] * x["unit_price"] for x in mats), 2)
    out["product_value"] = conn.execute(
        "SELECT IFNULL(SUM(stock*cost),0) FROM products").fetchone()[0]
    out["low_stock"] = [x for x in mats if x["low"]]
    out["backorders"] = [dict(r) for r in conn.execute(
        "SELECT id, name, stock FROM products WHERE stock < 0 ORDER BY stock")]
    out["pending_ship"] = conn.execute(
        "SELECT COUNT(*) FROM sales WHERE ship_status='pending'").fetchone()[0]
    out["maintain_hours"] = fnum(get_setting(conn, "maintain_hours"), 200)
    out["printer_hours"] = [dict(r) for r in conn.execute(
        "SELECT p.id, p.name, IFNULL(SUM(j.hours),0) AS hours"
        " FROM printers p LEFT JOIN print_jobs j ON j.printer_id=p.id AND j.status='done'"
        " GROUP BY p.id ORDER BY hours DESC")]
    out["want_count"] = conn.execute(
        "SELECT COUNT(*) FROM model_links WHERE status='want'").fetchone()[0]
    out["printing_count"] = conn.execute(
        "SELECT COUNT(*) FROM print_jobs WHERE status='printing'").fetchone()[0]
    daily = []
    today = datetime.now()
    for i in range(6, -1, -1):
        day = (today - timedelta(days=i)).strftime("%Y-%m-%d")
        total = conn.execute("SELECT IFNULL(SUM(total),0) FROM sales WHERE substr(ts,1,10)=?",
                             (day,)).fetchone()[0]
        daily.append({"date": day[5:], "total": round(total, 2)})
    out["daily"] = daily
    out["recent"] = [dict(r) for r in conn.execute(
        "SELECT * FROM operation_log ORDER BY id DESC LIMIT 8")]
    conn.close()
    h.send_json(out)


def get_setting(conn, key):
    r = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return r["value"] if r else DEFAULT_SETTINGS.get(key, "")


def api_settings_get(h, m, body, qs):
    conn = get_conn()
    out = {k: get_setting(conn, k) for k in DEFAULT_SETTINGS}
    conn.close()
    h.send_json(out)


def api_settings_put(h, m, body, qs):
    conn = get_conn()
    for k in DEFAULT_SETTINGS:
        if k in body:
            conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
                         (k, str(body[k]).strip()))
    log_op(conn, "设置", "修改", "更新了站点设置")
    conn.commit()
    out = {k: get_setting(conn, k) for k in DEFAULT_SETTINGS}
    conn.close()
    h.send_json({"ok": True, "settings": out})


# ---------------------------------------------------------------- API：物料与出入库

def api_materials_list(h, m, body, qs):
    conn = get_conn()
    sql = MATERIAL_LIST_SQL
    cond, args = [], []
    if qs.get("all") != "1":
        cond.append("m.archived=0")
    if qs.get("q"):
        cond.append("(m.name LIKE ? OR m.brand LIKE ? OR m.spec LIKE ?)")
        q = f"%{qs['q']}%"
        args += [q, q, q]
    if qs.get("category"):
        cond.append("m.category=?")
        args.append(qs["category"])
    if cond:
        sql += " WHERE " + " AND ".join(cond)
    sql += " ORDER BY m.archived ASC, m.id DESC"
    items = [material_row(r) for r in conn.execute(sql, args)]
    conn.close()
    h.send_json({"items": items})


def _material_fields(body, old=None):
    name = (body.get("name") or "").strip()
    if not name:
        raise ApiError("请填写物料名称")
    category = body.get("category") or "其它"
    unit = "克" if category == "耗材" else (body.get("unit") or "个").strip() or "个"
    return {
        "name": name, "category": category,
        "brand": (body.get("brand") or "").strip(),
        "spec": (body.get("spec") or "").strip(),
        "unit": unit,
        "total_g": max(fnum(body.get("total_g")), 0),
        "unit_price": max(fnum(body.get("unit_price")), 0),
        "min_stock": max(fnum(body.get("min_stock")), 0),
        "note": (body.get("note") or "").strip(),
    }


def api_materials_create(h, m, body, qs):
    d = _material_fields(body)
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO materials(name,category,brand,spec,unit,total_g,unit_price,min_stock,note,created_at)"
        " VALUES (:name,:category,:brand,:spec,:unit,:total_g,:unit_price,:min_stock,:note,:ts)",
        {**d, "ts": now()})
    log_op(conn, "物料", "新增", f"新增物料「{d['name']}」")
    conn.commit()
    row = get_material(conn, cur.lastrowid)
    conn.close()
    h.send_json({"item": row})


def api_materials_update(h, m, body, qs):
    mid = int(m.group(1))
    d = _material_fields(body)
    conn = get_conn()
    get_material(conn, mid)
    conn.execute(
        "UPDATE materials SET name=:name, category=:category, brand=:brand, spec=:spec,"
        " unit=:unit, total_g=:total_g, unit_price=:unit_price, min_stock=:min_stock,"
        " note=:note WHERE id=:id", {**d, "id": mid})
    if "archived" in body:
        conn.execute("UPDATE materials SET archived=? WHERE id=?", (1 if body["archived"] else 0, mid))
    log_op(conn, "物料", "修改", f"修改物料「{d['name']}」")
    conn.commit()
    row = get_material(conn, mid)
    conn.close()
    h.send_json({"item": row})


def api_materials_delete(h, m, body, qs):
    mid = int(m.group(1))
    conn = get_conn()
    row = get_material(conn, mid)
    used = conn.execute("SELECT COUNT(*) FROM stock_movements WHERE material_id=?", (mid,)).fetchone()[0]
    if used:
        raise ApiError("该物料已有出入库记录，不能删除；可改为停用")
    conn.execute("DELETE FROM materials WHERE id=?", (mid,))
    log_op(conn, "物料", "删除", f"删除物料「{row['name']}」")
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


def api_materials_movement(h, m, body, qs):
    mid = int(m.group(1))
    typ = body.get("type")
    qty = fnum(body.get("qty"))
    note = (body.get("note") or "").strip()
    if typ not in ("in", "out", "adjust"):
        raise ApiError("无效的出入库类型")
    conn = get_conn()
    conn.execute("BEGIN IMMEDIATE")  # 防并发出入库竞态
    mat = get_material(conn, mid)
    stock = mat["stock"]
    if typ == "in":
        if qty <= 0:
            raise ApiError("入库数量需大于 0")
        delta, ref = qty, "manual"
    elif typ == "out":
        if qty <= 0:
            raise ApiError("出库数量需大于 0")
        if qty > stock + 1e-9:
            raise ApiError(f"库存不足（当前 {stock:g} {mat['unit']}），可先用「盘点」修正")
        delta, ref = -qty, "manual"
    else:
        delta = qty - stock
        note = note or f"盘点调整为 {qty:g}"
        if abs(delta) < 1e-9:
            conn.close()
            h.send_json({"ok": True, "item": mat})
            return
    conn.execute(
        "INSERT INTO stock_movements(material_id,ts,qty,unit_cost,ref_type,note) VALUES (?,?,?,?,?,?)",
        (mid, now(), delta, mat["unit_price"], ref, note))
    action = {"in": "入库", "out": "出库", "adjust": "盘点"}[typ]
    log_op(conn, "物料", action, f"「{mat['name']}」{action} {abs(delta):g} {mat['unit']}"
                                 + (f"（{note}）" if note else ""))
    conn.commit()
    row = get_material(conn, mid)
    conn.close()
    h.send_json({"item": row})


def api_movements_list(h, m, body, qs):
    conn = get_conn()
    mid = int(m.group(1))
    rows = conn.execute(
        "SELECT sm.*, m.name AS material_name, m.unit FROM stock_movements sm"
        " JOIN materials m ON m.id=sm.material_id WHERE sm.material_id=? ORDER BY sm.id DESC LIMIT 200",
        (mid,)).fetchall()
    conn.close()
    h.send_json({"items": [dict(r) for r in rows]})


# ---------------------------------------------------------------- API：采购

def api_purchases_list(h, m, body, qs):
    conn = get_conn()
    items = []
    for r in conn.execute("SELECT * FROM purchases ORDER BY id DESC LIMIT 200"):
        d = dict(r)
        d["items"] = [dict(x) for x in conn.execute(
            "SELECT pi.*, m.name AS material_name, m.unit, m.total_g FROM purchase_items pi"
            " JOIN materials m ON m.id=pi.material_id WHERE pi.purchase_id=? ORDER BY pi.id", (d["id"],))]
        items.append(d)
    conn.close()
    h.send_json({"items": items})


def api_purchases_create(h, m, body, qs):
    supplier = (body.get("supplier") or "").strip() or "未填供应商"
    note = (body.get("note") or "").strip()
    rows = body.get("items") or []
    if not rows:
        raise ApiError("请至少添加一条采购明细")
    conn = get_conn()
    total = 0
    detail_txt = []
    cur = conn.execute(
        "INSERT INTO purchases(ts,supplier,total,status,note) VALUES (?,?,?,?,?)",
        (now(), supplier, 0, "pending", note))
    pid = cur.lastrowid
    for r in rows:
        mid = int(r.get("material_id") or 0)
        mat = get_material(conn, mid)
        qty = fnum(r.get("qty"))
        price = fnum(r.get("unit_price"))
        if qty <= 0:
            raise ApiError(f"「{mat['name']}」数量需大于 0")
        if price < 0:
            raise ApiError(f"「{mat['name']}」单价不能为负")
        total += qty * price
        conn.execute(
            "INSERT INTO purchase_items(purchase_id,material_id,qty,unit_price) VALUES (?,?,?,?)",
            (pid, mid, qty, price))
        detail_txt.append(f"{mat['name']}×{qty:g}{mat['unit']}")
    conn.execute("UPDATE purchases SET total=? WHERE id=?", (round(total, 2), pid))
    log_op(conn, "采购", "新增", f"采购单#{pid}（{supplier}）：{'，'.join(detail_txt)}，合计 ¥{total:.2f}")
    conn.commit()
    conn.close()
    h.send_json({"ok": True, "id": pid})


def api_purchases_confirm(h, m, body, qs):
    pid = int(m.group(1))
    conn = get_conn()
    conn.execute("BEGIN IMMEDIATE")
    p = conn.execute("SELECT * FROM purchases WHERE id=?", (pid,)).fetchone()
    if not p:
        raise ApiError("采购单不存在")
    if p["status"] != "pending":
        raise ApiError("该采购单已入库")
    for it in conn.execute("SELECT * FROM purchase_items WHERE purchase_id=?", (pid,)):
        mat = get_material(conn, it["material_id"])
        conn.execute(
            "INSERT INTO stock_movements(material_id,ts,qty,unit_cost,ref_type,ref_id,note)"
            " VALUES (?,?,?,?,?,?,?)",
            (it["material_id"], now(), it["qty"], it["unit_price"], "purchase", pid, f"采购单#{pid}"))
        if it["unit_price"] > 0:
            conn.execute("UPDATE materials SET unit_price=? WHERE id=?",
                         (it["unit_price"], it["material_id"]))
    conn.execute("UPDATE purchases SET status='done' WHERE id=?", (pid,))
    log_op(conn, "采购", "确认入库", f"采购单#{pid}（{p['supplier']}）已入库，金额 ¥{p['total']:.2f}")
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


def api_purchases_delete(h, m, body, qs):
    pid = int(m.group(1))
    conn = get_conn()
    p = conn.execute("SELECT * FROM purchases WHERE id=?", (pid,)).fetchone()
    if not p:
        raise ApiError("采购单不存在")
    if p["status"] != "pending":
        raise ApiError("已入库的采购单不能删除（涉及库存流水）")
    conn.execute("DELETE FROM purchases WHERE id=?", (pid,))
    log_op(conn, "采购", "删除", f"删除采购单#{pid}（{p['supplier']}）")
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


# ---------------------------------------------------------------- API：打印机

def api_printers_list(h, m, body, qs):
    conn = get_conn()
    items = [dict(r) for r in conn.execute(
        "SELECT p.*, IFNULL((SELECT SUM(j.hours) FROM print_jobs j"
        " WHERE j.printer_id=p.id AND j.status='done'),0) AS total_hours"
        " FROM printers p ORDER BY p.id DESC")]
    conn.close()
    h.send_json({"items": items})


def _printer_fields(body):
    name = (body.get("name") or "").strip()
    if not name:
        raise ApiError("请填写打印机名称")
    return {"name": name, "model": (body.get("model") or "").strip(),
            "power_w": max(fnum(body.get("power_w"), 120), 0),
            "note": (body.get("note") or "").strip()}


def api_printers_create(h, m, body, qs):
    d = _printer_fields(body)
    conn = get_conn()
    cur = conn.execute("INSERT INTO printers(name,model,power_w,note,created_at) VALUES (:name,:model,:power_w,:note,:ts)",
                       {**d, "ts": now()})
    log_op(conn, "打印", "新增打印机", d["name"])
    conn.commit()
    row = dict(conn.execute("SELECT * FROM printers WHERE id=?", (cur.lastrowid,)).fetchone())
    conn.close()
    h.send_json({"item": row})


def api_printers_update(h, m, body, qs):
    pid = int(m.group(1))
    d = _printer_fields(body)
    conn = get_conn()
    conn.execute("UPDATE printers SET name=:name, model=:model, power_w=:power_w, note=:note WHERE id=:id",
                 {**d, "id": pid})
    log_op(conn, "打印", "修改打印机", d["name"])
    conn.commit()
    row = dict(conn.execute("SELECT * FROM printers WHERE id=?", (pid,)).fetchone())
    conn.close()
    h.send_json({"item": row})


def api_printers_delete(h, m, body, qs):
    pid = int(m.group(1))
    conn = get_conn()
    used = conn.execute("SELECT COUNT(*) FROM print_jobs WHERE printer_id=?", (pid,)).fetchone()[0]
    if used:
        raise ApiError("该打印机已有打印任务记录，不能删除")
    conn.execute("DELETE FROM printers WHERE id=?", (pid,))
    log_op(conn, "打印", "删除打印机", f"#{pid}")
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


# ---------------------------------------------------------------- API：打印任务

JOB_SQL = """
SELECT j.*, p.name AS printer_name, ml.title AS model_title
FROM print_jobs j
LEFT JOIN printers p ON p.id = j.printer_id
LEFT JOIN model_links ml ON ml.id = j.model_link_id
"""


def job_row(conn, r):
    d = dict(r)
    d["materials"] = [dict(x) for x in conn.execute(
        "SELECT jm.material_id, jm.grams, m.name, m.unit, m.unit_price"
        " FROM job_materials jm JOIN materials m ON m.id=jm.material_id WHERE jm.job_id=? ORDER BY jm.id",
        (d["id"],))]
    d["cost"] = round(sum(x["grams"] * x["unit_price"] for x in d["materials"]), 2)
    return d


def api_jobs_list(h, m, body, qs):
    conn = get_conn()
    items = [job_row(conn, r) for r in conn.execute(
        JOB_SQL + " ORDER BY CASE j.status WHEN 'printing' THEN 0 WHEN 'done' THEN 1 ELSE 2 END, j.id DESC LIMIT 200")]
    conn.close()
    h.send_json({"items": items})


def api_jobs_create(h, m, body, qs):
    title = (body.get("title") or "").strip()
    if not title:
        raise ApiError("请填写任务标题（打印什么模型）")
    conn = get_conn()
    printer_id = int(body["printer_id"]) if body.get("printer_id") else None
    model_link_id = int(body["model_link_id"]) if body.get("model_link_id") else None
    planned = max(int(fnum(body.get("planned_qty"), 1)), 1)
    cur = conn.execute(
        "INSERT INTO print_jobs(ts,title,printer_id,model_link_id,planned_qty,note)"
        " VALUES (?,?,?,?,?,?)",
        (now(), title, printer_id, model_link_id, planned, (body.get("note") or "").strip()))
    jid = cur.lastrowid
    grams_txt = []
    for r in (body.get("materials") or []):
        mid = int(r.get("material_id") or 0)
        grams = fnum(r.get("grams"))
        if mid and grams > 0:
            mat = get_material(conn, mid)
            conn.execute("INSERT INTO job_materials(job_id,material_id,grams) VALUES (?,?,?)", (jid, mid, grams))
            grams_txt.append(f"{mat['name']} {grams:g}g")
    log_op(conn, "打印", "新增任务", f"「{title}」×{planned}" + (f"（{'，'.join(grams_txt)}）" if grams_txt else ""))
    conn.commit()
    row = job_row(conn, conn.execute(JOB_SQL + " WHERE j.id=?", (jid,)).fetchone())
    conn.close()
    h.send_json({"item": row})


def api_jobs_complete(h, m, body, qs):
    jid = int(m.group(1))
    conn = get_conn()
    conn.execute("BEGIN IMMEDIATE")  # 串行化材料扣减，防并发超扣
    r = conn.execute(JOB_SQL + " WHERE j.id=?", (jid,)).fetchone()
    if not r:
        raise ApiError("任务不存在")
    job = job_row(conn, r)
    if job["status"] != "printing":
        raise ApiError("该任务已结束")
    done = int(fnum(body.get("done_qty")))
    fail = int(fnum(body.get("fail_qty")))
    hours = fnum(body.get("hours"))
    if done < 0 or fail < 0:
        raise ApiError("成品/废件数量不能为负")
    if done + fail == 0:
        raise ApiError("成品数与废件数不能同时为 0")
    # 先校验材料库存是否充足
    for jm in job["materials"]:
        mat = get_material(conn, jm["material_id"])
        if jm["grams"] > mat["stock"] + 1e-9:
            raise ApiError(f"材料「{mat['name']}」库存不足（剩 {mat['stock']:g}{mat['unit']}，需 {jm['grams']:g}g），可先采购入库或盘点")
    # 扣减材料
    cost_total = 0.0
    for jm in job["materials"]:
        mat = get_material(conn, jm["material_id"])
        conn.execute(
            "INSERT INTO stock_movements(material_id,ts,qty,unit_cost,ref_type,ref_id,note)"
            " VALUES (?,?,?,?,?,?,?)",
            (jm["material_id"], now(), -jm["grams"], mat["unit_price"], "print", jid,
             f"打印任务「{job['title']}」"))
        cost_total += jm["grams"] * mat["unit_price"]
    per_cost = cost_total / done if done > 0 else 0
    # 成品入库
    if body.get("create_product", True) and done > 0:
        pname = (body.get("product_name") or "").strip() or job["title"]
        pprice = fnum(body.get("product_price"))
        exist = conn.execute("SELECT * FROM products WHERE name=?", (pname,)).fetchone()
        if exist:
            conn.execute("UPDATE products SET stock=stock+?, cost=?, model_link_id=IFNULL(model_link_id,?) WHERE id=?",
                         (done, round(per_cost, 2), job["model_link_id"], exist["id"]))
            pid = exist["id"]
        else:
            cur = conn.execute(
                "INSERT INTO products(name,model_link_id,stock,cost,price,created_at) VALUES (?,?,?,?,?,?)",
                (pname, job["model_link_id"], done, round(per_cost, 2), pprice, now()))
            pid = cur.lastrowid
        log_op(conn, "成品", "入库", f"「{pname}」×{done}（单件成本 ¥{per_cost:.2f}）")
    conn.execute(
        "UPDATE print_jobs SET status='done', done_qty=?, fail_qty=?, hours=? WHERE id=?",
        (done, fail, hours, jid))
    log_op(conn, "打印", "完成任务",
           f"「{job['title']}」成品 {done} / 废件 {fail}，耗时 {hours:g}h，材料成本 ¥{cost_total:.2f}")
    conn.commit()
    row = job_row(conn, conn.execute(JOB_SQL + " WHERE j.id=?", (jid,)).fetchone())
    conn.close()
    h.send_json({"item": row})


def api_jobs_cancel(h, m, body, qs):
    jid = int(m.group(1))
    conn = get_conn()
    r = conn.execute("SELECT * FROM print_jobs WHERE id=?", (jid,)).fetchone()
    if not r:
        raise ApiError("任务不存在")
    if r["status"] != "printing":
        raise ApiError("该任务已结束")
    conn.execute("UPDATE print_jobs SET status='canceled' WHERE id=?", (jid,))
    log_op(conn, "打印", "取消任务", f"「{r['title']}」")
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


def api_jobs_delete(h, m, body, qs):
    jid = int(m.group(1))
    conn = get_conn()
    r = conn.execute("SELECT * FROM print_jobs WHERE id=?", (jid,)).fetchone()
    if not r:
        raise ApiError("任务不存在")
    if r["status"] == "done":
        raise ApiError("已完成的任务涉及库存流水，不能删除")
    conn.execute("DELETE FROM print_jobs WHERE id=?", (jid,))
    log_op(conn, "打印", "删除任务", f"「{r['title']}」")
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


# ---------------------------------------------------------------- API：成品

def api_products_list(h, m, body, qs):
    conn = get_conn()
    items = [dict(r) for r in conn.execute("SELECT * FROM products ORDER BY id DESC")]
    conn.close()
    h.send_json({"items": items})


def _product_fields(body):
    name = (body.get("name") or "").strip()
    if not name:
        raise ApiError("请填写商品名称")
    return {"name": name,
            "model_link_id": int(body["model_link_id"]) if body.get("model_link_id") else None,
            "cost": max(fnum(body.get("cost")), 0),
            "price": max(fnum(body.get("price")), 0),
            "weight_g": max(fnum(body.get("weight_g")), 0),
            "img_url": safe_url(body.get("img_url"), "图片链接"),
            "xianyu_url": safe_url(body.get("xianyu_url"), "闲鱼链接"),
            "note": (body.get("note") or "").strip()}


def api_products_create(h, m, body, qs):
    d = _product_fields(body)
    conn = get_conn()
    cur = conn.execute("INSERT INTO products(name,model_link_id,stock,cost,price,weight_g,img_url,xianyu_url,note,created_at)"
                       " VALUES (:name,:model_link_id,:stock,:cost,:price,:weight_g,:img_url,:xianyu_url,:note,:ts)",
                       {**d, "stock": fnum(body.get("stock")), "ts": now()})
    log_op(conn, "成品", "新增", f"「{d['name']}」")
    conn.commit()
    row = dict(conn.execute("SELECT * FROM products WHERE id=?", (cur.lastrowid,)).fetchone())
    conn.close()
    h.send_json({"item": row})


def api_products_update(h, m, body, qs):
    pid = int(m.group(1))
    d = _product_fields(body)
    conn = get_conn()
    get_product(conn, pid)
    conn.execute("UPDATE products SET name=:name, model_link_id=:model_link_id, cost=:cost, price=:price,"
                 " weight_g=:weight_g, img_url=:img_url, xianyu_url=:xianyu_url, note=:note"
                 " WHERE id=:id", {**d, "id": pid})
    log_op(conn, "成品", "修改", f"「{d['name']}」")
    conn.commit()
    row = dict(conn.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone())
    conn.close()
    h.send_json({"item": row})


def api_products_delete(h, m, body, qs):
    pid = int(m.group(1))
    conn = get_conn()
    used = conn.execute("SELECT COUNT(*) FROM sale_items WHERE product_id=?", (pid,)).fetchone()[0]
    if used:
        raise ApiError("该商品已有销售记录，不能删除")
    p = get_product(conn, pid)
    conn.execute("DELETE FROM products WHERE id=?", (pid,))
    log_op(conn, "成品", "删除", f"「{p['name']}」")
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


def api_products_movement(h, m, body, qs):
    pid = int(m.group(1))
    typ = body.get("type")
    qty = fnum(body.get("qty"))
    note = (body.get("note") or "").strip()
    conn = get_conn()
    conn.execute("BEGIN IMMEDIATE")  # 防并发竞态
    p = get_product(conn, pid)
    if typ == "in":
        if qty <= 0:
            raise ApiError("入库数量需大于 0")
        conn.execute("UPDATE products SET stock=stock+? WHERE id=?", (qty, pid))
    elif typ == "out":
        if qty <= 0:
            raise ApiError("出库数量需大于 0")
        if qty > p["stock"] + 1e-9:
            raise ApiError(f"库存不足（剩 {p['stock']:g} 件）")
        conn.execute("UPDATE products SET stock=stock-? WHERE id=?", (qty, pid))
    elif typ == "adjust":
        conn.execute("UPDATE products SET stock=? WHERE id=?", (qty, pid))
        note = note or f"盘点调整为 {qty:g}"
    else:
        raise ApiError("无效的出入库类型")
    log_op(conn, "成品", {"in": "入库", "out": "出库", "adjust": "盘点"}[typ],
           f"「{p['name']}」{'' if typ=='adjust' else abs(qty)}{note}")
    conn.commit()
    row = dict(conn.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone())
    conn.close()
    h.send_json({"item": row})


# ---------------------------------------------------------------- API：销售

def api_sales_list(h, m, body, qs):
    conn = get_conn()
    items = []
    for r in conn.execute("SELECT * FROM sales ORDER BY id DESC LIMIT 200"):
        d = dict(r)
        d["items"] = [dict(x) for x in conn.execute(
            "SELECT si.*, p.name FROM sale_items si JOIN products p ON p.id=si.product_id"
            " WHERE si.sale_id=? ORDER BY si.id", (d["id"],))]
        items.append(d)
    conn.close()
    h.send_json({"items": items})


def api_sales_create(h, m, body, qs):
    channel = (body.get("channel") or "闲鱼").strip()
    buyer = (body.get("buyer") or "").strip()
    note = (body.get("note") or "").strip()
    allow_backorder = bool(body.get("allow_backorder"))
    rows = body.get("items") or []
    if not rows:
        raise ApiError("请至少添加一个商品")
    conn = get_conn()
    conn.execute("BEGIN IMMEDIATE")  # 串行化库存检查与扣减，防并发超卖
    # 先校验库存（缺货时允许按「预售」接单）
    prepared = []
    oversold = []
    for r in rows:
        p = get_product(conn, int(r.get("product_id") or 0))
        qty = fnum(r.get("qty"))
        if qty <= 0:
            raise ApiError(f"「{p['name']}」数量需大于 0")
        if qty > p["stock"] + 1e-9:
            lack = round(qty - p["stock"], 2)
            if not allow_backorder:
                raise ApiError(f"商品「{p['name']}」库存不足（剩 {p['stock']:g} 件）——可点「按预售接单」先记录，打印入库后自动冲销欠货")
            oversold.append(f"{p['name']} 欠 {lack:g} 件")
        prepared.append((p, qty, max(fnum(r.get("unit_price"), p["price"]), 0)))
    shipping = max(fnum(body.get("shipping")), 0)
    discount = max(fnum(body.get("discount")), 0)
    items_sum = sum(qty * price for _, qty, price in prepared)
    discount = min(discount, items_sum + shipping)  # 优惠不能超过应收
    total = items_sum + shipping - discount
    cost = sum(qty * p["cost"] for p, qty, _ in prepared)
    profit = total - cost
    cur = conn.execute(
        "INSERT INTO sales(ts,channel,buyer,shipping,discount,total,cost,profit,note)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (now(), channel, buyer, shipping, discount, round(total, 2), round(cost, 2),
         round(profit, 2), note))
    sid = cur.lastrowid
    for p, qty, price in prepared:
        conn.execute(
            "INSERT INTO sale_items(sale_id,product_id,qty,unit_price,cost_snapshot) VALUES (?,?,?,?,?)",
            (sid, p["id"], qty, price, p["cost"]))
        conn.execute("UPDATE products SET stock=stock-? WHERE id=?", (qty, p["id"]))
    detail = "，".join(f"{p['name']}×{qty:g}" for p, qty, _ in prepared)
    if oversold:
        detail += "（预售：" + "，".join(oversold) + "）"
    log_op(conn, "销售", "新增", f"[{channel}] {detail}，实收 ¥{total:.2f}，利润 ¥{profit:.2f}")
    conn.commit()
    conn.close()
    h.send_json({"ok": True, "id": sid, "profit": round(profit, 2)})


def api_sales_ship(h, m, body, qs):
    sid = int(m.group(1))
    conn = get_conn()
    s = conn.execute("SELECT * FROM sales WHERE id=?", (sid,)).fetchone()
    if not s:
        raise ApiError("销售记录不存在")
    ship_status = "shipped" if body.get("ship_status", "shipped") in ("shipped", "1", True) else "pending"
    tracking_no = (body.get("tracking_no") or "").strip()
    conn.execute("UPDATE sales SET ship_status=?, tracking_no=? WHERE id=?",
                 (ship_status, tracking_no, sid))
    log_op(conn, "销售", "已发货" if ship_status == "shipped" else "标记待发货",
           f"#{sid} [{s['channel']}] {tracking_no or '（未填单号）'}")
    conn.commit()
    row = dict(conn.execute("SELECT * FROM sales WHERE id=?", (sid,)).fetchone())
    conn.close()
    h.send_json({"item": row})


def api_sales_delete(h, m, body, qs):
    sid = int(m.group(1))
    conn = get_conn()
    conn.execute("BEGIN IMMEDIATE")
    s = conn.execute("SELECT * FROM sales WHERE id=?", (sid,)).fetchone()
    if not s:
        raise ApiError("销售记录不存在")
    for it in conn.execute("SELECT * FROM sale_items WHERE sale_id=?", (sid,)):
        conn.execute("UPDATE products SET stock=stock+? WHERE id=?", (it["qty"], it["product_id"]))
    conn.execute("DELETE FROM sales WHERE id=?", (sid,))
    log_op(conn, "销售", "删除", f"删除销售记录#{sid}（已返还成品库存）")
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


# ---------------------------------------------------------------- API：图片上传（粘贴即存本地）

def api_upload_image(h, m, body, qs):
    data = body.get("data") or ""
    mre = re.match(r"^data:image/(png|jpeg|jpg|webp|gif);base64,(.+)$", data, re.S)
    if not mre:
        raise ApiError("仅支持粘贴/选择图片（png、jpg、webp、gif）")
    ext = mre.group(1).lower().replace("jpeg", "jpg")
    b64 = mre.group(2).strip()
    try:
        raw = base64.b64decode(b64)
    except Exception:
        raise ApiError("图片数据解析失败")
    if not raw:
        raise ApiError("图片内容为空")
    if len(raw) > 9 * 1024 * 1024:
        raise ApiError("图片太大（超过 9MB），请压缩后再传")
    fname = f"img-{datetime.now():%Y%m%d-%H%M%S}-{os.urandom(3).hex()}.{ext}"
    with open(os.path.join(UPLOAD_DIR, fname), "wb") as f:
        f.write(raw)
    conn = get_conn()
    log_op(conn, "成品", "上传图片", fname)
    conn.commit()
    conn.close()
    h.send_json({"url": f"/uploads/{fname}"})


# ---------------------------------------------------------------- API：Printables 热门（实验性，接口失效自动降级）

PRINTABLES_GQL = """query SearchModels($query: String!, $limit: Int, $ordering: SearchChoicesEnum) {
  result: searchPrints2(query: $query, printType: print, limit: $limit, ordering: $ordering) {
    items { ...Model __typename }
  }
}
fragment AvatarUser on UserType { id handle publicUsername __typename }
fragment Model on PrintType {
  id name slug ratingAvg likesCount downloadCount datePublished
  user { ...AvatarUser __typename }
  image { filePath }
  __typename
}"""


HOT_CACHE = {}

HOT_ORDERINGS = ("popular", "latest", "rating", "makes_count", "best_match")


def _printables_search(kw, ordering, limit):
    payload = {
        "query": PRINTABLES_GQL,
        "operationName": "SearchModels",
        "variables": {"query": kw, "limit": limit, "ordering": ordering},
    }
    req = urllib.request.Request(
        "https://api.printables.com/graphql/",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8", errors="ignore"))
    items = []
    for it in ((data.get("data") or {}).get("result") or {}).get("items") or []:
        fp = ((it.get("image") or {}).get("filePath") or "").lstrip("/")
        items.append({
            "id": it.get("id"),
            "name": it.get("name") or "未命名",
            "author": ((it.get("user") or {}).get("publicUsername")) or "",
            "likes": it.get("likesCount") or 0,
            "downloads": it.get("downloadCount") or 0,
            "image": ("https://media.printables.com/" + fp) if fp else "",
            "url": f"https://www.printables.com/model/{it.get('id')}-{it.get('slug') or ''}".rstrip("-"),
        })
    return items


def api_hot(h, m, body, qs):
    kw = (qs.get("q") or "").strip()
    ordering = qs.get("ordering") or ("best_match" if kw else "popular")
    if ordering not in HOT_ORDERINGS:
        ordering = "popular"
    try:
        limit = min(max(int(fnum(qs.get("limit"), 12)), 1), 24)
    except Exception:
        limit = 12
    key = f"{kw.lower()}|{ordering}|{limit}"
    ts = datetime.now().timestamp()
    force = qs.get("force") == "1"
    cached = HOT_CACHE.get(key)
    if not force and cached and ts - cached["ts"] < 1800:
        h.send_json({"items": cached["items"], "cached": True})
        return
    try:
        items = _printables_search(kw, ordering, limit)
        HOT_CACHE[key] = {"ts": ts, "items": items}
        if len(HOT_CACHE) > 6:  # 只保留最近 6 个搜索组合
            for k_old in sorted(HOT_CACHE, key=lambda k: HOT_CACHE[k]["ts"])[:-6]:
                HOT_CACHE.pop(k_old, None)
        h.send_json({"items": items})
    except Exception as e:
        h.send_json({"items": [], "error":
                     f"连接 Printables 失败（可能网络被墙或接口已变更）：{e}。可用上方「逛热门」按钮直接打开网页浏览。"})


def api_thumb(h, m, body, qs):
    """服务端代理热门模型缩略图（只允许 Printables CDN，本地缓存）"""
    u = (qs.get("u") or "").strip()
    if not (u.startswith("https://media.printables.com/") or u.startswith("https://api.printables.com/")):
        raise ApiError("不支持的图片地址")
    ext = os.path.splitext(u.split("?")[0])[1].lower()
    ext = ext if ext in (".jpg", ".jpeg", ".png", ".webp", ".gif") else ".jpg"
    path = os.path.join(UPLOAD_DIR, "thumb-" + hashlib.md5(u.encode()).hexdigest() + ext)
    if not os.path.exists(path):
        req = urllib.request.Request(u, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Referer": "https://www.printables.com/"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read(6 * 1024 * 1024)
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    with open(path, "rb") as f:
        data = f.read()
    h._send(200, CONTENT_TYPES.get(ext, "image/jpeg"), data)


# ---------------------------------------------------------------- API：模型收藏

SOURCE_MAP = [
    ("makerworld", "MakerWorld"), ("printables", "Printables"),
    ("thingiverse", "Thingiverse"), ("cults3d", "Cults3D"),
    ("thangs", "Thangs"), ("myminifactory", "MyMiniFactory"),
]


def guess_source(url):
    u = url.lower()
    for key, name in SOURCE_MAP:
        if key in u:
            return name
    return "其它"


MODEL_STATUS = {"want": "想打", "printing": "打印中", "listed": "已上架", "dropped": "放弃"}


def api_models_list(h, m, body, qs):
    conn = get_conn()
    cond, args = [], []
    if qs.get("status"):
        cond.append("status=?")
        args.append(qs["status"])
    if qs.get("q"):
        cond.append("(title LIKE ? OR tags LIKE ? OR url LIKE ?)")
        q = f"%{qs['q']}%"
        args += [q, q, q]
    sql = "SELECT * FROM model_links"
    if cond:
        sql += " WHERE " + " AND ".join(cond)
    sql += " ORDER BY id DESC LIMIT 500"
    items = []
    for r in conn.execute(sql, args):
        d = dict(r)
        d["status_label"] = MODEL_STATUS.get(d["status"], d["status"])
        items.append(d)
    conn.close()
    h.send_json({"items": items})


def _model_fields(body):
    title = (body.get("title") or "").strip()
    url = (body.get("url") or "").strip()
    if not title:
        raise ApiError("请填写模型名称")
    if not url.startswith("http://") and not url.startswith("https://"):
        raise ApiError("链接需以 http(s):// 开头")
    status = body.get("status") or "want"
    if status not in MODEL_STATUS:
        status = "want"
    return {"title": title, "url": url,
            "source": (body.get("source") or "").strip() or guess_source(url),
            "image_url": safe_url(body.get("image_url"), "图片链接"),
            "tags": (body.get("tags") or "").strip(),
            "status": status, "rating": max(0, min(5, int(fnum(body.get("rating"))))),
            "note": (body.get("note") or "").strip()}


def api_models_create(h, m, body, qs):
    d = _model_fields(body)
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO model_links(title,url,source,image_url,tags,status,rating,note,created_at)"
        " VALUES (:title,:url,:source,:image_url,:tags,:status,:rating,:note,:ts)",
        {**d, "ts": now()})
    log_op(conn, "模型", "收藏", f"「{d['title']}」（{d['source']}）")
    conn.commit()
    row = dict(conn.execute("SELECT * FROM model_links WHERE id=?", (cur.lastrowid,)).fetchone())
    conn.close()
    h.send_json({"item": row})


def api_models_update(h, m, body, qs):
    mid = int(m.group(1))
    d = _model_fields(body)
    conn = get_conn()
    conn.execute(
        "UPDATE model_links SET title=:title, url=:url, source=:source, image_url=:image_url,"
        " tags=:tags, status=:status, rating=:rating, note=:note WHERE id=:id", {**d, "id": mid})
    log_op(conn, "模型", "修改", f"「{d['title']}」→ {MODEL_STATUS[d['status']]}")
    conn.commit()
    row = dict(conn.execute("SELECT * FROM model_links WHERE id=?", (mid,)).fetchone())
    conn.close()
    h.send_json({"item": row})


def api_models_delete(h, m, body, qs):
    mid = int(m.group(1))
    conn = get_conn()
    r = conn.execute("SELECT * FROM model_links WHERE id=?", (mid,)).fetchone()
    if not r:
        raise ApiError("收藏不存在")
    conn.execute("DELETE FROM model_links WHERE id=?", (mid,))
    log_op(conn, "模型", "删除", f"「{r['title']}」")
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


def api_models_fetch_title(h, m, body, qs):
    url = (body.get("url") or "").strip()
    if not url.startswith("http"):
        raise ApiError("请先填写有效链接")
    title = None
    image = None
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "zh-CN,zh;q=0.9"})
        with urllib.request.urlopen(req, timeout=6) as resp:
            raw = resp.read(300000)
        text = raw.decode("utf-8", errors="ignore")
        m1 = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)', text)
        if not m1:
            m1 = re.search(r'<title[^>]*>([^<]+)</title>', text, re.I)
        if m1:
            title = html_lib.unescape(m1.group(1)).strip()
            title = re.sub(r"\s+", " ", title)[:120] or None
        m2 = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)', text)
        if not m2:
            m2 = re.search(r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)', text)
        if m2:
            image = html_lib.unescape(m2.group(1)).strip()
            image = urljoin(url, image)[:500] or None
    except Exception:
        pass
    h.send_json({"title": title, "image": image})


# ---------------------------------------------------------------- API：点子板

def api_ideas_list(h, m, body, qs):
    conn = get_conn()
    items = [dict(r) for r in conn.execute("SELECT * FROM ideas ORDER BY done ASC, id DESC LIMIT 100")]
    conn.close()
    h.send_json({"items": items})


def api_ideas_create(h, m, body, qs):
    content = (body.get("content") or "").strip()
    if not content:
        raise ApiError("请填写点子内容")
    conn = get_conn()
    conn.execute("INSERT INTO ideas(content,created_at) VALUES (?,?)", (content, now()))
    log_op(conn, "点子", "新增", content[:50])
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


def api_ideas_update(h, m, body, qs):
    iid = int(m.group(1))
    conn = get_conn()
    conn.execute("UPDATE ideas SET done=? WHERE id=?", (1 if body.get("done") else 0, iid))
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


def api_ideas_delete(h, m, body, qs):
    iid = int(m.group(1))
    conn = get_conn()
    conn.execute("DELETE FROM ideas WHERE id=?", (iid,))
    conn.commit()
    conn.close()
    h.send_json({"ok": True})


def api_analytics(h, m, body, qs):
    conn = get_conn()
    today = datetime.now()
    y, mth = today.year, today.month
    months = []
    for i in range(5, -1, -1):
        mm, yy = mth - i, y
        while mm <= 0:
            mm += 12
            yy -= 1
        key = f"{yy:04d}-{mm:02d}"
        s = conn.execute("SELECT IFNULL(SUM(total),0), IFNULL(SUM(profit),0) FROM sales"
                         " WHERE substr(ts,1,7)=?", (key,)).fetchone()
        p = conn.execute("SELECT IFNULL(SUM(total),0) FROM purchases WHERE substr(ts,1,7)=?",
                         (key,)).fetchone()[0]
        months.append({"month": f"{mm}月", "sales": round(s[0], 2),
                       "profit": round(s[1], 2), "purchase": round(p, 2)})
    top = [dict(r) for r in conn.execute(
        "SELECT si.product_id, p.name, IFNULL(SUM(si.qty),0) AS qty,"
        " IFNULL(SUM(si.qty*si.unit_price),0) AS revenue"
        " FROM sale_items si JOIN products p ON p.id=si.product_id"
        " GROUP BY si.product_id ORDER BY revenue DESC LIMIT 8")]
    channels = [dict(r) for r in conn.execute(
        "SELECT channel, COUNT(*) AS n, IFNULL(SUM(total),0) AS amount,"
        " IFNULL(SUM(profit),0) AS profit FROM sales GROUP BY channel ORDER BY amount DESC")]
    q = conn.execute("SELECT IFNULL(SUM(done_qty),0), IFNULL(SUM(fail_qty),0),"
                     " IFNULL(SUM(hours),0) FROM print_jobs WHERE status='done'").fetchone()
    done, fail, hours = q[0], q[1], q[2]
    sales_total = sum(c["amount"] for c in channels)
    profit_total = sum(c["profit"] for c in channels)
    out = {
        "months": months,
        "top": top,
        "channels": channels,
        "sales_total": round(sales_total, 2),
        "profit_total": round(profit_total, 2),
        "margin": round(profit_total / sales_total * 100, 1) if sales_total else 0,
        "done_total": done,
        "fail_total": fail,
        "fail_rate": round(fail / (done + fail) * 100, 1) if done + fail else 0,
        "hours_total": round(hours, 1),
        "jobs_done": conn.execute("SELECT COUNT(*) FROM print_jobs WHERE status='done'").fetchone()[0],
    }
    conn.close()
    h.send_json(out)


# ---------------------------------------------------------------- API：流水日志 / 导出 / 备份

def api_logs_list(h, m, body, qs):
    conn = get_conn()
    sql = "SELECT * FROM operation_log"
    args = []
    if qs.get("module"):
        sql += " WHERE module=?"
        args.append(qs["module"])
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(min(int(fnum(qs.get("limit"), 200)), 500))
    items = [dict(r) for r in conn.execute(sql, args)]
    conn.close()
    h.send_json({"items": items})


EXPORTS = {
    "materials": ("materials", {"id": "编号", "name": "名称", "category": "类别", "brand": "品牌",
                                "spec": "规格", "unit": "单位", "total_g": "每卷克重", "unit_price": "单价",
                                "min_stock": "预警线", "note": "备注", "created_at": "创建时间"}),
    "purchases": ("purchases", {"id": "编号", "ts": "日期", "supplier": "供应商", "total": "金额",
                                "status": "状态", "note": "备注"}),
    "purchase_items": ("purchase_items", {"id": "编号", "purchase_id": "采购单", "material_id": "物料编号",
                                          "qty": "数量", "unit_price": "单价"}),
    "stock_movements": ("stock_movements", {"id": "编号", "ts": "时间", "material_id": "物料编号",
                                            "qty": "变动数量", "unit_cost": "单位成本", "ref_type": "关联类型",
                                            "ref_id": "关联单号", "note": "备注"}),
    "printers": ("printers", {"id": "编号", "name": "名称", "model": "型号", "power_w": "功率W",
                              "note": "备注", "created_at": "创建时间"}),
    "print_jobs": ("print_jobs", {"id": "编号", "ts": "时间", "title": "标题", "printer_id": "打印机",
                                  "planned_qty": "计划数量", "done_qty": "成品数", "fail_qty": "废件数",
                                  "hours": "耗时h", "status": "状态", "note": "备注"}),
    "products": ("products", {"id": "编号", "name": "名称", "stock": "库存", "cost": "成本",
                              "price": "售价", "note": "备注", "created_at": "创建时间"}),
    "sales": ("sales", {"id": "编号", "ts": "时间", "channel": "渠道", "buyer": "买家", "shipping": "运费",
                        "discount": "优惠", "total": "实收", "cost": "成本", "profit": "利润", "note": "备注"}),
    "sale_items": ("sale_items", {"id": "编号", "sale_id": "销售单", "product_id": "商品编号",
                                  "qty": "数量", "unit_price": "单价", "cost_snapshot": "成本快照"}),
    "model_links": ("model_links", {"id": "编号", "title": "名称", "url": "链接", "source": "来源",
                                    "tags": "标签", "status": "状态", "rating": "评分", "note": "备注",
                                    "created_at": "创建时间"}),
    "operation_log": ("operation_log", {"id": "编号", "ts": "时间", "module": "模块", "action": "动作",
                                        "detail": "详情"}),
}


def api_export_csv(h, m, body, qs):
    name = qs.get("table", "")
    if name not in EXPORTS:
        raise ApiError("不支持的导出表")
    table, headers = EXPORTS[name]
    conn = get_conn()
    rows = conn.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
    conn.close()
    buf = io.StringIO()
    buf.write("\ufeff")  # BOM，Excel 中文不乱码
    cols = list(headers.keys())
    writer = csv.writer(buf)
    writer.writerow([headers[c] for c in cols])
    for r in rows:
        writer.writerow(["" if r[c] is None else r[c] for c in cols])
    data = buf.getvalue().encode("utf-8")
    fname = f"{name}-{datetime.now():%Y%m%d-%H%M%S}.csv"
    h._send(200, "text/csv; charset=utf-8", data, filename=fname)


def api_backup(h, m, body, qs):
    tmp = DB_PATH + ".backup.tmp"
    src = get_conn()
    dst = sqlite3.connect(tmp)
    src.backup(dst)
    dst.close()
    src.close()
    with open(tmp, "rb") as f:
        data = f.read()
    os.remove(tmp)
    fname = f"print-studio-backup-{datetime.now():%Y%m%d-%H%M%S}.db"
    h._send(200, "application/octet-stream", data, filename=fname)


# ---------------------------------------------------------------- 路由表

ROUTES = [
    ("GET", r"^/api/stats$", api_stats),
    ("GET", r"^/api/analytics$", api_analytics),
    ("GET", r"^/api/settings$", api_settings_get),
    ("PUT", r"^/api/settings$", api_settings_put),
    ("GET", r"^/api/materials$", api_materials_list),
    ("POST", r"^/api/materials$", api_materials_create),
    ("PUT", r"^/api/materials/(\d+)$", api_materials_update),
    ("DELETE", r"^/api/materials/(\d+)$", api_materials_delete),
    ("POST", r"^/api/materials/(\d+)/movement$", api_materials_movement),
    ("GET", r"^/api/materials/(\d+)/movements$", api_movements_list),
    ("GET", r"^/api/purchases$", api_purchases_list),
    ("POST", r"^/api/purchases$", api_purchases_create),
    ("POST", r"^/api/purchases/(\d+)/confirm$", api_purchases_confirm),
    ("DELETE", r"^/api/purchases/(\d+)$", api_purchases_delete),
    ("GET", r"^/api/printers$", api_printers_list),
    ("POST", r"^/api/printers$", api_printers_create),
    ("PUT", r"^/api/printers/(\d+)$", api_printers_update),
    ("DELETE", r"^/api/printers/(\d+)$", api_printers_delete),
    ("GET", r"^/api/jobs$", api_jobs_list),
    ("POST", r"^/api/jobs$", api_jobs_create),
    ("POST", r"^/api/jobs/(\d+)/complete$", api_jobs_complete),
    ("POST", r"^/api/jobs/(\d+)/cancel$", api_jobs_cancel),
    ("DELETE", r"^/api/jobs/(\d+)$", api_jobs_delete),
    ("GET", r"^/api/products$", api_products_list),
    ("POST", r"^/api/products$", api_products_create),
    ("PUT", r"^/api/products/(\d+)$", api_products_update),
    ("DELETE", r"^/api/products/(\d+)$", api_products_delete),
    ("POST", r"^/api/products/(\d+)/movement$", api_products_movement),
    ("GET", r"^/api/sales$", api_sales_list),
    ("POST", r"^/api/sales$", api_sales_create),
    ("POST", r"^/api/sales/(\d+)/ship$", api_sales_ship),
    ("DELETE", r"^/api/sales/(\d+)$", api_sales_delete),
    ("GET", r"^/api/models$", api_models_list),
    ("POST", r"^/api/models$", api_models_create),
    ("PUT", r"^/api/models/(\d+)$", api_models_update),
    ("DELETE", r"^/api/models/(\d+)$", api_models_delete),
    ("POST", r"^/api/models/fetch-title$", api_models_fetch_title),
    ("GET", r"^/api/hot$", api_hot),
    ("GET", r"^/api/thumb$", api_thumb),
    ("POST", r"^/api/upload/image$", api_upload_image),
    ("GET", r"^/api/ideas$", api_ideas_list),
    ("POST", r"^/api/ideas$", api_ideas_create),
    ("PUT", r"^/api/ideas/(\d+)$", api_ideas_update),
    ("DELETE", r"^/api/ideas/(\d+)$", api_ideas_delete),
    ("GET", r"^/api/logs$", api_logs_list),
    ("GET", r"^/api/export/csv$", api_export_csv),
    ("GET", r"^/api/backup$", api_backup),
]

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
    ".ico": "image/x-icon", ".webp": "image/webp", ".json": "application/json; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "PrintStudio/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # 安静模式

    # ---- 发送辅助
    def _send(self, code, ctype, data, filename=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, code=200):
        self._send(code, "application/json; charset=utf-8",
                   json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > 16 * 1024 * 1024:
            # 直接断开连接：客户端还挂着 17MB 的包没发完，
            # 不掐掉的话残留字节会污染 keep-alive 的下一个请求
            self.close_connection = True
            raise ApiError("请求数据过大（超过 16MB）")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            raise ApiError("请求数据格式错误")

    def check_origin(self):
        """同源校验：拦截其它网站对本服务的跨站写请求（CSRF）"""
        origin = self.headers.get("Origin")
        host = self.headers.get("Host")
        if not host:
            self.send_json({"error": "缺少 Host 头，拒绝访问"}, 400)
            return False
        if origin:
            o_host = urlparse(origin).netloc
            if o_host and o_host != host:
                self.send_json({"error": "跨站请求被拒绝"}, 403)
                return False
        return True

    def serve_static(self, path):
        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/").replace("\\", "/")
        # 商品图片等上传文件
        if rel.startswith("uploads/"):
            full = os.path.normpath(os.path.join(UPLOAD_DIR, rel[len("uploads/"):]))
            if not full.startswith(os.path.abspath(UPLOAD_DIR)):
                self.send_json({"error": "非法路径"}, 403)
                return
            if not os.path.isfile(full):
                self.send_json({"error": "未找到文件"}, 404)
                return
            ext = os.path.splitext(full)[1].lower()
            with open(full, "rb") as f:
                data = f.read()
            self._send(200, CONTENT_TYPES.get(ext, "application/octet-stream"), data)
            return
        if rel.startswith("static/"):
            rel = rel[len("static/"):]
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(os.path.abspath(STATIC_DIR)):
            self.send_json({"error": "非法路径"}, 403)
            return
        if not os.path.isfile(full):
            # SPA 兜底
            full = os.path.join(STATIC_DIR, "index.html")
            if not os.path.isfile(full):
                self.send_json({"error": "未找到前端文件，请检查 static 目录"}, 404)
                return
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, ctype, data)

    # ---- 分发
    def dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        if path.startswith("/api"):
            body = {}
            if method in ("POST", "PUT", "DELETE"):
                try:
                    if not self.check_origin():
                        return
                    body = self.read_body()
                except ApiError as e:
                    self.send_json({"error": str(e)}, 400)
                    return
            for meth, pat, fn in ROUTES:
                if meth != method:
                    continue
                m = re.match(pat, path)
                if m:
                    try:
                        fn(self, m, body, qs)
                    except ApiError as e:
                        self.send_json({"error": str(e)}, 400)
                    except Exception:
                        traceback.print_exc()
                        self.send_json({"error": "服务器内部错误，请查看控制台"}, 500)
                    finally:
                        # 业务异常会以引用环形式拖延连接关闭，导致 SQLite 写锁
                        # 长时间不释放（表现为 database is locked），这里强制回收
                        gc.collect()
                    return
            self.send_json({"error": "接口不存在"}, 404)
        elif method == "GET":
            self.serve_static(path)
        else:
            self.send_json({"error": "不支持的方法"}, 405)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")


# ---------------------------------------------------------------- 启动

def auto_backup(keep=10):
    """每次启动自动做当日备份，保留最近 keep 份"""
    bdir = os.path.join(DATA_DIR, "backups")
    os.makedirs(bdir, exist_ok=True)
    path = os.path.join(bdir, f"print-studio-{datetime.now():%Y%m%d}.db")
    if not os.path.exists(path):
        try:
            src = get_conn()
            dst = sqlite3.connect(path)
            src.backup(dst)
            dst.close()
            src.close()
            print(f"[✓] 已自动备份到 {path}")
        except Exception as e:
            print(f"[!] 自动备份失败：{e}")
    files = sorted(glob.glob(os.path.join(bdir, "*.db")), key=os.path.getmtime)
    for old in files[:-keep]:
        try:
            os.remove(old)
        except OSError:
            pass


def lan_ips():
    ips = set()
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if not ip.startswith("127."):
                ips.add(ip)
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0)
        s.connect(("223.5.5.5", 80))  # 只取本机出口 IP，不真正发包
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return sorted(ips)


def main():
    port = DEFAULT_PORT
    args = [a for a in sys.argv[1:]]
    if args and args[0].isdigit():
        port = int(args[0])
        args = args[1:]
    open_browser = "--no-browser" not in args
    auto_backup()

    try:
        server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    except OSError:
        print(f"[!] 端口 {port} 已被占用——网站可能已经在运行了。")
        if open_browser:
            webbrowser.open(f"http://127.0.0.1:{port}")
        return

    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()

    print("=" * 52)
    print("  打印小站 · 3D 打印工作室管理网站")
    print("=" * 52)
    print(f"  本机访问:   http://127.0.0.1:{port}")
    for ip in lan_ips():
        print(f"  手机访问:   http://{ip}:{port}   （需同一 WiFi）")
    print(f"  数据文件:   {DB_PATH}")
    print("  关闭服务:   在本窗口按 Ctrl+C，或直接关闭窗口")
    print("  提示: 若手机无法访问，请在 Windows 防火墙中允许 Python。")
    print("  提醒: 本网站仅建议在局域网内使用，请勿暴露到公网。")
    print("=" * 52)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止服务，再见！")


if __name__ == "__main__":
    init_db()
    migrate()
    main()
