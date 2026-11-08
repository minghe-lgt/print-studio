/* 打印小站 · 前端逻辑（原生 JS，无框架、无外部依赖） */
"use strict";

/* ================= 工具 ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => "¥" + (Math.round((+n || 0) * 100) / 100).toFixed(2);
const num = n => {
  const v = +n || 0;
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
};

/* 运行模式：true = 网页版（数据存浏览器）；false = 本机服务器版 */
let LOCAL_MODE = false;

async function api(path, method = "GET", body) {
  if (LOCAL_MODE && window.LocalAPI) {
    const r = await window.LocalAPI.handle(method, path, body);
    if (r && r.__status__ >= 400) throw new Error(r.error || `请求失败（${r.__status__}）`);
    return r;
  }
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

async function detectLocalMode() {
  if (location.protocol === "file:") return true;
  if (location.hostname.endsWith(".github.io")) return true;
  if (location.search.includes("local=1")) return true;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch("/api/settings", { signal: c.signal });
    clearTimeout(t);
    return !r.ok;
  } catch (e) { return true; }
}

function toast(msg, ok = true) {
  const root = $("#toast-root");
  const t = document.createElement("div");
  t.className = "toast" + (ok ? "" : " err");
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .4s"; }, 2200);
  setTimeout(() => t.remove(), 2700);
}

function openModal({ title, body, footer = "" }) {
  const root = $("#modal-root");
  const wrap = document.createElement("div");
  wrap.className = "overlay";
  wrap.innerHTML = `<div class="modal"><div class="m-head"><h3>${h(title)}</h3>
    <button class="close" title="关闭">✕</button></div>
    <div class="m-body"></div>${footer ? `<div class="m-foot"></div>` : ""}</div>`;
  $(".m-body", wrap).innerHTML = body;
  if (footer) $(".m-foot", wrap).innerHTML = footer;
  const close = () => wrap.remove();
  wrap.addEventListener("click", e => { if (e.target === wrap) close(); });
  $(".close", wrap).onclick = close;
  root.appendChild(wrap);
  const first = $(".m-body input, .m-body select", wrap);
  if (first) setTimeout(() => first.focus(), 60);
  return { el: wrap, close };
}

function confirmDlg(msg) {
  return new Promise(resolve => {
    const m = openModal({
      title: "请确认",
      body: `<p style="margin:4px 0 10px;line-height:1.6">${h(msg)}</p>`,
      footer: `<button class="btn" data-x="no">取消</button><button class="btn primary" data-x="yes">确定</button>`,
    });
    $("[data-x=no]", m.el).onclick = () => { m.close(); resolve(false); };
    $("[data-x=yes]", m.el).onclick = () => { m.close(); resolve(true); };
  });
}

function bindSave(btn, fn) {
  btn.addEventListener("click", async () => {
    try { await fn(); } catch (e) { toast(e.message, false); }
  });
}

const SETTINGS_CACHE = {};
let SETTINGS = {};

/* ================= 导航与路由 ================= */
const NAV = [
  { key: "dashboard", icon: "📊", label: "经营看板" },
  { key: "materials", icon: "🧱", label: "物料库存" },
  { key: "purchases", icon: "🛒", label: "采购记录" },
  { key: "jobs", icon: "🖨️", label: "打印任务" },
  { key: "products", icon: "📦", label: "成品商品" },
  { key: "sales", icon: "💰", label: "销售记录" },
  { key: "analytics", icon: "📈", label: "经营分析" },
  { key: "models", icon: "🌐", label: "模型收藏" },
  { key: "calc", icon: "🧮", label: "定价计算" },
  { key: "logs", icon: "📜", label: "全站流水" },
];
const PAGES = {};

const F = {
  materials: { q: "", category: "", all: false },
  models: { status: "", q: "" },
  logs: { module: "" },
};

function currentKey() {
  const k = location.hash.replace(/^#\/?/, "");
  return PAGES[k] ? k : "dashboard";
}

let routeSeq = 0;
async function route() {
  const key = currentKey();
  const seq = ++routeSeq;
  $$("#nav a").forEach(a => a.classList.toggle("active", a.dataset.key === key));
  $("#page-title").textContent = NAV.find(n => n.key === key).label;
  const app = $("#app");
  app.innerHTML = `<div class="empty"><div class="big">⏳</div>加载中…</div>`;
  try {
    await PAGES[key]();
  } catch (e) {
    if (seq === routeSeq)
      app.innerHTML = `<div class="card"><div class="empty">😅 ${h(e.message)}</div></div>`;
  }
}
const refresh = () => route();

/* ================= 设置弹窗 ================= */
async function openSettings() {
  const s = await api("/api/settings");
  const m = openModal({
    title: "设置",
    body: `
      <div class="field"><label>店名</label><input id="s-shop" value="${h(s.shop_name)}"></div>
      ${LOCAL_MODE ? `
      <div class="field" style="background:var(--soft);border:1px solid #fed7aa;border-radius:10px;padding:10px 14px">
        <label style="color:var(--brand);font-weight:600">🌐 网页版数据管理</label>
        <div class="hint" style="line-height:1.8">数据保存在<b>本浏览器</b>里：换电脑、换浏览器、清理浏览器缓存都会丢失！请定期导出备份。</div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="btn small" id="s-export">⬇️ 导出数据 (JSON)</button>
          <button class="btn small" id="s-import">⬆️ 导入数据</button>
          <input type="file" id="s-import-file" accept=".json,application/json" style="display:none">
        </div>
      </div>` : ""}
      <div class="form-row">
        <div class="field"><label>电价（元/度）</label><input id="s-elec" type="number" step="any" value="${h(s.electricity_price)}"></div>
        <div class="field"><label>机时费（元/小时）</label><input id="s-machine" type="number" step="any" value="${h(s.machine_rate)}"></div>
        <div class="field"><label>默认打印功率（W）</label><input id="s-power" type="number" step="any" value="${h(s.default_power)}"></div>
        <div class="field"><label>损耗率（%）</label><input id="s-loss" type="number" step="any" value="${h(s.loss_rate)}"></div>
      </div>
      <p style="color:var(--muted);font-size:12.5px;line-height:1.7">💡 恢复数据：把备份的 .db 文件重命名为 studio.db，替换 data 文件夹里的同名文件（先关闭程序再替换）。<br>🔒 本站仅建议局域网使用，请勿暴露到公网。</p>`,
    footer: `<button class="btn primary" id="s-save">保存</button>`,
  });
  if (LOCAL_MODE) {
    $("#s-export", m.el).onclick = () => { window.LocalAPI.backup(); toast("已导出 JSON 数据"); };
    $("#s-import", m.el).onclick = () => $("#s-import-file", m.el).click();
    $("#s-import-file", m.el).onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      if (!(await confirmDlg("导入会覆盖网页版当前全部数据，确定继续吗？"))) return;
      try { window.LocalAPI.importJSON(await f.text()); }
      catch (err) { toast(err.message, false); }
    };
  }
  bindSave($("#s-save", m.el), async () => {
    const r = await api("/api/settings", "PUT", {
      shop_name: $("#s-shop", m.el).value,
      electricity_price: $("#s-elec", m.el).value,
      machine_rate: $("#s-machine", m.el).value,
      default_power: $("#s-power", m.el).value,
      loss_rate: $("#s-loss", m.el).value,
    });
    SETTINGS = r.settings;
    $("#logo-name").textContent = SETTINGS.shop_name || "打印小站";
    m.close(); toast("设置已保存"); refresh();
  });
}

/* ================= 看板 ================= */
PAGES.dashboard = async function pageDashboard() {
  const s = await api("/api/stats");
  const maxDaily = Math.max(...s.daily.map(d => d.total), 1);
  const bars = s.daily.map(d => {
    const pct = Math.max(Math.round(d.total / maxDaily * 100), 2);
    return `<div style="flex:1;text-align:center;min-width:0">
      <div style="height:90px;display:flex;align-items:flex-end">
        <div style="width:100%;height:${pct}%;background:linear-gradient(180deg,#fb923c,#ea580c);border-radius:6px 6px 0 0" title="${h(d.date)}：${money(d.total)}"></div>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">${h(d.date)}</div>
      <div style="font-size:11px;font-weight:600;white-space:nowrap">${d.total > 0 ? money(d.total) : "&nbsp;"}</div>
    </div>`;
  }).join("");
  const alerts = [];
  s.backorders.forEach(x => alerts.push(`<div class="alert-item"><span class="chip bad">欠货</span>
      <span style="flex:1">${h(x.name)}</span>
      <span class="low-stock">还欠 ${num(-x.stock)} 件</span>
      <span style="color:var(--muted)">打印入库后自动冲销</span></div>`));
  s.low_stock.forEach(x => alerts.push(`<div class="alert-item"><span class="chip bad">缺料</span>
      <span style="flex:1">${h(x.name)}</span>
      <span class="low-stock">${num(x.stock)} ${h(x.unit)}</span>
      <span style="color:var(--muted)">预警线 ${num(x.min_stock)}</span></div>`));
  (s.printer_hours || []).filter(p => s.maintain_hours > 0 && p.hours >= s.maintain_hours)
    .forEach(p => alerts.push(`<div class="alert-item"><span class="chip warn">保养</span>
      <span style="flex:1">🖨️ ${h(p.name)}</span>
      <span style="color:var(--warn);font-weight:600">累计 ${num(p.hours)}h</span>
      <span style="color:var(--muted)">建议检查喷嘴、清洁导轨</span></div>`));
  const lowHtml = alerts.length ? alerts.join("")
    : `<div class="empty" style="padding:14px">一切正常 🎉</div>`;
  const recent = s.recent.map(l => `<div class="log-line"><span class="t">${h(l.ts)}</span>
      <span class="chip gray">${h(l.module)}</span>
      <span style="flex:1">${h(l.action)} ${h(l.detail)}</span></div>`).join("")
    || `<div class="empty" style="padding:14px">暂无记录，去添加第一笔数据吧～</div>`;
  $("#app").innerHTML = `
    <div class="grid cols4">
      <div class="stat brand"><div class="label">本月销售</div><div class="value">${money(s.month_sales)}</div><div class="sub">利润 ${money(s.month_profit)}</div></div>
      <div class="stat"><div class="label">本月采购</div><div class="value">${money(s.month_purchase)}</div><div class="sub">材料采购支出</div></div>
      <div class="stat"><div class="label">材料库存价值</div><div class="value">${money(s.material_value)}</div><div class="sub">按最近采购单价估算</div></div>
      <div class="stat"><div class="label">成品库存价值</div><div class="value">${money(s.product_value)}</div><div class="sub">按成本估算</div></div>
    </div>
    <div class="grid cols2" style="margin-top:14px">
      <div class="card">
        <h2>⚠️ 待办提醒</h2>
        ${lowHtml}
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <span class="chip ${s.pending_ship > 0 ? "warn" : "gray"}">📦 待发货 ${s.pending_ship} 单</span>
          <span class="chip info">🌐 想打的模型 ${s.want_count} 个</span>
          <span class="chip warn">🖨️ 打印中任务 ${s.printing_count} 个</span>
        </div>
      </div>
      <div class="card">
        <h2>⚡ 快捷操作</h2>
        <div class="quick">
          <button class="btn" data-go="purchases" data-new="1">🛒 记一笔采购</button>
          <button class="btn" data-go="sales" data-new="1">💰 记一笔销售</button>
          <button class="btn" data-go="jobs" data-new="1">🖨️ 新建打印任务</button>
          <button class="btn" data-go="models">🌐 逛模型</button>
          <button class="btn" data-go="calc">🧮 算个价</button>
        </div>
        <h2 style="margin-top:18px">📈 近 7 日销售</h2>
        <div style="display:flex;gap:6px;align-items:flex-end">${bars}</div>
      </div>
    </div>
    <div class="card">
      <h2>📜 最近动态 <span class="right"><a href="#/logs" style="font-size:12.5px;color:var(--brand);text-decoration:none">查看全部 →</a></span></h2>
      ${recent}
    </div>`;
  $$("[data-go]").forEach(b => b.onclick = () => {
    const key = b.dataset.go;
    if (b.dataset.new) sessionStorage.setItem("autoNew", key);
    if (currentKey() === key) route();          // 已在该页：重渲染并弹窗
    else location.hash = "#/" + key;
  });
};

