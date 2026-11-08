/* 打印小站 · 网页版本地后端
 * 在 GitHub Pages / 无服务器环境下，用 localStorage 完整实现网站的全部接口。
 * 数据保存在浏览器自身（换浏览器/清缓存前请先「导出数据」备份）。
 */
"use strict";

(function () {
  const KEY = "printstudio_web_v1";
  const now = () => {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const err = (msg, status = 400) => ({ __status__: status, error: msg });
  const ok = obj => (obj === undefined ? { __status__: 200 } : obj);
  const fnum = (v, d = 0) => { const f = parseFloat(v); return isNaN(f) ? d : f; };
  const round2 = n => Math.round(n * 100) / 100;

  const DEFAULT_SETTINGS = {
    shop_name: "打印小站", electricity_price: "0.6", machine_rate: "1.0",
    default_power: "120", loss_rate: "5", maintain_hours: "200",
  };

  function blank() {
    return {
      seq: {}, settings: { ...DEFAULT_SETTINGS },
      materials: [], stock_movements: [], purchases: [], purchase_items: [],
      printers: [], print_jobs: [], job_materials: [],
      products: [], sales: [], sale_items: [],
      model_links: [], ideas: [], operation_log: [],
    };
  }
  function seed(db) {
    const ts = now();
    const add = (t, row) => { db.seq[t] = (db.seq[t] || 0) + 1; row.id = db.seq[t]; db[t].push(row); return row.id; };
    add("materials", { name: "（示例）PLA 玛雅棕", category: "耗材", brand: "拓竹", spec: "1.75mm", unit: "克", total_g: 1000, unit_price: 0.02, min_stock: 200, note: "示例数据，可删除或编辑", archived: 0, created_at: ts });
    add("materials", { name: "（示例）PLA 曜石黑", category: "耗材", brand: "拓竹", spec: "1.75mm", unit: "克", total_g: 1000, unit_price: 0.019, min_stock: 200, note: "", archived: 0, created_at: ts });
    add("materials", { name: "（示例）0.4mm 喷嘴", category: "配件", brand: "拓竹", spec: "不锈钢", unit: "个", total_g: 0, unit_price: 3.5, min_stock: 2, note: "", archived: 0, created_at: ts });
    add("printers", { name: "（示例）A1 mini", model: "拓竹 A1 mini", power_w: 100, note: "示例数据，可删除", created_at: ts });
    add("model_links", { title: "（示例）关节龙", url: "https://makerworld.com/zh/models/123456", source: "MakerWorld", image_url: "", tags: "龙, articulated", status: "want", rating: 0, note: "示例数据，可删除", created_at: ts });
    add("products", { name: "（示例）可动关节龙", model_link_id: null, stock: 5, cost: 3.5, price: 19.9, weight_g: 0, img_url: "", xianyu_url: "", note: "示例数据，可删除", created_at: ts });
    db.operation_log.push({ id: ++db.seq.operation_log, ts, module: "系统", action: "初始化", detail: "网页版数据已创建（存于本浏览器）" });
    return db;
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    const db = seed(blank());
    save(db);
    return db;
  }
  function save(db) {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { throw err("浏览器存储空间不足：请清理旧图片或先导出数据", 500); }
  }
  function logOp(db, module, action, detail = "") {
    db.operation_log.push({ id: ++db.seq.operation_log, ts: now(), module, action, detail });
  }
  const nid = (db, t) => { db.seq[t] = (db.seq[t] || 0) + 1; return db.seq[t]; };

  function matStock(db, id) {
    return round2(db.stock_movements.filter(m => m.material_id === id).reduce((s, m) => s + m.qty, 0));
  }
  function matOut(db, db2, mid, grams, refType, refId, note) {
    db.stock_movements.push({ id: nid(db, "stock_movements"), material_id: mid, ts: now(), qty: -grams, unit_cost: 0, ref_type: refType, ref_id: refId, note: note || "" });
  }
  function getMat(db, id) {
    const m = db.materials.find(x => x.id === id);
    if (!m) throw err("物料不存在");
    return m;
  }
  function getProd(db, id) {
    const p = db.products.find(x => x.id === id);
    if (!p) throw err("商品不存在");
    return p;
  }
  function safeUrl(u, field = "链接") {
    u = (u || "").trim();
    if (!u) return "";
    if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("data:image/")) return u;
    throw err(`${field}需以 http(s):// 开头，或留空`);
  }
  function guessSource(url) {
    const u = url.toLowerCase();
    for (const [k, n] of [["makerworld", "MakerWorld"], ["printables", "Printables"], ["thingiverse", "Thingiverse"], ["cults3d", "Cults3D"], ["thangs", "Thangs"], ["myminifactory", "MyMiniFactory"]])
      if (u.includes(k)) return n;
    return "其它";
  }
  function matRow(db, m) {
    const stock = matStock(db, m.id);
    const r = { ...m, stock, low: !!m.min_stock && stock <= m.min_stock };
    r.spools = (m.category === "耗材" && m.total_g) ? round2(stock / m.total_g) : null;
    return r;
  }
  function jobRow(db, j) {
    const mats = db.job_materials.filter(x => x.job_id === j.id)
      .map(x => { const m = db.materials.find(y => y.id === x.material_id) || {}; return { material_id: x.material_id, grams: x.grams, name: m.name || "?", unit: m.unit || "", unit_price: m.unit_price || 0 }; });
    const printer = db.printers.find(p => p.id === j.printer_id);
    const model = db.model_links.find(m => m.id === j.model_link_id);
    return { ...j, materials: mats, cost: round2(mats.reduce((s, x) => s + x.grams * x.unit_price, 0)), printer_name: printer ? printer.name : null, model_title: model ? model.title : null };
  }

  // ---------------- 路由 ----------------
  const routes = [];
  const route = (method, re, fn) => routes.push({ method, re, fn });

  route("GET", /^\/api\/settings$/, (db) => ({ ...db.settings }));
  route("PUT", /^\/api\/settings$/, (db, m, body) => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in body) db.settings[k] = String(body[k]).trim();
    logOp(db, "设置", "修改", "更新了站点设置");
    return { ok: true, settings: { ...db.settings } };
  });

  route("GET", /^\/api\/materials$/, (db, m, body, qs) => {
    let items = db.materials.map(x => matRow(db, x));
    if (qs.all !== "1") items = items.filter(x => !x.archived);
    if (qs.q) { const q = qs.q.toLowerCase(); items = items.filter(x => (x.name + x.brand + x.spec).toLowerCase().includes(q)); }
    if (qs.category) items = items.filter(x => x.category === qs.category);
    items.sort((a, b) => (a.archived - b.archived) || (b.id - a.id));
    return { items };
  });
  route("POST", /^\/api\/materials$/, (db, m, body) => {
    const name = (body.name || "").trim();
    if (!name) throw err("请填写物料名称");
    const category = body.category || "其它";
    const row = {
      name, category, brand: (body.brand || "").trim(), spec: (body.spec || "").trim(),
      unit: category === "耗材" ? "克" : ((body.unit || "个").trim() || "个"),
      total_g: Math.max(fnum(body.total_g), 0), unit_price: Math.max(fnum(body.unit_price), 0),
      min_stock: Math.max(fnum(body.min_stock), 0), note: (body.note || "").trim(), archived: 0, created_at: now(),
    };
    row.id = nid(db, "materials");
    db.materials.push(row);
    logOp(db, "物料", "新增", `新增物料「${name}」`);
    return { item: matRow(db, row) };
  });
  route("PUT", /^\/api\/materials\/(\d+)$/, (db, m, body) => {
    const row = getMat(db, +m[1]);
    const name = (body.name || "").trim();
    if (!name) throw err("请填写物料名称");
    const category = body.category || row.category;
    Object.assign(row, {
      name, category, brand: (body.brand || "").trim(), spec: (body.spec || "").trim(),
      unit: category === "耗材" ? "克" : ((body.unit || "个").trim() || "个"),
      total_g: Math.max(fnum(body.total_g), 0), unit_price: Math.max(fnum(body.unit_price), 0),
      min_stock: Math.max(fnum(body.min_stock), 0), note: (body.note || "").trim(),
    });
    if ("archived" in body) row.archived = body.archived ? 1 : 0;
    logOp(db, "物料", "修改", `修改物料「${name}」`);
    return { item: matRow(db, row) };
  });
  route("DELETE", /^\/api\/materials\/(\d+)$/, (db, m) => {
    const row = getMat(db, +m[1]);
    if (db.stock_movements.some(x => x.material_id === row.id)) throw err("该物料已有出入库记录，不能删除；可改为停用");
    db.materials = db.materials.filter(x => x.id !== row.id);
    logOp(db, "物料", "删除", `删除物料「${row.name}」`);
    return ok();
  });
  route("POST", /^\/api\/materials\/(\d+)\/movement$/, (db, m, body) => {
    const row = getMat(db, +m[1]);
    const typ = body.type, qty = fnum(body.qty);
    const stock = matStock(db, row.id);
    let delta = 0;
    if (typ === "in") { if (qty <= 0) throw err("入库数量需大于 0"); delta = qty; }
    else if (typ === "out") {
      if (qty <= 0) throw err("出库数量需大于 0");
      if (qty > stock + 1e-9) throw err(`库存不足（当前 ${stock} ${row.unit}），可先用「盘点」修正`);
      delta = -qty;
    } else if (typ === "adjust") { delta = qty - stock; }
    else throw err("无效的出入库类型");
    if (Math.abs(delta) > 1e-9)
      db.stock_movements.push({ id: nid(db, "stock_movements"), material_id: row.id, ts: now(), qty: delta, unit_cost: row.unit_price, ref_type: "manual", ref_id: null, note: (body.note || "").trim() || (typ === "adjust" ? `盘点调整为 ${qty}` : "") });
    const label = { in: "入库", out: "出库", adjust: "盘点" }[typ];
    logOp(db, "物料", label, `「${row.name}」${label} ${Math.abs(delta)} ${row.unit}`);
    return { item: matRow(db, row) };
  });
  route("GET", /^\/api\/materials\/(\d+)\/movements$/, (db, m) => {
    const items = db.stock_movements.filter(x => x.material_id === +m[1]).slice().reverse()
      .map(x => { const mm = db.materials.find(y => y.id === x.material_id) || {}; return { ...x, material_name: mm.name, unit: mm.unit }; }).slice(0, 200);
    return { items };
  });

  route("GET", /^\/api\/purchases$/, (db) => {
    const items = db.purchases.slice().reverse().slice(0, 200).map(p => ({
      ...p,
      items: db.purchase_items.filter(x => x.purchase_id === p.id).map(x => {
        const mm = db.materials.find(y => y.id === x.material_id) || {};
        return { ...x, material_name: mm.name || "?", unit: mm.unit || "", total_g: mm.total_g || 0 };
      }),
    }));
    return { items };
  });
  route("POST", /^\/api\/purchases$/, (db, m, body) => {
    const rows = body.items || [];
    if (!rows.length) throw err("请至少添加一条采购明细");
    const pid = nid(db, "purchases");
    let total = 0; const detail = [];
    for (const r of rows) {
      const mat = getMat(db, +r.material_id);
      const qty = fnum(r.qty), price = fnum(r.unit_price);
      if (qty <= 0) throw err(`「${mat.name}」数量需大于 0`);
      if (price < 0) throw err(`「${mat.name}」单价不能为负`);
      total += qty * price;
      db.purchase_items.push({ id: nid(db, "purchase_items"), purchase_id: pid, material_id: mat.id, qty, unit_price: price });
      detail.push(`${mat.name}×${qty}${mat.unit}`);
    }
    const p = { id: pid, ts: now(), supplier: (body.supplier || "").trim() || "未填供应商", total: round2(total), status: "pending", note: (body.note || "").trim() };
    db.purchases.push(p);
    logOp(db, "采购", "新增", `采购单#${pid}（${p.supplier}）：${detail.join("，")}，合计 ¥${p.total.toFixed(2)}`);
    return { ok: true, id: pid };
  });
  route("POST", /^\/api\/purchases\/(\d+)\/confirm$/, (db, m) => {
    const p = db.purchases.find(x => x.id === +m[1]);
    if (!p) throw err("采购单不存在");
    if (p.status !== "pending") throw err("该采购单已入库");
    for (const it of db.purchase_items.filter(x => x.purchase_id === p.id)) {
      db.stock_movements.push({ id: nid(db, "stock_movements"), material_id: it.material_id, ts: now(), qty: it.qty, unit_cost: it.unit_price, ref_type: "purchase", ref_id: p.id, note: `采购单#${p.id}` });
      if (it.unit_price > 0) getMat(db, it.material_id).unit_price = it.unit_price;
    }
    p.status = "done";
    logOp(db, "采购", "确认入库", `采购单#${p.id}（${p.supplier}）已入库，金额 ¥${p.total.toFixed(2)}`);
    return ok();
  });
  route("DELETE", /^\/api\/purchases\/(\d+)$/, (db, m) => {
    const p = db.purchases.find(x => x.id === +m[1]);
    if (!p) throw err("采购单不存在");
    if (p.status !== "pending") throw err("已入库的采购单不能删除（涉及库存流水）");
    db.purchase_items = db.purchase_items.filter(x => x.purchase_id !== p.id);
    db.purchases = db.purchases.filter(x => x.id !== p.id);
    logOp(db, "采购", "删除", `删除采购单#${p.id}（${p.supplier}）`);
    return ok();
  });

  route("GET", /^\/api\/printers$/, (db) => ({
    items: db.printers.slice().reverse().map(p => ({ ...p, total_hours: round2(db.print_jobs.filter(j => j.printer_id === p.id && j.status === "done").reduce((s, j) => s + j.hours, 0)) })),
  }));
  route("POST", /^\/api\/printers$/, (db, m, body) => {
    const name = (body.name || "").trim();
    if (!name) throw err("请填写打印机名称");
    const row = { id: nid(db, "printers"), name, model: (body.model || "").trim(), power_w: Math.max(fnum(body.power_w, 120), 0), note: (body.note || "").trim(), created_at: now() };
    db.printers.push(row);
    logOp(db, "打印", "新增打印机", name);
    return { item: row };
  });
  route("PUT", /^\/api\/printers\/(\d+)$/, (db, m, body) => {
    const row = db.printers.find(x => x.id === +m[1]);
    if (!row) throw err("打印机不存在");
    const name = (body.name || "").trim();
    if (!name) throw err("请填写打印机名称");
    Object.assign(row, { name, model: (body.model || "").trim(), power_w: Math.max(fnum(body.power_w, 120), 0), note: (body.note || "").trim() });
    logOp(db, "打印", "修改打印机", name);
    return { item: row };
  });
  route("DELETE", /^\/api\/printers\/(\d+)$/, (db, m) => {
    const id = +m[1];
    if (db.print_jobs.some(j => j.printer_id === id)) throw err("该打印机已有打印任务记录，不能删除");
    db.printers = db.printers.filter(x => x.id !== id);
    logOp(db, "打印", "删除打印机", `#${id}`);
    return ok();
  });

  route("GET", /^\/api\/jobs$/, (db) => {
    const order = { printing: 0, done: 1, canceled: 2 };
    const items = db.print_jobs.slice().sort((a, b) => (order[a.status] - order[b.status]) || (b.id - a.id)).slice(0, 200).map(j => jobRow(db, j));
    return { items };
  });
  route("POST", /^\/api\/jobs$/, (db, m, body) => {
    const title = (body.title || "").trim();
    if (!title) throw err("请填写任务标题（打印什么模型）");
    const row = {
      id: nid(db, "print_jobs"), ts: now(), title,
      printer_id: body.printer_id ? +body.printer_id : null,
      model_link_id: body.model_link_id ? +body.model_link_id : null,
      planned_qty: Math.max(parseInt(fnum(body.planned_qty, 1)), 1),
      done_qty: 0, fail_qty: 0, hours: 0, status: "printing", note: (body.note || "").trim(),
    };
    db.print_jobs.push(row);
    const gtxt = [];
    for (const r of (body.materials || [])) {
      const mid = +r.material_id, grams = fnum(r.grams);
      if (mid && grams > 0) { getMat(db, mid); db.job_materials.push({ id: nid(db, "job_materials"), job_id: row.id, material_id: mid, grams }); gtxt.push(`${getMat(db, mid).name} ${grams}g`); }
    }
    logOp(db, "打印", "新增任务", `「${title}」×${row.planned_qty}${gtxt.length ? "（" + gtxt.join("，") + "）" : ""}`);
    return { item: jobRow(db, row) };
  });
  route("POST", /^\/api\/jobs\/(\d+)\/complete$/, (db, m, body) => {
    const j = db.print_jobs.find(x => x.id === +m[1]);
    if (!j) throw err("任务不存在");
    if (j.status !== "printing") throw err("该任务已结束");
    const done = parseInt(fnum(body.done_qty)), fail = parseInt(fnum(body.fail_qty)), hours = fnum(body.hours);
    if (done < 0 || fail < 0) throw err("成品/废件数量不能为负");
    if (done + fail === 0) throw err("成品数与废件数不能同时为 0");
    const jm = db.job_materials.filter(x => x.job_id === j.id);
    for (const x of jm) {
      const mat = getMat(db, x.material_id);
      if (x.grams > matStock(db, x.material_id) + 1e-9)
        throw err(`材料「${mat.name}」库存不足（剩 ${matStock(db, x.material_id)}${mat.unit}，需 ${x.grams}g），可先采购入库或盘点`);
    }
    let costTotal = 0;
    for (const x of jm) {
      const mat = getMat(db, x.material_id);
      db.stock_movements.push({ id: nid(db, "stock_movements"), material_id: x.material_id, ts: now(), qty: -x.grams, unit_cost: mat.unit_price, ref_type: "print", ref_id: j.id, note: `打印任务「${j.title}」` });
      costTotal += x.grams * mat.unit_price;
    }
    const perCost = done > 0 ? costTotal / done : 0;
    if (body.create_product !== false && done > 0) {
      const pname = (body.product_name || "").trim() || j.title;
      let p = db.products.find(x => x.name === pname);
      if (p) { p.stock = round2(p.stock + done); p.cost = round2(perCost); }
      else { p = { id: nid(db, "products"), name: pname, model_link_id: j.model_link_id, stock: done, cost: round2(perCost), price: Math.max(fnum(body.product_price), 0), weight_g: 0, img_url: "", xianyu_url: "", note: "", created_at: now() }; db.products.push(p); }
      logOp(db, "成品", "入库", `「${pname}」×${done}（单件成本 ¥${perCost.toFixed(2)}）`);
    }
    Object.assign(j, { status: "done", done_qty: done, fail_qty: fail, hours });
    logOp(db, "打印", "完成任务", `「${j.title}」成品 ${done} / 废件 ${fail}，耗时 ${hours}h，材料成本 ¥${costTotal.toFixed(2)}`);
    return { item: jobRow(db, j) };
  });
  route("POST", /^\/api\/jobs\/(\d+)\/cancel$/, (db, m) => {
    const j = db.print_jobs.find(x => x.id === +m[1]);
    if (!j) throw err("任务不存在");
    if (j.status !== "printing") throw err("该任务已结束");
    j.status = "canceled";
    logOp(db, "打印", "取消任务", `「${j.title}」`);
    return ok();
  });
  route("DELETE", /^\/api\/jobs\/(\d+)$/, (db, m) => {
    const j = db.print_jobs.find(x => x.id === +m[1]);
    if (!j) throw err("任务不存在");
    if (j.status === "done") throw err("已完成的任务涉及库存流水，不能删除");
    db.job_materials = db.job_materials.filter(x => x.job_id !== j.id);
    db.print_jobs = db.print_jobs.filter(x => x.id !== j.id);
    logOp(db, "打印", "删除任务", `「${j.title}」`);
    return ok();
  });

  route("GET", /^\/api\/products$/, (db) => ({ items: db.products.slice().reverse() }));
  route("POST", /^\/api\/products$/, (db, m, body) => {
    const name = (body.name || "").trim();
    if (!name) throw err("请填写商品名称");
    const row = { id: nid(db, "products"), name, model_link_id: body.model_link_id ? +body.model_link_id : null, stock: fnum(body.stock), cost: Math.max(fnum(body.cost), 0), price: Math.max(fnum(body.price), 0), weight_g: Math.max(fnum(body.weight_g), 0), img_url: safeUrl(body.img_url, "图片链接"), xianyu_url: safeUrl(body.xianyu_url, "闲鱼链接"), note: (body.note || "").trim(), created_at: now() };
    db.products.push(row);
    logOp(db, "成品", "新增", `「${name}」`);
    return { item: row };
  });
  route("PUT", /^\/api\/products\/(\d+)$/, (db, m, body) => {
    const row = getProd(db, +m[1]);
    const name = (body.name || "").trim();
    if (!name) throw err("请填写商品名称");
    Object.assign(row, { name, cost: Math.max(fnum(body.cost), 0), price: Math.max(fnum(body.price), 0), weight_g: Math.max(fnum(body.weight_g), 0), img_url: safeUrl(body.img_url, "图片链接"), xianyu_url: safeUrl(body.xianyu_url, "闲鱼链接"), note: (body.note || "").trim() });
    if (body.model_link_id) row.model_link_id = +body.model_link_id;
    logOp(db, "成品", "修改", `「${name}」`);
    return { item: row };
  });
  route("DELETE", /^\/api\/products\/(\d+)$/, (db, m) => {
    const id = +m[1];
    if (db.sale_items.some(x => x.product_id === id)) throw err("该商品已有销售记录，不能删除");
    const p = getProd(db, id);
    db.products = db.products.filter(x => x.id !== id);
    logOp(db, "成品", "删除", `「${p.name}」`);
    return ok();
  });
  route("POST", /^\/api\/products\/(\d+)\/movement$/, (db, m, body) => {
    const p = getProd(db, +m[1]);
    const typ = body.type, qty = fnum(body.qty);
    if (typ === "in") { if (qty <= 0) throw err("入库数量需大于 0"); p.stock = round2(p.stock + qty); }
    else if (typ === "out") {
      if (qty <= 0) throw err("出库数量需大于 0");
      if (qty > p.stock + 1e-9) throw err(`库存不足（剩 ${p.stock} 件）`);
      p.stock = round2(p.stock - qty);
    } else if (typ === "adjust") { p.stock = qty; }
    else throw err("无效的出入库类型");
    logOp(db, "成品", { in: "入库", out: "出库", adjust: "盘点" }[typ], `「${p.name}」${typ === "adjust" ? `调整为 ${qty}` : Math.abs(qty)}${(body.note || "").trim()}`);
    return { item: p };
  });

  route("GET", /^\/api\/sales$/, (db) => {
    const items = db.sales.slice().reverse().slice(0, 200).map(s => ({
      ...s,
      items: db.sale_items.filter(x => x.sale_id === s.id).map(x => { const p = db.products.find(y => y.id === x.product_id) || {}; return { ...x, name: p.name || "?" }; }),
    }));
    return { items };
  });
  route("POST", /^\/api\/sales$/, (db, m, body) => {
    const rows = body.items || [];
    if (!rows.length) throw err("请至少添加一个商品");
    const prepared = [], oversold = [];
    for (const r of rows) {
      const p = getProd(db, +r.product_id);
      const qty = fnum(r.qty);
      if (qty <= 0) throw err(`「${p.name}」数量需大于 0`);
      if (qty > p.stock + 1e-9) {
        if (!body.allow_backorder) throw err(`商品「${p.name}」库存不足（剩 ${p.stock} 件）——可点「按预售接单」先记录，打印入库后自动冲销欠货`);
        oversold.push(`${p.name} 欠 ${round2(qty - p.stock)} 件`);
      }
      prepared.push([p, qty, Math.max(fnum(r.unit_price, p.price), 0)]);
    }
    const shipping = Math.max(fnum(body.shipping), 0);
    const itemsSum = prepared.reduce((s, [, q, pr]) => s + q * pr, 0);
    const discount = Math.min(Math.max(fnum(body.discount), 0), itemsSum + shipping);
    const total = round2(itemsSum + shipping - discount);
    const cost = round2(prepared.reduce((s, [p, q]) => s + q * p.cost, 0));
    const profit = round2(total - cost);
    const sid = nid(db, "sales");
    db.sales.push({ id: sid, ts: now(), channel: (body.channel || "闲鱼").trim(), buyer: (body.buyer || "").trim(), shipping, discount, total, cost, profit, note: (body.note || "").trim(), ship_status: "pending", tracking_no: "" });
    const detail = [];
    for (const [p, qty, price] of prepared) {
      db.sale_items.push({ id: nid(db, "sale_items"), sale_id: sid, product_id: p.id, qty, unit_price: price, cost_snapshot: p.cost });
      p.stock = round2(p.stock - qty);
      detail.push(`${p.name}×${qty}`);
    }
    if (oversold.length) detail.push("（预售：" + oversold.join("，") + "）");
    logOp(db, "销售", "新增", `[${body.channel || "闲鱼"}] ${detail.join("，")}，实收 ¥${total.toFixed(2)}，利润 ¥${profit.toFixed(2)}`);
    return { ok: true, id: sid, profit };
  });
  route("POST", /^\/api\/sales\/(\d+)\/ship$/, (db, m, body) => {
    const s = db.sales.find(x => x.id === +m[1]);
    if (!s) throw err("销售记录不存在");
    s.ship_status = body.ship_status === "pending" ? "pending" : "shipped";
    s.tracking_no = (body.tracking_no || "").trim();
    logOp(db, "销售", s.ship_status === "shipped" ? "已发货" : "标记待发货", `#${s.id} [${s.channel}] ${s.tracking_no || "（未填单号）"}`);
    return { item: s };
  });
  route("DELETE", /^\/api\/sales\/(\d+)$/, (db, m) => {
    const sid = +m[1];
    const s = db.sales.find(x => x.id === sid);
    if (!s) throw err("销售记录不存在");
    for (const it of db.sale_items.filter(x => x.sale_id === sid)) getProd(db, it.product_id).stock = round2(getProd(db, it.product_id).stock + it.qty);
    db.sale_items = db.sale_items.filter(x => x.sale_id !== sid);
    db.sales = db.sales.filter(x => x.id !== sid);
    logOp(db, "销售", "删除", `删除销售记录#${sid}（已返还成品库存）`);
    return ok();
  });

  route("GET", /^\/api\/models$/, (db, m, body, qs) => {
    let items = db.model_links.slice().reverse().slice(0, 500);
    if (qs.status) items = items.filter(x => x.status === qs.status);
    if (qs.q) { const q = qs.q.toLowerCase(); items = items.filter(x => (x.title + x.tags + x.url).toLowerCase().includes(q)); }
    const L = { want: "想打", printing: "打印中", listed: "已上架", dropped: "放弃" };
    return { items: items.map(x => ({ ...x, status_label: L[x.status] || x.status })) };
  });
  route("POST", /^\/api\/models$/, (db, m, body) => {
    const title = (body.title || "").trim(), url = (body.url || "").trim();
    if (!title) throw err("请填写模型名称");
    if (!url.startsWith("http://") && !url.startsWith("https://")) throw err("链接需以 http(s):// 开头");
    const row = { id: nid(db, "model_links"), title, url, source: (body.source || "").trim() || guessSource(url), image_url: safeUrl(body.image_url, "图片链接"), tags: (body.tags || "").trim(), status: ["want", "printing", "listed", "dropped"].includes(body.status) ? body.status : "want", rating: Math.max(0, Math.min(5, parseInt(fnum(body.rating)))), note: (body.note || "").trim(), created_at: now() };
    db.model_links.push(row);
    logOp(db, "模型", "收藏", `「${title}」（${row.source}）`);
    return { item: row };
  });
  route("PUT", /^\/api\/models\/(\d+)$/, (db, m, body) => {
    const row = db.model_links.find(x => x.id === +m[1]);
    if (!row) throw err("收藏不存在");
    const title = (body.title || "").trim(), url = (body.url || "").trim();
    if (!title) throw err("请填写模型名称");
    if (!url.startsWith("http://") && !url.startsWith("https://")) throw err("链接需以 http(s):// 开头");
    Object.assign(row, { title, url, source: (body.source || "").trim() || row.source, image_url: safeUrl(body.image_url, "图片链接"), tags: (body.tags || "").trim(), status: ["want", "printing", "listed", "dropped"].includes(body.status) ? body.status : row.status, rating: Math.max(0, Math.min(5, parseInt(fnum(body.rating)))), note: (body.note || "").trim() });
    logOp(db, "模型", "修改", `「${title}」`);
    return { item: row };
  });
  route("DELETE", /^\/api\/models\/(\d+)$/, (db, m) => {
    const row = db.model_links.find(x => x.id === +m[1]);
    if (!row) throw err("收藏不存在");
    db.model_links = db.model_links.filter(x => x.id !== row.id);
    logOp(db, "模型", "删除", `「${row.title}」`);
    return ok();
  });
  route("POST", /^\/api\/models\/fetch-title$/, () => ({ title: null, image: null }));

  route("GET", /^\/api\/ideas$/, (db) => ({ items: db.ideas.slice().sort((a, b) => a.done - b.done || b.id - a.id).slice(0, 100) }));
  route("POST", /^\/api\/ideas$/, (db, m, body) => {
    const content = (body.content || "").trim();
    if (!content) throw err("请填写点子内容");
    db.ideas.push({ id: nid(db, "ideas"), content, done: 0, created_at: now() });
    logOp(db, "点子", "新增", content.slice(0, 50));
    return ok();
  });
  route("PUT", /^\/api\/ideas\/(\d+)$/, (db, m, body) => {
    const row = db.ideas.find(x => x.id === +m[1]);
    if (row) row.done = body.done ? 1 : 0;
    return ok();
  });
  route("DELETE", /^\/api\/ideas\/(\d+)$/, (db, m) => {
    db.ideas = db.ideas.filter(x => x.id !== +m[1]);
    return ok();
  });

  route("GET", /^\/api\/logs$/, (db, m, body, qs) => {
    let items = db.operation_log.slice().reverse();
    if (qs.module) items = items.filter(x => x.module === qs.module);
    return { items: items.slice(0, Math.min(parseInt(fnum(qs.limit, 200)), 500)) };
  });

  route("GET", /^\/api\/stats$/, (db) => {
    const month = now().slice(0, 7);
    const mats = db.materials.filter(x => !x.archived).map(x => matRow(db, x));
    const recentSales = db.sales.filter(s => s.ts.slice(0, 7) === month);
    const daily = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const p = n => String(n).padStart(2, "0");
      const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      daily.push({ date: day.slice(5), total: round2(db.sales.filter(s => s.ts.slice(0, 10) === day).reduce((s, x) => s + x.total, 0)) });
    }
    return {
      shop_name: db.settings.shop_name,
      month_purchase: round2(db.purchases.filter(p => p.ts.slice(0, 7) === month).reduce((s, p) => s + p.total, 0)),
      month_sales: round2(recentSales.reduce((s, x) => s + x.total, 0)),
      month_profit: round2(recentSales.reduce((s, x) => s + x.profit, 0)),
      material_value: round2(mats.reduce((s, x) => s + x.stock * x.unit_price, 0)),
      product_value: round2(db.products.reduce((s, x) => s + x.stock * x.cost, 0)),
      low_stock: mats.filter(x => x.low),
      backorders: db.products.filter(x => x.stock < 0).map(x => ({ id: x.id, name: x.name, stock: x.stock })),
      pending_ship: db.sales.filter(s => s.ship_status === "pending").length,
      maintain_hours: fnum(db.settings.maintain_hours, 200),
      printer_hours: db.printers.map(p => ({ id: p.id, name: p.name, hours: round2(db.print_jobs.filter(j => j.printer_id === p.id && j.status === "done").reduce((s, j) => s + j.hours, 0)) })).sort((a, b) => b.hours - a.hours),
      want_count: db.model_links.filter(x => x.status === "want").length,
      printing_count: db.print_jobs.filter(x => x.status === "printing").length,
      daily, recent: db.operation_log.slice(-8).reverse(),
    };
  });

  route("GET", /^\/api\/analytics$/, (db) => {
    const t = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const sm = db.sales.filter(s => s.ts.slice(0, 7) === key);
      months.push({ month: `${d.getMonth() + 1}月`, sales: round2(sm.reduce((s, x) => s + x.total, 0)), profit: round2(sm.reduce((s, x) => s + x.profit, 0)), purchase: round2(db.purchases.filter(p => p.ts.slice(0, 7) === key).reduce((s, p) => s + p.total, 0)) });
    }
    const byProduct = {};
    for (const it of db.sale_items) {
      const p = db.products.find(x => x.id === it.product_id);
      const k = it.product_id;
      byProduct[k] = byProduct[k] || { product_id: k, name: p ? p.name : "?", qty: 0, revenue: 0 };
      byProduct[k].qty += it.qty; byProduct[k].revenue += it.qty * it.unit_price;
    }
    const byChannel = {};
    for (const s of db.sales) {
      byChannel[s.channel] = byChannel[s.channel] || { channel: s.channel, n: 0, amount: 0, profit: 0 };
      byChannel[s.channel].n++; byChannel[s.channel].amount += s.total; byChannel[s.channel].profit += s.profit;
    }
    const doneJobs = db.print_jobs.filter(j => j.status === "done");
    const done = doneJobs.reduce((s, j) => s + j.done_qty, 0), fail = doneJobs.reduce((s, j) => s + j.fail_qty, 0);
    const sales_total = round2(db.sales.reduce((s, x) => s + x.total, 0));
    const profit_total = round2(db.sales.reduce((s, x) => s + x.profit, 0));
    return {
      months, top: Object.values(byProduct).sort((a, b) => b.revenue - a.revenue).slice(0, 8).map(x => ({ ...x, qty: round2(x.qty), revenue: round2(x.revenue) })),
      channels: Object.values(byChannel).map(x => ({ ...x, amount: round2(x.amount), profit: round2(x.profit) })).sort((a, b) => b.amount - a.amount),
      sales_total, profit_total, margin: sales_total ? round2(profit_total / sales_total * 100 * 10) / 10 : 0,
      done_total: done, fail_total: fail, fail_rate: done + fail ? Math.round(fail / (done + fail) * 1000) / 10 : 0,
      hours_total: round2(doneJobs.reduce((s, j) => s + j.hours, 0)), jobs_done: doneJobs.length,
    };
  });

  route("POST", /^\/api\/upload\/image$/, (db, m, body) => {
    const data = body.data || "";
    if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(data)) throw err("仅支持粘贴/选择图片");
    if (data.length > 2 * 1024 * 1024) throw err("图片太大（网页版上限约 1.5MB），请裁剪或压缩后再试");
    return { url: data };
  });

  route("GET", /^\/api\/hot$/, async (db, m, body, qs) => {
    const kw = (qs.q || "").trim();
    const ordering = ["popular", "latest", "rating", "makes_count", "best_match"].includes(qs.ordering) ? qs.ordering : (kw ? "best_match" : "popular");
    const payload = {
      query: `query SearchModels($query: String!, $limit: Int, $ordering: SearchChoicesEnum) { result: searchPrints2(query: $query, printType: print, limit: $limit, ordering: $ordering) { items { ...Model __typename } } } fragment AvatarUser on UserType { id handle publicUsername __typename } fragment Model on PrintType { id name slug ratingAvg likesCount downloadCount datePublished user { ...AvatarUser __typename } image { filePath } __typename }`,
      operationName: "SearchModels", variables: { query: kw, limit: Math.min(Math.max(parseInt(fnum(qs.limit, 12)), 1), 24), ordering },
    };
    try {
      const resp = await fetch("https://api.printables.com/graphql/", {
        method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      const items = (((data.data || {}).result || {}).items || []).map(it => {
        const fp = ((it.image || {}).filePath || "").replace(/^\//, "");
        return { id: it.id, name: it.name || "未命名", author: (it.user || {}).publicUsername || "", likes: it.likesCount || 0, downloads: it.downloadCount || 0, image: fp ? "https://media.printables.com/" + fp : "", url: `https://www.printables.com/model/${it.id}-${it.slug || ""}`.replace(/-$/, "") };
      });
      return { items };
    } catch (e) {
      return { items: [], error: "浏览器直连 Printables 失败（可能被墙或跨域限制）。请用上方「逛热门」按钮直接打开网页浏览。" };
    }
  });

  // ---------------- 导出 / 备份 ----------------
  function toCSV(db, table) {
    const H = {
      materials: ["id", "name", "category", "brand", "spec", "unit", "total_g", "unit_price", "min_stock", "note", "created_at"],
      purchases: ["id", "ts", "supplier", "total", "status", "note"],
      purchase_items: ["id", "purchase_id", "material_id", "qty", "unit_price"],
      stock_movements: ["id", "ts", "material_id", "qty", "unit_cost", "ref_type", "ref_id", "note"],
      printers: ["id", "name", "model", "power_w", "note", "created_at"],
      print_jobs: ["id", "ts", "title", "printer_id", "planned_qty", "done_qty", "fail_qty", "hours", "status", "note"],
      job_materials: ["id", "job_id", "material_id", "grams"],
      products: ["id", "name", "stock", "cost", "price", "weight_g", "img_url", "xianyu_url", "note", "created_at"],
      sales: ["id", "ts", "channel", "buyer", "shipping", "discount", "total", "cost", "profit", "ship_status", "tracking_no", "note"],
      sale_items: ["id", "sale_id", "product_id", "qty", "unit_price", "cost_snapshot"],
      model_links: ["id", "title", "url", "source", "tags", "status", "rating", "note", "created_at"],
      operation_log: ["id", "ts", "module", "action", "detail"],
      ideas: ["id", "content", "done", "created_at"],
    };
    const cols = H[table];
    if (!cols) throw err("不支持的导出表");
    const esc = v => { v = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [cols.join(",")];
    for (const row of db[table]) lines.push(cols.map(c => esc(row[c])).join(","));
    return "\ufeff" + lines.join("\r\n");
  }
  function download(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  const stamp = () => now().replace(/[-: ]/g, "").slice(0, 14);

  // ---------------- 入口 ----------------
  const LocalAPI = {
    isLocal: true,
    exportCSV(table) {
      const db = load();
      download(`${table}-${stamp()}.csv`, toCSV(db, table), "text/csv;charset=utf-8");
    },
    backup() {
      const db = load();
      download(`print-studio-web-backup-${stamp()}.json`, JSON.stringify(db), "application/json");
      logOp(db, "系统", "导出备份", "网页版数据已导出");
      save(db);
    },
    importJSON(text) {
      const data = JSON.parse(text);
      if (!data || !data.materials || !data.settings) throw err("文件格式不对，请选择本站导出的 JSON 备份");
      save(data);
      location.reload();
    },
    async handle(method, path, body) {
      const db = load();
      let mutated = false;
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = path.match(r.re);
        if (!m) continue;
        try {
          const qs = {};
          const qi = path.indexOf("?");
          if (qi >= 0) for (const [k, v] of new URLSearchParams(path.slice(qi + 1))) qs[k] = v;
          const out = await r.fn(db, m, body || {}, qs);
          mutated = true;
          save(db);
          return out === undefined ? { __status__: 200 } : out;
        } catch (e) {
          if (e && e.__status__) return e;           // 业务错误
          console.error(e);
          return err("网页版内部错误：" + e.message, 500);
        }
      }
      return err("接口不存在（网页版）", 404);
    },
  };
  window.LocalAPI = LocalAPI;
})();