/* ================= 物料库存 ================= */
PAGES.materials = async function pageMaterials() {
  const f = F.materials;
  const qs = [`all=${f.all ? 1 : 0}`];
  if (f.q) qs.push(`q=${encodeURIComponent(f.q)}`);
  if (f.category) qs.push(`category=${encodeURIComponent(f.category)}`);
  const { items } = await api("/api/materials?" + qs.join("&"));
  const rows = items.map(x => {
    const stockTxt = x.category === "耗材"
      ? `${num(x.stock)} 克${x.spools != null ? `（≈${num(x.spools)} 卷）` : ""}`
      : `${num(x.stock)} ${x.unit}`;
    return `<tr>
      <td><b>${h(x.name)}</b>${x.brand || x.spec ? `<div style="font-size:12px;color:var(--muted)">${h([x.brand, x.spec].filter(Boolean).join(" · "))}</div>` : ""}</td>
      <td><span class="chip ${x.category === "耗材" ? "brand" : "gray"}">${h(x.category)}</span></td>
      <td style="cursor:pointer" data-stock="${x.id}" title="点击查看出入库流水" class="${x.low ? "low-stock" : ""}">${stockTxt}${x.low ? " ⚠️" : ""}</td>
      <td class="num">${money(x.unit_price)} / ${x.category === "耗材" ? "克" : h(x.unit)}</td>
      <td class="num">${money(x.stock * x.unit_price)}</td>
      <td style="white-space:nowrap">
        <button class="btn small" data-mv="in" data-id="${x.id}">➕入库</button>
        <button class="btn small" data-mv="out" data-id="${x.id}">➖出库</button>
        <button class="btn small" data-mv="adjust" data-id="${x.id}">⚖️盘点</button>
        <button class="btn small ghost" data-edit="${x.id}" title="编辑">✏️</button>
        ${x.archived
          ? `<button class="btn small" data-arch="${x.id}" data-val="0">启用</button>`
          : `<button class="btn small ghost" data-arch="${x.id}" data-val="1" title="停用（不再显示）">🚫</button>`}
        <button class="btn small danger ghost" data-del="${x.id}" title="删除">🗑</button>
      </td>
    </tr>`;
  }).join("");
  $("#app").innerHTML = `
    <div class="toolbar">
      <input type="search" id="m-q" placeholder="🔍 搜索名称/品牌" value="${h(f.q)}">
      <select id="m-cat">
        <option value="">全部类别</option>
        ${["耗材", "配件", "工具", "其它"].map(c => `<option ${f.category === c ? "selected" : ""}>${c}</option>`).join("")}
      </select>
      <label style="display:flex;align-items:center;gap:5px;color:var(--muted);font-size:13px">
        <input type="checkbox" id="m-all" ${f.all ? "checked" : ""}>显示已停用</label>
      <span class="spacer"></span>
      <button class="btn primary" id="m-add">＋ 新增物料</button>
    </div>
    <div class="card table-wrap">
      ${items.length ? `<table>
        <thead><tr><th>名称</th><th>类别</th><th>当前库存</th><th class="num">单价</th><th class="num">库存价值</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody></table>`
      : `<div class="empty"><div class="big">🧱</div>还没有物料，点右上角「新增物料」开始建账～</div>`}
    </div>`;
  const re = () => { f.q = $("#m-q").value.trim(); f.category = $("#m-cat").value; refresh(); };
  let qt; $("#m-q").oninput = () => { clearTimeout(qt); qt = setTimeout(re, 350); };
  $("#m-cat").onchange = re;
  $("#m-all").onchange = e => { f.all = e.target.checked; refresh(); };
  $("#m-add").onclick = () => materialForm(null);  $$("[data-edit]").forEach(b => b.onclick = () => materialForm(items.find(x => x.id == b.dataset.edit)));
  $$("[data-mv]").forEach(b => b.onclick = () => movementModal(items.find(x => x.id == b.dataset.id), b.dataset.mv));
  $$("[data-stock]").forEach(td => td.onclick = () => showMovements(items.find(x => x.id == td.dataset.stock)));
  $$("[data-arch]").forEach(b => b.onclick = async () => {
    const it = items.find(x => x.id == b.dataset.arch);
    try {
      await api(`/api/materials/${it.id}`, "PUT", { ...it, archived: b.dataset.val === "1" });
      toast(b.dataset.val === "1" ? "已停用" : "已启用"); refresh();
    } catch (e) { toast(e.message, false); }
  });
  $$("[data-del]").forEach(b => b.onclick = async () => {
    const it = items.find(x => x.id == b.dataset.del);
    if (!(await confirmDlg(`确定删除物料「${it.name}」吗？`))) return;
    try { await api(`/api/materials/${it.id}`, "DELETE"); toast("已删除"); refresh(); }
    catch (e) { toast(e.message, false); }
  });
};

function materialForm(mat) {
  const isEdit = !!mat;
  const d = mat || { category: "耗材" };
  const m = openModal({
    title: isEdit ? "编辑物料" : "新增物料",
    body: `
      <div class="field"><label>名称 *</label><input id="f-name" value="${h(d.name || "")}" placeholder="如：PLA 玛雅棕"></div>
      <div class="form-row">
        <div class="field"><label>类别</label><select id="f-cat">
          ${["耗材", "配件", "工具", "其它"].map(c => `<option ${d.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div class="field"><label>品牌</label><input id="f-brand" value="${h(d.brand || "")}" placeholder="如：拓竹 / Bambu"></div>
        <div class="field"><label>规格</label><input id="f-spec" value="${h(d.spec || "")}" placeholder="如：1.75mm / 0.4mm"></div>
        <div class="field" id="f-unit-wrap"><label>单位</label><input id="f-unit" value="${h(d.unit || "个")}" placeholder="个 / 套 / 包"></div>
      </div>
      <div class="form-row">
        <div class="field cat-g"><label>每卷克重（克）</label><input id="f-totalg" type="number" step="any" value="${d.total_g || ""}" placeholder="如 1000"></div>
        <div class="field"><label id="f-plabel">单价（元/克）</label><input id="f-price" type="number" step="any" value="${d.unit_price ?? ""}">
          <div class="hint" id="f-phint"></div></div>
        <div class="field"><label>低库存预警线</label><input id="f-min" type="number" step="any" value="${d.min_stock ?? ""}" placeholder="低于此数量在看板提醒"></div>
      </div>
      <div class="field"><label>备注</label><input id="f-note" value="${h(d.note || "")}"></div>`,
    footer: `<button class="btn primary" id="f-save">保存</button>`,
  });
  const catSel = $("#f-cat", m.el);
  const sync = () => {
    const isFil = catSel.value === "耗材";
    $("#f-unit-wrap", m.el).style.display = isFil ? "none" : "";
    $(".cat-g", m.el).style.display = isFil ? "" : "none";
    $("#f-plabel", m.el).textContent = isFil ? "单价（元/克）" : "单价（元/个）";
    const g = +$("#f-totalg", m.el).value || 0;
    $("#f-phint", m.el).textContent = isFil
      ? (g > 0 ? `即 ${money(g * (+$("#f-price", m.el).value || 0))} / 卷（${g}g）` : "0.02 元/克 ≈ 20 元/公斤")
      : "";
  };
  catSel.onchange = sync;
  $("#f-totalg", m.el).oninput = sync;
  $("#f-price", m.el).oninput = sync;
  sync();
  bindSave($("#f-save", m.el), async () => {
    const body = {
      name: $("#f-name", m.el).value, category: catSel.value,
      brand: $("#f-brand", m.el).value, spec: $("#f-spec", m.el).value,
      unit: $("#f-unit", m.el).value,
      total_g: $("#f-totalg", m.el).value, unit_price: $("#f-price", m.el).value,
      min_stock: $("#f-min", m.el).value, note: $("#f-note", m.el).value,
    };
    if (isEdit) {
      await api(`/api/materials/${mat.id}`, "PUT", { ...body, archived: !!mat.archived });
    } else {
      await api("/api/materials", "POST", body);
    }
    m.close(); toast("已保存"); refresh();
  });
}

function movementModal(mat, type) {
  const titles = { in: "入库", out: "出库", adjust: "盘点" };
  const isAdjust = type === "adjust";
  const m = openModal({
    title: `${titles[type]} · ${mat.name}`,
    body: `
      <div class="field"><label>${isAdjust ? "盘点后的库存数量" : "数量"}（${h(mat.unit)}）*</label>
        <input id="mv-qty" type="number" step="any" value="${isAdjust ? mat.stock : ""}" placeholder="${isAdjust ? "当前 " + num(mat.stock) : "0"}"></div>
      <div class="field"><label>备注</label><input id="mv-note" placeholder="如：京东购入 / 送货损耗"></div>`,
    footer: `<button class="btn primary" id="mv-save">确定</button>`,
  });
  bindSave($("#mv-save", m.el), async () => {
    await api(`/api/materials/${mat.id}/movement`, "POST", {
      type, qty: $("#mv-qty", m.el).value, note: $("#mv-note", m.el).value,
    });
    m.close(); toast(`${titles[type]}完成`); refresh();
  });
}

async function showMovements(mat) {
  const { items } = await api(`/api/materials/${mat.id}/movements`);
  const refLabel = { purchase: "🛒采购入库", print: "🖨️打印消耗", manual: "✋手动", adjust: "⚖️盘点" };
  const rows = items.map(x => `<tr>
    <td style="white-space:nowrap">${h(x.ts)}</td>
    <td class="num" style="color:${x.qty >= 0 ? "var(--ok)" : "var(--bad)"};font-weight:600">${x.qty >= 0 ? "+" : ""}${num(x.qty)}</td>
    <td>${refLabel[x.ref_type] || h(x.ref_type)}</td>
    <td>${h(x.note || "")}</td></tr>`).join("");
  openModal({
    title: `出入库流水 · ${mat.name}`,
    body: items.length
      ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th class="num">变动（${h(mat.unit)}）</th><th>来源</th><th>备注</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty">暂无流水</div>`,
    footer: `<button class="btn" onclick="this.closest('.overlay').remove()">关闭</button>`,
  });
}

/* ================= 采购记录 ================= */
PAGES.purchases = async function pagePurchases() {
  const { items } = await api("/api/purchases");
  const cards = items.map(p => {
    const lines = p.items.map(it => {
      const per = it.total_g > 0 ? `（≈${num(it.qty / it.total_g)} 卷）` : "";
      return `<tr><td>${h(it.material_name)}</td>
        <td class="num">${num(it.qty)} ${h(it.unit)}${per}</td>
        <td class="num">${money(it.unit_price)}</td>
        <td class="num">${money(it.qty * it.unit_price)}</td></tr>`;
    }).join("");
    return `<div class="card" style="margin-bottom:12px">
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
        <b>${h(p.supplier)}</b>
        <span style="color:var(--muted);font-size:13px">${h(p.ts)}</span>
        ${p.status === "done"
          ? `<span class="chip ok">已入库</span>`
          : `<span class="chip warn">待收货</span>`}
        <span style="margin-left:auto;font-weight:700">${money(p.total)}</span>
        ${p.status === "pending"
          ? `<button class="btn small primary" data-confirm="${p.id}">✅ 确认收货入库</button>
             <button class="btn small danger" data-del="${p.id}">删除</button>`
          : ""}
      </div>
      <details style="margin-top:8px"><summary style="cursor:pointer;color:var(--muted);font-size:13px">明细（${p.items.length} 项）${p.note ? ` · ${h(p.note)}` : ""}</summary>
        <div class="table-wrap" style="margin-top:6px"><table>
          <thead><tr><th>物料</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th></tr></thead>
          <tbody>${lines}</tbody></table></div>
      </details>
    </div>`;
  }).join("");
  $("#app").innerHTML = `
    <div class="toolbar">
      <span style="color:var(--muted);font-size:13px">采购流程：录单 → 货到后点「确认收货入库」→ 自动入库并更新最新单价</span>
      <span class="spacer"></span>
      <button class="btn primary" id="p-add">＋ 新增采购单</button>
    </div>
    ${items.length ? cards : `<div class="card"><div class="empty"><div class="big">🛒</div>还没有采购记录</div></div>`}`;
  $("#p-add").onclick = () => purchaseModal();
  $$("[data-confirm]").forEach(b => b.onclick = async () => {
    if (!(await confirmDlg("确认已收到货？确认后材料将自动入库。"))) return;
    try { await api(`/api/purchases/${b.dataset.confirm}/confirm`, "POST"); toast("已入库 ✓"); refresh(); }
    catch (e) { toast(e.message, false); }
  });
  $$("[data-del]").forEach(b => b.onclick = async () => {
    if (!(await confirmDlg("确定删除这张待收货采购单吗？"))) return;
    try { await api(`/api/purchases/${b.dataset.del}`, "DELETE"); toast("已删除"); refresh(); }
    catch (e) { toast(e.message, false); }
  });
  if (sessionStorage.getItem("autoNew") === "purchases") {
    sessionStorage.removeItem("autoNew");
    purchaseModal();
  }
};

async function purchaseModal() {
  const { items: mats } = await api("/api/materials");
  const m = openModal({
    title: "新增采购单",
    body: `
      <div class="form-row">
        <div class="field"><label>供应商</label><input id="p-supplier" placeholder="如：拼多多·XX耗材店"></div>
        <div class="field"><label>备注</label><input id="p-note" placeholder="选填"></div>
      </div>
      <div class="field"><label>采购明细</label>
        <div id="p-rows"></div>
        <div><button class="btn small" id="p-addrow">＋ 添加一行</button></div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:16px;font-size:14px">
        <span>合计：<b id="p-total">¥0.00</b></span>
      </div>`,
    footer: `<button class="btn primary" id="p-save">保存采购单</button>`,
  });
  const rowBox = $("#p-rows", m.el);
  // 计算一行的（克数, 元/克, 显示提示）：耗材支持「按卷」直觉输入
  const rowVals = row => {
    const mat = mats.find(x => x.id == $(".pr-mid", row).value);
    let qty = +$(".pr-qty", row).value || 0;
    let price = +$(".pr-price", row).value || 0;
    if (mat && mat.category === "耗材" && mat.total_g > 0 && row.dataset.mode === "roll") {
      qty = qty * mat.total_g;                 // 卷 → 克
      price = mat.total_g ? price / mat.total_g : 0;  // 元/卷 → 元/克
    }
    return { mat, qty, price };
  };
  const addRow = () => {
    const row = document.createElement("div");
    row.className = "p-row";
    row.dataset.mode = "gram";
    row.style.cssText = "display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:6px;margin-bottom:4px;align-items:center";
    row.innerHTML = `
      <select class="pr-mid">${mats.map(x => `<option value="${x.id}">${h(x.name)}（${x.category === "耗材" ? "按克" : "按" + h(x.unit)}）</option>`).join("")}</select>
      <input class="pr-qty" type="number" step="any" placeholder="数量" min="0">
      <input class="pr-price" type="number" step="any" placeholder="单价(元)" min="0">
      <button class="btn small ghost pr-del" title="删除本行">✕</button>
      <div class="pr-hintline" style="grid-column:1/-1;font-size:12px;color:var(--muted);margin:-2px 0 4px;display:flex;gap:10px;align-items:center">
        <span class="pr-hint" style="flex:1"></span>
        <button type="button" class="pr-mode" style="border:none;background:none;color:var(--brand);cursor:pointer;font-size:12px;padding:0 2px">按卷输入</button>
      </div>`;
    rowBox.appendChild(row);
    $(".pr-del", row).onclick = () => { row.remove(); recompute(); };
    $(".pr-mode", row).onclick = () => {
      row.dataset.mode = row.dataset.mode === "roll" ? "gram" : "roll";
      $(".pr-mode", row).textContent = row.dataset.mode === "roll" ? "按克输入" : "按卷输入";
      upd();
    };
    const upd = () => {
      const mat = mats.find(x => x.id == $(".pr-mid", row).value);
      const qty = +$(".pr-qty", row).value || 0;
      const price = +$(".pr-price", row).value || 0;
      const isFil = !!(mat && mat.category === "耗材" && mat.total_g > 0);
      const roll = isFil && row.dataset.mode === "roll";
      const { qty: g, price: pg } = rowVals(row);
      const hint = $(".pr-hint", row);
      if (!mat) hint.textContent = "";
      else if (isFil && roll) {
        hint.textContent = (qty || price)
          ? `${num(qty)} 卷 = ${num(g)} 克${price ? ` · ${num(pg)} 元/克` : ""} · 合计 ${money(g * pg)}`
          : `按卷填更省事：1 卷 = ${mat.total_g} 克`;
      } else if (isFil) {
        hint.textContent = (qty || price)
          ? `${num(qty)} 克 ≈ ${num(qty / mat.total_g)} 卷 · 合计 ${money(qty * price)}`
          : `按克填：1 卷 = ${mat.total_g} 克`;
      } else {
        hint.textContent = "";
      }
      $(".pr-qty", row).placeholder = roll ? "卷数" : (isFil ? "数量(克)" : "数量");
      $(".pr-price", row).placeholder = roll ? "单价(元/卷)" : "单价(元)";
      recompute();
    };
    $(".pr-mid", row).onchange = () => {
      const mat = mats.find(x => x.id == $(".pr-mid", row).value);
      // 耗材默认按卷输入（符合直觉），其它类别固定按件
      row.dataset.mode = (mat && mat.category === "耗材" && mat.total_g > 0) ? "roll" : "gram";
      $(".pr-mode", row).style.display = (mat && mat.category === "耗材" && mat.total_g > 0) ? "" : "none";
      $(".pr-mode", row).textContent = row.dataset.mode === "roll" ? "按克输入" : "按卷输入";
      upd();
    };
    $(".pr-qty", row).oninput = upd;
    $(".pr-price", row).oninput = upd;
    // 初始触发一次（设置默认模式与占位符）
    $(".pr-mid", row).onchange();
  };
  const recompute = () => {
    let sum = 0;
    $$(".p-row", rowBox).forEach(row => {
      const { qty, price } = rowVals(row);
      sum += qty * price;
    });
    $("#p-total", m.el).textContent = money(sum);
  };
  $("#p-addrow", m.el).onclick = addRow;
  addRow();
  bindSave($("#p-save", m.el), async () => {
    const items = $$(".p-row", rowBox).map(row => {
      const { mat, qty, price } = rowVals(row);
      return { material_id: mat ? mat.id : 0, qty, unit_price: price };
    }).filter(x => x.material_id && x.qty > 0);
    await api("/api/purchases", "POST", {
      supplier: $("#p-supplier", m.el).value,
      note: $("#p-note", m.el).value,
      items,
    });
    m.close(); toast("采购单已保存，收货后请点「确认收货入库」"); refresh();
  });
}

/* ================= 打印任务 ================= */
const JOB_ST = { printing: ["打印中", "st-printing"], done: ["已完成", "st-done"], canceled: ["已取消", "st-canceled"] };

PAGES.jobs = async function pageJobs() {
  const [{ items: jobs }, { items: printers }] = await Promise.all([
    api("/api/jobs"), api("/api/printers"),
  ]);
  const printerCards = printers.map(p => `<div class="printer-card">
      <span style="font-size:20px">🖨️</span>
      <div><div class="nm">${h(p.name)}</div>
      <div class="md">${h(p.model || "—")} · ${num(p.power_w)}W${p.total_hours ? ` · 累计 ${num(p.total_hours)}h` : ""}</div></div>
      <div class="ops">
        <button class="btn small ghost" data-pedit="${p.id}" title="编辑">✏️</button>
        <button class="btn small ghost danger" data-pdel="${p.id}" title="删除">🗑</button>
      </div>
    </div>`).join("")
    + `<button class="printer-card" id="p-new" style="cursor:pointer;justify-content:center;color:var(--muted)">＋ 新增打印机</button>`;
  const rows = jobs.map(j => {
    const [stTxt, stCls] = JOB_ST[j.status] || [j.status, "gray"];
    const mats = j.materials.map(x => `${h(x.name)} ${num(x.grams)}g`).join("，");
    return `<tr>
      <td><span class="chip ${stCls}">${stTxt}</span></td>
      <td><b>${h(j.title)}</b>${j.model_title ? `<div style="font-size:12px"><a href="#" data-model="${j.model_link_id}" style="color:var(--info);text-decoration:none">🌐 ${h(j.model_title)}</a></div>` : ""}</td>
      <td>${h(j.printer_name || "—")}</td>
      <td class="num">${j.status === "done" ? `✅${j.done_qty}${j.fail_qty ? ` / 废${j.fail_qty}` : ""}` : `计划 ${j.planned_qty}`}</td>
      <td class="num">${j.hours ? num(j.hours) + "h" : "—"}</td>
      <td style="max-width:220px;font-size:12.5px;color:var(--muted)">${h(mats) || "—"}${j.cost ? `<br>材料成本 ${money(j.cost)}` : ""}</td>
      <td style="white-space:nowrap">
        ${j.status === "printing"
          ? `<button class="btn small primary" data-done="${j.id}">✅ 完成</button>
             <button class="btn small" data-cancel="${j.id}">取消</button>`
          : ""}
        ${j.status !== "done" ? `<button class="btn small danger ghost" data-del="${j.id}">🗑</button>` : ""}
      </td>
    </tr>`;
  }).join("");
  $("#app").innerHTML = `
    <div class="card"><h2>🖨️ 我的打印机</h2><div class="printer-strip">${printerCards || ""}</div></div>
    <div class="toolbar">
      <span style="color:var(--muted);font-size:13px">完成任务时：自动按克重扣减耗材 → 成品自动入库</span>
      <span class="spacer"></span>
      <button class="btn primary" id="j-add">＋ 新建打印任务</button>
    </div>
    <div class="card table-wrap">
      ${jobs.length ? `<table>
        <thead><tr><th>状态</th><th>任务</th><th>打印机</th><th class="num">数量</th><th class="num">耗时</th><th>耗材</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody></table>`
      : `<div class="empty"><div class="big">🖨️</div>暂无打印任务</div>`}
    </div>`;
  $("#p-new").onclick = () => printerForm(null);
  $$("[data-pedit]").forEach(b => b.onclick = () => printerForm(printers.find(x => x.id == b.dataset.pedit)));
  $$("[data-pdel]").forEach(b => b.onclick = async () => {
    if (!(await confirmDlg("确定删除这台打印机吗？"))) return;
    try { await api(`/api/printers/${b.dataset.pdel}`, "DELETE"); toast("已删除"); refresh(); }
    catch (e) { toast(e.message, false); }
  });
  $("#j-add").onclick = () => jobModal(printers);
  $$("[data-done]").forEach(b => b.onclick = () => jobCompleteModal(jobs.find(x => x.id == b.dataset.done)));
  $$("[data-cancel]").forEach(b => b.onclick = async () => {
    if (!(await confirmDlg("确定取消这个任务吗？（不扣材料）"))) return;
    try { await api(`/api/jobs/${b.dataset.cancel}/cancel`, "POST"); toast("已取消"); refresh(); }
    catch (e) { toast(e.message, false); }
  });
  $$("[data-del]").forEach(b => b.onclick = async () => {
    if (!(await confirmDlg("确定删除这个任务吗？"))) return;
    try { await api(`/api/jobs/${b.dataset.del}`, "DELETE"); toast("已删除"); refresh(); }
    catch (e) { toast(e.message, false); }
  });
  $$("[data-model]").forEach(a => a.onclick = e => {
    e.preventDefault();
    location.hash = "#/models";
  });
  if (sessionStorage.getItem("autoNew") === "jobs") {
    sessionStorage.removeItem("autoNew");
    jobModal(printers);
  }
};

function printerForm(p) {
  const isEdit = !!p;
  const m = openModal({
    title: isEdit ? "编辑打印机" : "新增打印机",
    body: `
      <div class="form-row">
        <div class="field"><label>名称 *</label><input id="pr-name" value="${h(p?.name || "")}" placeholder="如：A1 mini 一号机"></div>
        <div class="field"><label>型号</label><input id="pr-model" value="${h(p?.model || "")}" placeholder="如：拓竹 A1 mini"></div>
        <div class="field"><label>平均功率（W）</label><input id="pr-power" type="number" step="any" value="${p?.power_w ?? 120}"></div>
      </div>
      <div class="field"><label>备注</label><input id="pr-note" value="${h(p?.note || "")}"></div>`,
    footer: `<button class="btn primary" id="pr-save">保存</button>`,
  });
  bindSave($("#pr-save", m.el), async () => {
    const body = {
      name: $("#pr-name", m.el).value, model: $("#pr-model", m.el).value,
      power_w: $("#pr-power", m.el).value, note: $("#pr-note", m.el).value,
    };
    if (isEdit) await api(`/api/printers/${p.id}`, "PUT", body);
    else await api("/api/printers", "POST", body);
    m.close(); toast("已保存"); refresh();
  });
}

async function jobModal(printers) {
  const [{ items: models }, { items: mats }] = await Promise.all([
    api("/api/models"), api("/api/materials"),
  ]);
  const filMats = mats.filter(x => x.category === "耗材" && !x.archived);
  const m = openModal({
    title: "新建打印任务",
    body: `
      <div class="field"><label>任务标题（打印什么）*</label><input id="j-title" placeholder="如：玛雅棕关节龙 ×3"></div>
      <div class="form-row">
        <div class="field"><label>打印机</label><select id="j-printer">
          <option value="">（未指定）</option>
          ${printers.map(p => `<option value="${p.id}">${h(p.name)}</option>`).join("")}</select></div>
        <div class="field"><label>计划数量</label><input id="j-qty" type="number" step="1" value="1" min="1"></div>
      </div>
      <div class="field"><label>关联模型收藏（选填）</label><select id="j-model">
        <option value="">（不关联）</option>
        ${models.map(x => `<option value="${x.id}">${h(x.title)}</option>`).join("")}</select></div>
      <div class="field"><label>预计耗材（完成后按此自动出库）</label>
        <div id="j-mrows"></div>
        <div><button class="btn small" id="j-addm">＋ 添加耗材</button></div></div>
      <div class="field"><label>备注</label><input id="j-note"></div>`,
    footer: `<button class="btn primary" id="j-save">创建任务</button>`,
  });
  const box = $("#j-mrows", m.el);
  const addM = () => {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:2fr 1fr auto;gap:6px;margin-bottom:6px;align-items:center";
    row.innerHTML = `
      <select class="jm-id">${filMats.map(x => `<option value="${x.id}">${h(x.name)}</option>`).join("")}</select>
      <input class="jm-g" type="number" step="any" placeholder="克数 g" min="0">
      <button class="btn small ghost jm-del">✕</button>`;
    box.appendChild(row);
    $(".jm-del", row).onclick = () => row.remove();
  };
  $("#j-addm", m.el).onclick = addM;
  addM();
  bindSave($("#j-save", m.el), async () => {
    const materials = $$(".jm-id", m.el).map(sel => ({
      material_id: +sel.value,
      grams: $(".jm-g", sel.parentElement).value,
    })).filter(x => x.material_id && +x.grams > 0);
    await api("/api/jobs", "POST", {
      title: $("#j-title", m.el).value,
      printer_id: $("#j-printer", m.el).value || null,
      model_link_id: $("#j-model", m.el).value || null,
      planned_qty: $("#j-qty", m.el).value,
      note: $("#j-note", m.el).value,
      materials,
    });
    m.close(); toast("任务已创建，打印完成后点「完成」"); refresh();
  });
}

function jobCompleteModal(job) {
  const m = openModal({
    title: `完成任务 · ${job.title}`,
    body: `
      <div style="background:var(--warn-soft);color:var(--warn);border-radius:10px;padding:9px 12px;margin-bottom:12px;font-size:13px">
        将自动出库耗材：${job.materials.map(x => `${h(x.name)} ${num(x.grams)}g`).join("，") || "（未登记耗材）"}，材料成本约 <b>${money(job.cost)}</b>
      </div>
      <div class="form-row">
        <div class="field"><label>成品数量 *</label><input id="c-done" type="number" step="1" min="0" value="${job.planned_qty}"></div>
        <div class="field"><label>废件数量</label><input id="c-fail" type="number" step="1" min="0" value="0"></div>
        <div class="field"><label>实际耗时（小时）</label><input id="c-hours" type="number" step="any" placeholder="如 4.5"></div>
        <div class="field"><label>建议售价（选填，写入商品）</label><input id="c-price" type="number" step="any" placeholder="可用「定价计算」估算"></div>
      </div>
      <div class="field" style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" id="c-make" checked><label for="c-make" style="font-size:13.5px;color:var(--ink)">成品入库（计入成品库存，可直接销售）</label>
      </div>
      <div class="field"><label>成品名称</label><input id="c-pname" value="${h(job.title)}"></div>`,
    footer: `<button class="btn primary" id="c-save">完成任务</button>`,
  });
  const sync = () => { $("#c-pname", m.el).disabled = !$("#c-make", m.el).checked; };
  $("#c-make", m.el).onchange = sync;
  sync();
  bindSave($("#c-save", m.el), async () => {
    await api(`/api/jobs/${job.id}/complete`, "POST", {
      done_qty: $("#c-done", m.el).value,
      fail_qty: $("#c-fail", m.el).value,
      hours: $("#c-hours", m.el).value,
      create_product: $("#c-make", m.el).checked,
      product_name: $("#c-pname", m.el).value,
      product_price: $("#c-price", m.el).value,
    });
    m.close(); toast("任务已完成，耗材已出库、成品已入库 ✓"); refresh();
  });
}

/* ================= 成品商品 ================= */
PAGES.products = async function pageProducts() {
  const { items } = await api("/api/products");
  const cards = items.map(p => {
    const stockChip = p.stock < 0
      ? `<span class="chip bad">欠货 ${num(-p.stock)} 件</span>`
      : `<span class="chip ${p.stock > 0 ? "ok" : "gray"}">库存 ${num(p.stock)} 件</span>`;
    return `<div class="model-card">
      <div class="img">${p.img_url ? `<img src="${h(p.img_url)}" onerror="this.remove()" alt="">` : "📦"}
        <span class="src"><span class="chip gray">${money(p.price)}</span></span></div>
      <div class="body">
        <div class="title">${h(p.name)}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${stockChip}
          <span style="font-size:12px;color:var(--muted)">成本 ${money(p.cost)}</span></div>
        ${p.weight_g ? `<div class="tags">⚖️ 约 ${num(p.weight_g)} 克/件</div>` : ""}
        ${p.note ? `<div class="note">${h(p.note)}</div>` : ""}
        <div class="acts">
          <button class="btn small" data-copy="${p.id}" title="一键生成闲鱼文案">📝 文案</button>
          <button class="btn small" data-edit="${p.id}" title="编辑（可粘贴商品图）">✏️</button>
          <select class="p-mv" data-id="${p.id}" style="padding:3px 6px;font-size:12px">
            <option value="">库存操作</option><option value="in">➕入库</option>
            <option value="out">➖出库</option><option value="adjust">⚖️盘点</option>
          </select>
          <span style="flex:1"></span>
          ${p.xianyu_url ? `<a class="btn small ghost" href="${h(p.xianyu_url)}" target="_blank" rel="noopener" title="打开闲鱼商品页">🐟</a>` : ""}
          <button class="btn small ghost danger" data-del="${p.id}">🗑</button>
        </div>
      </div>
    </div>`;
  }).join("");
  $("#app").innerHTML = `
    <div class="toolbar">
      <span style="color:var(--muted);font-size:13px">打印任务完成自动入库；编辑商品时可直接 Ctrl+V 粘贴图片，📝 一键生成闲鱼文案</span>
      <span class="spacer"></span>
      <button class="btn primary" id="pr-add">＋ 手动新增商品</button>
    </div>
    ${items.length ? `<div class="model-grid">${cards}</div>`
      : `<div class="card"><div class="empty"><div class="big">📦</div>还没有成品——去「打印任务」完成一个任务，或手动新增</div></div>`}`;
  $("#pr-add").onclick = () => productForm(null);
  $$("[data-edit]").forEach(b => b.onclick = () => productForm(items.find(x => x.id == b.dataset.edit)));
  $$("[data-copy]").forEach(b => b.onclick = () => productCopyModal(items.find(x => x.id == b.dataset.copy)));
  $$("[data-del]").forEach(b => b.onclick = async () => {
    const it = items.find(x => x.id == b.dataset.del);
    if (!(await confirmDlg(`确定删除商品「${it.name}」吗？`))) return;
    try { await api(`/api/products/${it.id}`, "DELETE"); toast("已删除"); refresh(); }
    catch (e) { toast(e.message, false); }
  });
  $$(".p-mv").forEach(sel => sel.onchange = () => {
    const p = items.find(x => x.id == sel.dataset.id);
    if (!sel.value) return;
    productMovementModal(p, sel.value);
  });
};

function productMovementModal(p, type) {
  const titles = { in: "入库", out: "出库", adjust: "盘点" };
  const isAdjust = type === "adjust";
  const m = openModal({
    title: `${titles[type]} · ${p.name}`,
    body: `
      <div class="field"><label>${isAdjust ? "盘点后的库存数量" : "数量"}（件）*</label>
        <input id="pm-qty" type="number" step="any" value="${isAdjust ? p.stock : ""}"
          placeholder="${isAdjust ? "当前 " + num(p.stock) : "0"}"></div>
      <div class="field"><label>备注</label><input id="pm-note" placeholder="如：赠品补发 / 盘点差异"></div>`,
    footer: `<button class="btn primary" id="pm-save">确定</button>`,
  });
  bindSave($("#pm-save", m.el), async () => {
    await api(`/api/products/${p.id}/movement`, "POST", {
      type, qty: $("#pm-qty", m.el).value, note: $("#pm-note", m.el).value,
    });
    m.close(); toast(`${titles[type]}完成`); refresh();
  });
}

function productForm(p) {
  const isEdit = !!p;
  const d = p || {};
  const m = openModal({
    title: isEdit ? "编辑商品" : "新增商品",
    body: `
      <div class="field"><label>商品图片（点击选图，或直接 Ctrl+V 粘贴截图）</label>
        <div id="pf-zone" style="border:2px dashed var(--line);border-radius:12px;height:110px;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;color:var(--muted)">
          ${d.img_url ? `<img src="${h(d.img_url)}" style="max-height:100%;object-fit:cover">` : "🖼️ 点击选择 / 粘贴图片"}
        </div>
        <input type="file" id="pf-file" accept="image/*" style="display:none">
      </div>
      <div class="form-row">
        <div class="field"><label>名称 *</label><input id="pf-name" value="${h(d.name || "")}"></div>
        <div class="field"><label>售价（元）</label><input id="pf-price" type="number" step="any" value="${d.price ?? ""}"></div>
        <div class="field"><label>单件成本（元）</label><input id="pf-cost" type="number" step="any" value="${d.cost ?? ""}"></div>
        <div class="field"><label>单件克重（g）</label><input id="pf-weight" type="number" step="any" value="${d.weight_g ?? ""}"></div>
      </div>
      <div class="field"><label>闲鱼商品链接（发布后贴回来，卡片上 🐟 一键打开）</label>
        <input id="pf-xy" value="${h(d.xianyu_url || "")}" placeholder="https://www.goofish.com/item?id=..."></div>
      <div class="field"><label>备注 / 卖点</label><input id="pf-note" value="${h(d.note || "")}" placeholder="如：可动关节、桌面摆件、支持定制配色"></div>`,
    footer: `<button class="btn primary" id="pf-save">保存</button>`,
  });
  let imgUrl = d.img_url || "";
  const zone = $("#pf-zone", m.el);
  const setImg = url => {
    imgUrl = url;
    zone.innerHTML = url ? `<img src="${h(url)}" style="max-height:100%;object-fit:cover">`
                         : "🖼️ 点击选择 / 粘贴图片";
  };
  const uploadBlob = async blob => {
    if (!blob) return;
    toast("正在上传图片…");
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
    try {
      const r = await api("/api/upload/image", "POST", { data: dataUrl });
      setImg(r.url);
      toast("图片已上传 ✓");
    } catch (e) { toast(e.message, false); }
  };
  zone.onclick = () => $("#pf-file", m.el).click();
  $("#pf-file", m.el).onchange = e => { const f = e.target.files[0]; if (f) uploadBlob(f); };
  const onPaste = e => {
    const it = [...((e.clipboardData && e.clipboardData.items) || [])]
      .find(x => x.type && x.type.startsWith("image/"));
    if (it) { e.preventDefault(); uploadBlob(it.getAsFile()); }
  };
  document.addEventListener("paste", onPaste);
  const obs = new MutationObserver(() => {
    if (!document.body.contains(zone)) {
      document.removeEventListener("paste", onPaste);
      obs.disconnect();
    }
  });
  obs.observe(document.getElementById("modal-root"), { childList: true });
  bindSave($("#pf-save", m.el), async () => {
    const body = {
      name: $("#pf-name", m.el).value,
      price: $("#pf-price", m.el).value,
      cost: $("#pf-cost", m.el).value,
      weight_g: $("#pf-weight", m.el).value,
      xianyu_url: $("#pf-xy", m.el).value,
      note: $("#pf-note", m.el).value,
      img_url: imgUrl,
    };
    if (isEdit) await api(`/api/products/${p.id}`, "PUT", body);
    else await api("/api/products", "POST", { ...body, stock: 0 });
    m.close(); toast("已保存"); refresh();
  });
}

function productCopyModal(p) {
  const price = p.price ? `¥${p.price}` : "价格私聊";
  const txt = `【3D打印成品】${p.name}

✨ ${p.name}，3D打印到手即可用
🧵 材料：PLA${p.weight_g ? `，单件约 ${num(p.weight_g)} 克` : ""}
🎨 细节：出厂前逐个试组装检查，层纹均匀
📦 包装：气泡膜+硬纸盒加固，放心拍
🚚 发货：48小时内发出
💬 售后：运输损坏免费补件，非人为质量问题支持退换

💰 ${price}
拍前有问题欢迎留言～${p.note ? `\n\n🔖 卖点：${p.note}` : ""}`;
  const m = openModal({
    title: `闲鱼文案 · ${p.name}`,
    body: `
      <div class="field"><label>可自由修改，改完点「复制」去闲鱼粘贴发布</label>
        <textarea id="cp-txt" rows="14" style="width:100%;resize:vertical;line-height:1.7">${h(txt)}</textarea></div>
      ${p.xianyu_url ? "" : `<p style="font-size:12.5px;color:var(--muted)">💡 发布后把商品链接贴回「编辑商品」，以后卡片上点 🐟 一键打开改价。</p>`}`,
    footer: `<button class="btn" id="cp-re">🔄 恢复默认</button><button class="btn primary" id="cp-copy">📋 复制文案</button>`,
  });
  const ta = $("#cp-txt", m.el);
  $("#cp-re", m.el).onclick = () => { ta.value = txt; };
  $("#cp-copy", m.el).onclick = async () => {
    try { await navigator.clipboard.writeText(ta.value); toast("已复制，去闲鱼发布吧 🐟"); }
    catch (e) { ta.select(); toast("已全选，请按 Ctrl+C 复制", false); }
  };
}

/* ================= 销售记录 ================= */
const CHANNELS = ["闲鱼", "微信", "拼多多", "淘宝", "线下", "其它"];
const CH_CLS = { "闲鱼": "brand", "微信": "ok", "拼多多": "warn", "淘宝": "info", "线下": "gray", "其它": "gray" };

PAGES.sales = async function pageSales() {
  const { items } = await api("/api/sales");
  const rows = items.map(s => {
    const detail = s.items.map(x => `${h(x.name)}×${num(x.qty)}`).join("，");
    return `<tr>
      <td style="white-space:nowrap">${h(s.ts)}</td>
      <td><span class="chip ${CH_CLS[s.channel] || "gray"}">${h(s.channel)}</span>${s.buyer ? `<div style="font-size:12px;color:var(--muted)">${h(s.buyer)}</div>` : ""}</td>
      <td style="max-width:260px;font-size:13px">${h(detail)}${s.note ? `<div style="font-size:12px;color:var(--muted)">📝 ${h(s.note)}</div>` : ""}</td>
      <td><span class="chip ${s.ship_status === "shipped" ? "ok" : "warn"}">${s.ship_status === "shipped" ? "已发货" : "待发货"}</span>
        ${s.tracking_no ? `<div style="font-size:12px;color:var(--muted)">${h(s.tracking_no)}</div>` : ""}</td>
      <td class="num"><b>${money(s.total)}</b></td>
      <td class="num" style="color:var(--muted)">${money(s.cost)}</td>
      <td class="num profit-${s.profit >= 0 ? "pos" : "neg"}">${money(s.profit)}</td>
      <td style="white-space:nowrap">
        <button class="btn small" data-ship="${s.id}">📦${s.ship_status === "shipped" ? "单号" : "发货"}</button>
        <button class="btn small danger ghost" data-del="${s.id}" title="删除（会返还库存）">🗑</button>
      </td>
    </tr>`;
  }).join("");
  $("#app").innerHTML = `
    <div class="toolbar">
      <span style="color:var(--muted);font-size:13px">录销售时自动扣减成品库存并核算利润；缺货可按「预售」接单</span>
      <span class="spacer"></span>
      <button class="btn primary" id="s-add">＋ 新增销售</button>
    </div>
    <div class="card table-wrap">
      ${items.length ? `<table>
        <thead><tr><th>时间</th><th>渠道</th><th>商品</th><th>发货</th><th class="num">实收</th><th class="num">成本</th><th class="num">利润</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>`
      : `<div class="empty"><div class="big">💰</div>还没有销售记录，出单了记得来记一笔～</div>`}
    </div>`;
  $("#s-add").onclick = () => saleModal();
  $$("[data-ship]").forEach(b => b.onclick = () => shipModal(items.find(x => x.id == b.dataset.ship)));
  $$("[data-del]").forEach(b => b.onclick = async () => {
    if (!(await confirmDlg("确定删除这条销售记录吗？对应成品会返还库存。"))) return;
    try { await api(`/api/sales/${b.dataset.del}`, "DELETE"); toast("已删除，库存已返还"); refresh(); }
    catch (e) { toast(e.message, false); }
  });
  if (sessionStorage.getItem("autoNew") === "sales") {
    sessionStorage.removeItem("autoNew");
    saleModal();
  }
};

function shipModal(s) {
  const m = openModal({
    title: `发货 · ${s.items.map(x => `${x.name}×${num(x.qty)}`).join("，")}`,
    body: `
      <div class="field"><label>快递单号</label><input id="sh-no" value="${h(s.tracking_no || "")}" placeholder="如：SF1234567890"></div>
      <div class="field" style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" id="sh-done" ${s.ship_status === "shipped" ? "checked" : ""}>
        <label for="sh-done" style="font-size:13.5px;color:var(--ink)">标记为已发货</label></div>`,
    footer: `<button class="btn primary" id="sh-save">保存</button>`,
  });
  bindSave($("#sh-save", m.el), async () => {
    await api(`/api/sales/${s.id}/ship`, "POST", {
      tracking_no: $("#sh-no", m.el).value,
      ship_status: $("#sh-done", m.el).checked ? "shipped" : "pending",
    });
    m.close(); toast("发货状态已更新"); refresh();
  });
}

async function saleModal() {
  const { items: products } = await api("/api/products");
  const m = openModal({
    title: "新增销售",
    body: `
      <div class="form-row">
        <div class="field"><label>渠道</label><select id="sa-ch">${CHANNELS.map(c => `<option>${c}</option>`).join("")}</select></div>
        <div class="field"><label>买家（选填）</label><input id="sa-buyer" placeholder="闲鱼昵称"></div>
      </div>
      <div class="field"><label>售出商品</label>
        <div id="sa-rows"></div>
        <div><button class="btn small" id="sa-addrow">＋ 添加商品</button></div>
      </div>
      <div class="form-row">
        <div class="field"><label>运费收入（元）</label><input id="sa-ship" type="number" step="any" value="0"></div>
        <div class="field"><label>优惠 / 抹零（元）</label><input id="sa-disc" type="number" step="any" value="0"></div>
      </div>
      <div class="field"><label>备注</label><input id="sa-note"></div>
      <div style="background:#f8fafc;border-radius:10px;padding:10px 14px;font-size:13.5px;line-height:1.9">
        商品合计 <b id="sa-sum">¥0.00</b>　实收 <b id="sa-total" style="color:var(--brand)">¥0.00</b><br>
        商品成本 <span id="sa-cost">¥0.00</span>　预计利润 <b id="sa-profit">¥0.00</b>
      </div>`,
    footer: `<button class="btn primary" id="sa-save">记录销售</button>`,
  });
  const box = $("#sa-rows", m.el);
  if (!products.length) box.innerHTML = `<div style="color:var(--bad);font-size:13px;margin-bottom:6px">还没有成品库存——先去「打印任务」完成一个任务，或到成品里手动添加。</div>`;
  const costMap = {};
  products.forEach(p => costMap[p.id] = p.cost);
  const addRow = () => {
    const row = document.createElement("div");
    row.className = "s-row";
    row.style.cssText = "display:grid;grid-template-columns:2fr 70px 90px auto;gap:6px;margin-bottom:6px;align-items:center";
    row.innerHTML = `
      <select class="s-pid">${products.map(p => `<option value="${p.id}">${h(p.name)}（库存${num(p.stock)}）</option>`).join("")}</select>
      <input class="s-qty" type="number" step="any" min="1" value="1" title="数量">
      <input class="s-price" type="number" step="any" placeholder="单价" title="单价">
      <button class="btn small ghost s-del">✕</button>`;
    box.appendChild(row);
    const p0 = products.find(p => p.id == $(".s-pid", row).value);
    if (p0) $(".s-price", row).value = p0.price || "";
    $(".s-pid", row).onchange = () => {
      const p = products.find(x => x.id == $(".s-pid", row).value);
      if (p) $(".s-price", row).value = p.price || "";
      recompute();
    };
    $(".s-qty", row).oninput = recompute;
    $(".s-price", row).oninput = recompute;
    $(".s-del", row).onclick = () => { row.remove(); recompute(); };
  };
  const recompute = () => {
    let sum = 0, cost = 0;
    $$(".s-row", box).forEach(row => {
      const qty = +$(".s-qty", row).value || 0;
      sum += qty * (+$(".s-price", row).value || 0);
      cost += qty * (costMap[$(".s-pid", row).value] || 0);
    });
    const ship = +$("#sa-ship", m.el).value || 0;
    const disc = +$("#sa-disc", m.el).value || 0;
    const total = sum + ship - disc;
    $("#sa-sum", m.el).textContent = money(sum);
    $("#sa-total", m.el).textContent = money(total);
    $("#sa-cost", m.el).textContent = money(cost);
    const profitEl = $("#sa-profit", m.el);
    profitEl.textContent = money(total - cost);
    profitEl.style.color = total - cost >= 0 ? "var(--ok)" : "var(--bad)";
  };
  $("#sa-addrow", m.el).onclick = addRow;
  if (products.length) addRow();
  $("#sa-ship", m.el).oninput = recompute;
  $("#sa-disc", m.el).oninput = recompute;
  recompute();
  bindSave($("#sa-save", m.el), async () => {
    const items = $$(".s-row", box).map(row => ({
      product_id: +$(".s-pid", row).value,
      qty: $(".s-qty", row).value,
      unit_price: $(".s-price", row).value,
    })).filter(x => x.product_id);
    // 预检库存，缺货时询问是否按预售接单
    const payload = {
      channel: $("#sa-ch", m.el).value,
      buyer: $("#sa-buyer", m.el).value,
      shipping: $("#sa-ship", m.el).value,
      discount: $("#sa-disc", m.el).value,
      note: $("#sa-note", m.el).value,
      items,
    };
    const lackItem = items.find(x => {
      const p = products.find(pp => pp.id === x.product_id);
      return p && (+x.qty) > p.stock + 1e-9;
    });
    // 售价漏填防线：0 元卖出是常见手滑
    const noPrice = items.find(x => !(+x.unit_price));
    if (noPrice) {
      const p = products.find(pp => pp.id === noPrice.product_id);
      const okGo = await confirmDlg(`「${p ? p.name : "商品"}」还没填售价，按 0 元记录吗？\n（利润会算成亏损，建议先填单价）`);
      if (!okGo) return;
    }
    if (lackItem) {
      const p = products.find(pp => pp.id === lackItem.product_id);
      const okGo = await confirmDlg(
        `「${p.name}」库存不足（剩 ${num(p.stock)} 件）。\n按「预售」记录吗？将进入欠货清单，打印入库后自动冲销。`);
      if (!okGo) return;
      payload.allow_backorder = true;
    }
    const r = await api("/api/sales", "POST", payload);
    m.close(); toast(`成交！利润 ${money(r.profit)} 🎉`); refresh();
  });
}

/* ================= 经营分析 ================= */
PAGES.analytics = async function pageAnalytics() {
  const a = await api("/api/analytics");
  const maxM = Math.max(...a.months.map(x => Math.max(x.sales, x.purchase)), 1);
  const trend = a.months.map(x => `
    <div style="flex:1;text-align:center;min-width:0">
      <div style="height:110px;display:flex;align-items:flex-end;justify-content:center;gap:3px">
        <div title="销售 ${money(x.sales)}" style="width:15px;height:${Math.max(x.sales / maxM * 100, 2)}%;background:linear-gradient(180deg,#fb923c,#ea580c);border-radius:4px 4px 0 0"></div>
        <div title="采购 ${money(x.purchase)}" style="width:15px;height:${Math.max(x.purchase / maxM * 100, 2)}%;background:#94a3b8;border-radius:4px 4px 0 0"></div>
      </div>
      <div style="font-size:11.5px;color:var(--muted);margin-top:4px">${h(x.month)}</div>
      <div style="font-size:11.5px;font-weight:700;color:var(--ok)">${x.profit > 0 ? money(x.profit) : "&nbsp;"}</div>
    </div>`).join("");
  const maxRev = Math.max(...a.top.map(x => x.revenue), 1);
  const topRows = a.top.length ? a.top.map((x, i) => `
    <div style="margin-bottom:11px">
      <div style="display:flex;font-size:13px;gap:8px"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i + 1}. <b>${h(x.name)}</b></span>
        <span style="color:var(--muted);white-space:nowrap">${num(x.qty)} 件 · ${money(x.revenue)}</span></div>
      <div style="height:8px;background:#f1f5f9;border-radius:99px;margin-top:4px;overflow:hidden">
        <div style="width:${Math.max(x.revenue / maxRev * 100, 1)}%;height:100%;background:linear-gradient(90deg,#fb923c,#ea580c)"></div></div>
    </div>`).join("") : `<div class="empty" style="padding:12px">还没有销售数据</div>`;
  const chTotal = Math.max(a.channels.reduce((s, c) => s + c.amount, 0), 1);
  const chRows = a.channels.length ? a.channels.map(c => `
    <div style="margin-bottom:11px">
      <div style="display:flex;font-size:13px;gap:8px"><span style="flex:1"><b>${h(c.channel)}</b> ×${c.n} 单</span>
        <span style="color:var(--muted);white-space:nowrap">${money(c.amount)} · 利润 ${money(c.profit)}</span></div>
      <div style="height:8px;background:#f1f5f9;border-radius:99px;margin-top:4px;overflow:hidden">
        <div style="width:${Math.max(c.amount / chTotal * 100, 1)}%;height:100%;background:#2563eb"></div></div>
    </div>`).join("") : `<div class="empty" style="padding:12px">还没有数据</div>`;
  $("#app").innerHTML = `
    <div class="grid cols4">
      <div class="stat brand"><div class="label">累计销售</div><div class="value">${money(a.sales_total)}</div><div class="sub">全部渠道合计</div></div>
      <div class="stat"><div class="label">累计利润</div><div class="value profit-pos">${money(a.profit_total)}</div><div class="sub">毛利率 ${num(a.margin)}%</div></div>
      <div class="stat"><div class="label">打印成品 / 废件</div><div class="value">${num(a.done_total)} <span style="font-size:14px;color:var(--muted)">/ ${num(a.fail_total)}</span></div><div class="sub">废件率 ${num(a.fail_rate)}%</div></div>
      <div class="stat"><div class="label">累计打印时长</div><div class="value">${num(a.hours_total)}h</div><div class="sub">完成 ${a.jobs_done} 个任务</div></div>
    </div>
    <div class="grid cols2" style="margin-top:14px">
      <div class="card">
        <h2>📈 近 6 个月趋势
          <span class="right" style="font-size:12px;font-weight:400;color:var(--muted)">
            <span style="display:inline-block;width:10px;height:10px;background:#ea580c;border-radius:3px"></span> 销售
            <span style="display:inline-block;width:10px;height:10px;background:#94a3b8;border-radius:3px;margin-left:6px"></span> 采购
          </span></h2>
        <div style="display:flex;gap:6px;align-items:flex-end">${trend}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:8px">柱下绿色数字为当月利润</div>
      </div>
      <div class="card">
        <h2>🏆 畅销商品排行（按销售额）</h2>
        ${topRows}
      </div>
      <div class="card">
        <h2>🛒 渠道占比</h2>
        ${chRows}
      </div>
      <div class="card">
        <h2>💡 经营小结</h2>
        <div style="font-size:13.5px;line-height:2.1">
          ${a.top.length ? `· 最能打的是「<b>${h(a.top[0].name)}</b>」，卖了 ${num(a.top[0].qty)} 件，贡献 ${money(a.top[0].revenue)}<br>` : ""}
          ${a.channels.length ? `· ${num(a.margin)}% 的毛利率${a.margin < 50 ? "，偏薄，建议用「定价计算」复核售价" : "，保持得不错"}<br>` : ""}
          ${a.fail_rate > 15 ? `· ⚠️ 废件率 ${num(a.fail_rate)}% 偏高，检查耗材质量和打印参数<br>` : (a.done_total ? `· 废件率 ${num(a.fail_rate)}%，控制得不错<br>` : "")}
          · 每次完成任务都会自动记成本，月底看这张页就知道赚没赚
        </div>
      </div>
    </div>`;
};

/* ================= 模型收藏 ================= */
const SITES = [
  { name: "MakerWorld", cls: "brand", url: kw => `https://makerworld.com/zh/find?q=${encodeURIComponent(kw)}` },
  { name: "Printables", cls: "info", url: kw => `https://www.printables.com/search/models?q=${encodeURIComponent(kw)}` },
  { name: "Thingiverse", cls: "gray", url: kw => `https://www.thingiverse.com/search?q=${encodeURIComponent(kw)}` },
  { name: "Cults3D", cls: "warn", url: kw => `https://cults3d.com/en/search?q=${encodeURIComponent(kw)}` },
  { name: "Thangs", cls: "gray", url: kw => `https://thangs.com/search?q=${encodeURIComponent(kw)}` },
  { name: "Yeggi 聚合", cls: "gray", url: kw => `https://www.yeggi.com/q/${encodeURIComponent(kw)}/` },
];
const TOOLS = [
  { name: " Blender", url: "https://www.blender.org/" },
  { name: "Tinkercad", url: "https://www.tinkercad.com/" },
  { name: "Onshape", url: "https://www.onshape.com/" },
  { name: "Fusion 360", url: "https://www.autodesk.com.cn/products/fusion-360/overview" },
];
const HOT_LINKS = [
  { name: "MakerWorld 国内站", url: "https://makerworld.com.cn/zh/3d-models" },
  { name: "MakerWorld 排行榜", url: "https://makerworld.com/zh/leaderboards" },
  { name: "Printables 热门", url: "https://www.printables.com/models" },
  { name: "Thingiverse 热门", url: "https://www.thingiverse.com/search?things%5Bsort%5D=popular" },
  { name: "Cults3D", url: "https://cults3d.com/en" },
  { name: "Yeggi 聚合", url: "https://www.yeggi.com/" },
];
const AI_TOOLS = [
  { name: "混元3D（腾讯）", url: "https://3d.hunyuan.tencent.com/" },
  { name: "TRELLIS（微软）", url: "https://huggingface.co/spaces/JeffreyXiang/TRELLIS" },
  { name: "Tripo", url: "https://www.tripo3d.ai/" },
  { name: "Meshy", url: "https://www.meshy.ai/" },
];
const M_STATUS = [["want", "想打"], ["printing", "打印中"], ["listed", "已上架"], ["dropped", "放弃"]];
const M_CLS = { want: "st-want", printing: "st-printing", listed: "st-listed", dropped: "st-dropped" };

PAGES.models = async function pageModels() {
  const f = F.models;
  const qs = [];
  if (f.status) qs.push(`status=${f.status}`);
  if (f.q) qs.push(`q=${encodeURIComponent(f.q)}`);
  const [{ items: models }, { items: ideas }] = await Promise.all([
    api("/api/models" + (qs.length ? "?" + qs.join("&") : "")),
    api("/api/ideas"),
  ]);
  const cards = models.map(x => {
    const img = x.image_url
      ? `<img src="${h(x.image_url)}" onerror="this.remove()" alt="">`
      : "🧊";
    return `<div class="model-card">
      <div class="img">${img}<span class="src"><span class="chip gray">${h(x.source)}</span></span></div>
      <div class="body">
        <div class="title"><a href="${h(x.url)}" target="_blank" rel="noopener">${h(x.title)}</a></div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="chip ${M_CLS[x.status] || "gray"}">${h(x.status_label)}</span>
          <span class="stars" title="评分">${"★".repeat(x.rating)}<span class="off">${"★".repeat(5 - x.rating)}</span></span>
        </div>
        ${x.tags ? `<div class="tags">标签：${h(x.tags)}</div>` : ""}
        ${x.note ? `<div class="note">${h(x.note)}</div>` : ""}
        <div class="acts">
          <select class="m-st small" data-id="${x.id}" style="padding:3px 6px;font-size:12px">
            ${M_STATUS.map(([v, l]) => `<option value="${v}" ${x.status === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          <span style="flex:1"></span>
          <button class="btn small ghost" data-edit="${x.id}" title="编辑">✏️</button>
          <button class="btn small ghost danger" data-del="${x.id}" title="删除">🗑</button>
        </div>
      </div>
    </div>`;
  }).join("");
  const ideaHtml = ideas.map(i => `<div class="idea-item ${i.done ? "done" : ""}">
      <input type="checkbox" data-idea="${i.id}" ${i.done ? "checked" : ""}>
      <span>${h(i.content)}</span>
      <button class="btn small ghost danger" data-ideadel="${i.id}">✕</button>
    </div>`).join("")
    || `<div class="empty" style="padding:10px">记下想做的原创模型点子…</div>`;
  $("#app").innerHTML = `
    <div class="card">
      <h2>🌍 全网搜模型 <span class="right" style="font-size:12px;color:var(--muted)">输入关键词，去各模型站搜索</span></h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <input type="text" id="ms-kw" placeholder="如： articulated dragon / 龙年摆件" style="flex:1;min-width:180px">
      </div>
      <div class="site-btns">
        ${SITES.map((s, i) => `<button class="btn small" data-site="${i}">🔍 ${s.name}</button>`).join("")}
        <button class="btn small primary" id="ms-all">🚀 全部打开</button>
      </div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--line);display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span style="font-size:12.5px;color:var(--muted)">🔥 逛热门挑货：</span>
        ${HOT_LINKS.map(t => `<a class="btn small" href="${t.url}" target="_blank" rel="noopener">${t.name}</a>`).join("")}
      </div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span style="font-size:12.5px;color:var(--muted)">🤖 AI 直接生成模型（图生3D）：</span>
        ${AI_TOOLS.map(t => `<a class="btn small" href="${t.url}" target="_blank" rel="noopener">${t.name}</a>`).join("")}
      </div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span style="font-size:12.5px;color:var(--muted)">✍️ 自己建模：</span>
        ${TOOLS.map(t => `<a class="btn small" href="${t.url}" target="_blank" rel="noopener">${t.name}</a>`).join("")}
      </div>
    </div>
    <div class="card">
      <h2>🔥 站内刷模型 · Printables <span class="chip gray" style="font-weight:400">实验性</span>
        <span class="right"><button class="btn small" id="hot-refresh">🔄 刷新</button></span></h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <input type="text" id="hot-kw" placeholder="搜关键词，如 dragon / 收纳 / 龙年" style="flex:1;min-width:160px">
        <select id="hot-order">
          <option value="popular">🔥 最热门</option>
          <option value="latest">🆕 最新发布</option>
          <option value="rating">⭐ 评分最高</option>
          <option value="makes_count">🏆 最多人做</option>
        </select>
        <button class="btn small primary" id="hot-go">搜一下</button>
      </div>
      <div id="hot-box"><div class="empty" style="padding:12px">点「搜一下」看当下最火的模型（不填关键词=总热榜），喜欢就一键收藏</div></div>
    </div>
    <div class="toolbar">
      ${[["", "全部"], ...M_STATUS].map(([v, l]) =>
        `<button class="btn small ${f.status === v ? "primary" : ""}" data-fst="${v}">${l}</button>`).join("")}
      <input type="search" id="ms-q" placeholder="🔍 搜索收藏" value="${h(f.q)}">
      <span class="spacer"></span>
      <button class="btn primary" id="ml-add">＋ 添加模型收藏</button>
    </div>
    ${models.length ? `<div class="model-grid">${cards}</div>`
      : `<div class="card"><div class="empty"><div class="big">🌐</div>还没有收藏的模型<br>
         <span style="font-size:13px">在上方搜索模型，或把模型链接收藏进来～</span></div></div>`}
    <div class="card">
      <h2>💡 建模点子板</h2>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input type="text" id="idea-input" placeholder="想做什么原创模型？记下来…" style="flex:1">
        <button class="btn" id="idea-add">＋ 记录</button>
      </div>
      ${ideaHtml}
    </div>`;
  // 搜索跳转
  const kw = () => $("#ms-kw").value.trim();
  $$("[data-site]").forEach(b => b.onclick = () => {
    const k = kw();
    if (!k) return toast("先输入关键词哦", false);
    window.open(SITES[+b.dataset.site].url(k), "_blank");
  });
  $("#ms-all").onclick = () => {
    const k = kw();
    if (!k) return toast("先输入关键词哦", false);
    let blocked = false;
    SITES.forEach(s => { const w = window.open(s.url(k), "_blank"); if (!w) blocked = true; });
    if (blocked) toast("部分弹窗被浏览器拦截，可逐个点击站点按钮", false);
  };
  $("#ms-kw").addEventListener("keydown", e => { if (e.key === "Enter") $("#ms-all").click(); });
  // Printables 站内搜索（实验性：社区接口，失效自动提示降级）
  const loadHot = async force => {
    const box = $("#hot-box");
    if (!box) return;
    const kw = ($("#hot-kw")?.value || "").trim();
    const ordering = $("#hot-order")?.value || "popular";
    box.innerHTML = `<div class="empty" style="padding:14px">⏳ 正在从 Printables ${kw ? `搜索「${h(kw)}」` : "拉取热门模型"}…</div>`;
    try {
      const r = await api(`/api/hot?limit=12&ordering=${encodeURIComponent(ordering)}`
        + (kw ? `&q=${encodeURIComponent(kw)}` : "") + (force ? "&force=1" : ""));
      if (r.error) {
        box.innerHTML = `<div class="empty" style="padding:14px;font-size:13px">😕 ${h(r.error)}</div>`;
        return;
      }
      if (!r.items.length) {
        box.innerHTML = `<div class="empty" style="padding:14px">没有找到数据，换个关键词试试，或用「逛热门」直达网页</div>`;
        return;
      }
      box.innerHTML = `
        <div class="hot-grid">${r.items.map(x => `
          <div class="hot-card">
            <div class="img">${x.image ? `<img src="${LOCAL_MODE ? h(x.image) : "/api/thumb?u=" + encodeURIComponent(x.image)}" loading="lazy" onerror="this.style.display='none'">` : "🧊"}</div>
            <div class="nm" title="${h(x.name)}">${h(x.name)}</div>
            <div class="meta">❤️ ${num(x.likes)} · 📥 ${num(x.downloads)}</div>
            <div class="acts">
              <a class="btn small ghost" href="${h(x.url)}" target="_blank" rel="noopener" title="打开原页面">🌐</a>
              <span style="flex:1"></span>
              <button class="btn small primary" data-collect="${h(x.url)}" data-name="${h(x.name)}" data-img="${h(x.image || "")}">＋收藏</button>
            </div>
          </div>`).join("")}
        </div>
        <div style="margin-top:8px;font-size:12px;color:var(--muted)">数据来自 Printables 社区接口（30 分钟缓存）；失效时会提示，届时用上方「逛热门」直达网页即可。</div>`;
      $$("[data-collect]", box).forEach(b => b.onclick = async () => {
        try {
          await api("/api/models", "POST", {
            title: b.dataset.name, url: b.dataset.collect, image_url: b.dataset.img,
            source: "Printables", status: "want",
          });
          b.textContent = "已收藏 ✓";
          b.disabled = true;
          toast(`「${b.dataset.name}」已加入收藏`);
        } catch (e) { toast(e.message, false); }
      });
    } catch (e) {
      box.innerHTML = `<div class="empty" style="padding:14px">😕 ${h(e.message)}</div>`;
    }
  };
  $("#hot-refresh").onclick = () => loadHot(true);
  $("#hot-go").onclick = () => loadHot(false);
  $("#hot-kw").addEventListener("keydown", e => { if (e.key === "Enter") $("#hot-go").click(); });
  // 筛选
  $$("[data-fst]").forEach(b => b.onclick = () => { f.status = b.dataset.fst; refresh(); });
  let qt; $("#ms-q").oninput = () => { clearTimeout(qt); qt = setTimeout(() => { f.q = $("#ms-q").value.trim(); refresh(); }, 350); };
  $("#ml-add").onclick = () => modelForm(null);
  // 卡片操作
  $$("[data-edit]").forEach(b => b.onclick = () => modelForm(models.find(x => x.id == b.dataset.edit)));
  $$("[data-del]").forEach(b => b.onclick = async () => {
    const x = models.find(m => m.id == b.dataset.del);
    if (!(await confirmDlg(`取消收藏「${x.title}」吗？`))) return;
    try { await api(`/api/models/${x.id}`, "DELETE"); toast("已删除"); refresh(); }
    catch (e) { toast(e.message, false); }
  });
  $$(".m-st").forEach(sel => sel.onchange = async () => {
    const x = models.find(m => m.id == sel.dataset.id);
    try {
      await api(`/api/models/${x.id}`, "PUT", { ...x, status: sel.value });
      toast(`「${x.title}」→ ${sel.selectedOptions[0].text}`);
      refresh();
    } catch (e) { toast(e.message, false); }
  });
  // 点子板
  $("#idea-add").onclick = async () => {
    const val = $("#idea-input").value.trim();
    if (!val) return;
    try { await api("/api/ideas", "POST", { content: val }); toast("已记录 💡"); refresh(); }
    catch (e) { toast(e.message, false); }
  };
  $("#idea-input").addEventListener("keydown", e => { if (e.key === "Enter") $("#idea-add").click(); });
  $$("[data-idea]").forEach(cb => cb.onchange = async () => {
    try { await api(`/api/ideas/${cb.dataset.idea}`, "PUT", { done: cb.checked }); refresh(); }
    catch (e) { toast(e.message, false); }
  });
  $$("[data-ideadel]").forEach(b => b.onclick = async () => {
    try { await api(`/api/ideas/${b.dataset.ideadel}`, "DELETE"); refresh(); }
    catch (e) { toast(e.message, false); }
  });
  if (sessionStorage.getItem("autoNew") === "models") {
    sessionStorage.removeItem("autoNew");
    modelForm(null);
  }
};

function modelForm(model) {
  const isEdit = !!model;
  const d = model || { status: "want", rating: 0 };
  const m = openModal({
    title: isEdit ? "编辑模型收藏" : "添加模型收藏",
    body: `
      <div class="field"><label>模型链接 *</label>
        <div style="display:flex;gap:6px">
          <input id="mo-url" value="${h(d.url || "")}" placeholder="粘贴 MakerWorld / Printables / Thingiverse … 链接" style="flex:1">
          <button class="btn small" id="mo-fetch" title="尝试自动获取名称和封面图">🔍 自动获取</button>
        </div></div>
      <div class="field"><label>名称 *</label><input id="mo-title" value="${h(d.title || "")}"></div>
      <div class="field"><label>图片链接（选填）</label><input id="mo-img" value="${h(d.image_url || "")}" placeholder="右键模型图片 → 复制图片地址"></div>
      <div class="form-row">
        <div class="field"><label>状态</label><select id="mo-status">
          ${M_STATUS.map(([v, l]) => `<option value="${v}" ${d.status === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label>评分</label><div class="stars" id="mo-rating" data-val="${d.rating || 0}">
          ${[1, 2, 3, 4, 5].map(i => `<span data-i="${i}" class="${i <= (d.rating || 0) ? "" : "off"}">★</span>`).join("")}</div></div>
      </div>
      <div class="field"><label>标签（逗号分隔）</label><input id="mo-tags" value="${h(d.tags || "")}" placeholder="如：龙, articulated, 摆件"></div>
      <div class="field"><label>备注</label><input id="mo-note" value="${h(d.note || "")}" placeholder="如：用 PETG 打更结实 / 已上架闲鱼¥29.9"></div>`,
    footer: `<button class="btn primary" id="mo-save">保存</button>`,
  });
  const starBox = $("#mo-rating", m.el);
  starBox.onclick = e => {
    const sp = e.target.closest("[data-i]");
    if (!sp) return;
    starBox.dataset.val = sp.dataset.i;
    $$("span", starBox).forEach(x => x.classList.toggle("off", +x.dataset.i > +sp.dataset.i));
  };
  $("#mo-fetch", m.el).onclick = async () => {
    const url = $("#mo-url", m.el).value.trim();
    if (!url) return toast("先粘贴链接哦", false);
    toast("正在获取名称和封面…");
    try {
      const r = await api("/api/models/fetch-title", "POST", { url });
      if (r.title) { $("#mo-title", m.el).value = r.title; toast("已自动填写 ✓"); }
      else toast("没能自动获取，请手动填写", false);
      if (r.image && !$("#mo-img", m.el).value) $("#mo-img", m.el).value = r.image;
    } catch (e) { toast(e.message, false); }
  };
  bindSave($("#mo-save", m.el), async () => {
    const body = {
      url: $("#mo-url", m.el).value,
      title: $("#mo-title", m.el).value,
      image_url: $("#mo-img", m.el).value,
      status: $("#mo-status", m.el).value,
      rating: starBox.dataset.val,
      tags: $("#mo-tags", m.el).value,
      note: $("#mo-note", m.el).value,
    };
    if (isEdit) await api(`/api/models/${model.id}`, "PUT", body);
    else await api("/api/models", "POST", body);
    m.close(); toast("已收藏 🌐"); refresh();
  });
}

/* ================= 定价计算 ================= */
PAGES.calc = async function pageCalc() {
  const [{ items: mats }, { items: printers }] = await Promise.all([
    api("/api/materials"), api("/api/printers"),
  ]);
  const filMats = mats.filter(x => x.category === "耗材" && !x.archived);
  const S = SETTINGS;
  $("#app").innerHTML = `
    <div class="calc-grid">
      <div class="card">
        <h2>🧮 成本计算</h2>
        <div class="form-row">
          <div class="field"><label>选择材料</label><select id="ca-mat">
            <option value="">手动输入单价</option>
            ${filMats.map(x => `<option value="${x.id}" data-p="${x.unit_price}">${h(x.name)}（${num(x.unit_price)} 元/克）</option>`).join("")}</select></div>
          <div class="field"><label>单价（元/克）</label><input id="ca-price" type="number" step="any" value="0.02"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>克重（g）</label><input id="ca-g" type="number" step="any" value="50"></div>
          <div class="field"><label>打印时长（小时）</label><input id="ca-h" type="number" step="any" value="3"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>打印机</label><select id="ca-printer">
            <option value="">手动输入功率</option>
            ${printers.map(p => `<option value="${p.id}" data-w="${p.power_w}">${h(p.name)}</option>`).join("")}</select></div>
          <div class="field"><label>功率（W）</label><input id="ca-w" type="number" step="any" value="${h(S.default_power || 120)}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>电价（元/度）</label><input id="ca-e" type="number" step="any" value="${h(S.electricity_price || 0.6)}"></div>
          <div class="field"><label>机时费（元/小时）</label><input id="ca-m" type="number" step="any" value="${h(S.machine_rate || 0)}"></div>
          <div class="field"><label>人工 / 打磨包装（元）</label><input id="ca-l" type="number" step="any" value="0"></div>
          <div class="field"><label>损耗率（%）</label><input id="ca-loss" type="number" step="any" value="${h(S.loss_rate || 0)}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>包装 / 运费成本（元）</label><input id="ca-pack" type="number" step="any" value="0"></div>
          <div class="field"><label>目标利润率（%）</label><input id="ca-margin" type="number" step="any" value="100"></div>
        </div>
        <p style="color:var(--muted);font-size:12.5px;line-height:1.7">💡 电价、机时费、损耗率可在右上角「⚙️ 设置」里改成默认值。损耗率按打印失败概率折算，新手建议 10~20%。</p>
      </div>
      <div class="card">
        <h2>💰 结果</h2>
        <div class="calc-line"><span>材料费</span><b id="r-mat">¥0.00</b></div>
        <div class="calc-line"><span>电费</span><b id="r-e">¥0.00</b></div>
        <div class="calc-line"><span>机时费</span><b id="r-mch">¥0.00</b></div>
        <div class="calc-line"><span>人工</span><b id="r-l">¥0.00</b></div>
        <div class="calc-line"><span>包装 / 运费</span><b id="r-pack">¥0.00</b></div>
        <div class="calc-line"><span>损耗（<span id="r-lossp"></span>%）</span><b id="r-loss">¥0.00</b></div>
        <div class="calc-line total"><span>成本合计</span><b id="r-total">¥0.00</b></div>
        <div class="calc-line"><span>建议售价（利润 <span id="r-marginp"></span>%）</span><b id="r-price0">¥0.00</b></div>
        <div class="calc-price" id="r-price">¥0.00</div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <button class="btn small" id="r-99">取整到 x.9</button>
          <button class="btn small" id="r-int">进位取整</button>
          <button class="btn small primary" id="r-copy">复制售价</button>
        </div>
      </div>
    </div>`;
  const val = id => +$(id).value || 0;
  let lastPrice = 0;
  const compute = () => {
    const matC = val("#ca-g") * val("#ca-price");
    const eC = val("#ca-w") / 1000 * val("#ca-h") * val("#ca-e");
    const mC = val("#ca-h") * val("#ca-m");
    const lC = val("#ca-l");
    const packC = val("#ca-pack");
    const base = matC + eC + mC + lC + packC;
    const lossC = base * val("#ca-loss") / 100;
    const total = base + lossC;
    const price = total * (1 + val("#ca-margin") / 100);
    $("#r-mat").textContent = money(matC);
    $("#r-e").textContent = money(eC);
    $("#r-mch").textContent = money(mC);
    $("#r-l").textContent = money(lC);
    $("#r-pack").textContent = money(packC);
    $("#r-lossp").textContent = num(val("#ca-loss"));
    $("#r-loss").textContent = money(lossC);
    $("#r-total").textContent = money(total);
    $("#r-marginp").textContent = num(val("#ca-margin"));
    $("#r-price0").textContent = money(price);
    lastPrice = price;
    $("#r-price").textContent = money(price);
  };
  $$("#app input, #app select").forEach(el => {
    el.addEventListener("input", () => {
      if (el.id === "ca-mat") {
        const p = el.selectedOptions[0]?.dataset.p;
        if (p !== undefined && p !== "") $("#ca-price").value = p;
      }
      if (el.id === "ca-printer") {
        const w = el.selectedOptions[0]?.dataset.w;
        if (w) $("#ca-w").value = w;
      }
      compute();
    });
  });
  compute();
  $("#r-99").onclick = () => {
    const v = Math.ceil(lastPrice) - 0.1;
    const p = v >= lastPrice ? v : v + 1;
    $("#r-price").textContent = money(p);
    lastPrice = p;
  };
  $("#r-int").onclick = () => {
    lastPrice = Math.ceil(lastPrice);
    $("#r-price").textContent = money(lastPrice);
  };
  $("#r-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText((Math.round(lastPrice * 100) / 100).toFixed(2));
      toast("已复制：" + money(lastPrice));
    } catch (e) { toast("复制失败，请手动记录", false); }
  };
};

/* ================= 全站流水 ================= */
PAGES.logs = async function pageLogs() {
  const f = F.logs;
  const { items } = await api("/api/logs?limit=300" + (f.module ? `&module=${encodeURIComponent(f.module)}` : ""));
  const rows = items.map(l => `<tr>
    <td style="white-space:nowrap">${h(l.ts)}</td>
    <td><span class="chip gray">${h(l.module)}</span></td>
    <td style="white-space:nowrap"><b>${h(l.action)}</b></td>
    <td style="color:var(--muted)">${h(l.detail)}</td></tr>`).join("");
  $("#app").innerHTML = `
    <div class="toolbar">
      <select id="lg-module">
        ${["", "物料", "采购", "打印", "成品", "销售", "模型", "点子", "设置", "系统"].map(v =>
          `<option value="${v}" ${f.module === v ? "selected" : ""}>${v || "全部模块"}</option>`).join("")}
      </select>
      <span style="color:var(--muted);font-size:13px">所有操作都会自动记录在这里</span>
      <span class="spacer"></span>
      <details style="position:relative">
        <summary class="btn small" style="list-style:none">📤 导出 CSV</summary>
        <div style="position:absolute;right:0;background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:4px;z-index:30;box-shadow:var(--shadow)">
          ${Object.keys({
    materials: 1, purchases: 1, stock_movements: 1, print_jobs: 1,
    products: 1, sales: 1, model_links: 1, operation_log: 1,
  }).map(t => `<button class="btn small" data-export="${t}" style="justify-content:flex-start">${t}</button>`).join("")}
        </div>
      </details>
    </div>
    <div class="card table-wrap">
      ${items.length ? `<table>
        <thead><tr><th>时间</th><th>模块</th><th>动作</th><th>详情</th></tr></thead>
        <tbody>${rows}</tbody></table>`
      : `<div class="empty">暂无记录</div>`}
    </div>`;
  $("#lg-module").onchange = e => { f.module = e.target.value; refresh(); };
  $$("[data-export]").forEach(b => b.onclick = () => {
    if (LOCAL_MODE) { window.LocalAPI.exportCSV(b.dataset.export); toast("已导出 CSV"); }
    else location.href = "/api/export/csv?table=" + b.dataset.export;
  });
};

/* ================= 启动 ================= */
async function init() {
  LOCAL_MODE = await detectLocalMode();
  $("#nav").innerHTML = NAV.map(n =>
    `<a href="#/${n.key}" data-key="${n.key}"><span>${n.icon}</span><span>${n.label}</span></a>`).join("");
  if (LOCAL_MODE) {
    const chip = document.createElement("span");
    chip.className = "chip gray";
    chip.style.cssText = "margin-left:10px;font-weight:400";
    chip.textContent = "网页版 · 数据存于本浏览器";
    chip.title = "换浏览器或清理缓存前，请在「设置」里导出数据备份";
    $("#page-title").after(chip);
    document.title = "打印小站（网页版）";
    const foot = document.querySelector("#sidebar .foot");
    if (foot) foot.innerHTML = "数据存于本浏览器<br>请在设置里导出备份";
  }
  $("#btn-backup").onclick = () => {
    if (LOCAL_MODE) { window.LocalAPI.backup(); toast("数据已导出（JSON 文件，请收好）"); }
    else { location.href = "/api/backup"; toast("正在下载数据库备份…"); }
  };
  $("#btn-manual").onclick = () => window.open(LOCAL_MODE
    ? "static/使用说明书.html"
    : "/使用说明书.html", "_blank");
  $("#btn-settings").onclick = openSettings;
  window.addEventListener("hashchange", route);
  try {
    SETTINGS = await api("/api/settings");
    $("#logo-name").textContent = SETTINGS.shop_name || "打印小站";
  } catch (e) { /* ignore */ }
  if (!location.hash) location.hash = "#/dashboard";
  route();
}

init();
