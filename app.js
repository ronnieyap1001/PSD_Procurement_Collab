// PSD Procurement Tracker — main app logic.
// Talks directly to Supabase; multi-user concurrent access is handled by
// Postgres + the realtime channel below.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

// ----- in-memory state -------------------------------------------------
const state = {
  settings: {
    projects:              [],
    request_types:         [],
    uoms:                  [],
    requestors:            [],
    creators:              [],
    brands:                [],
    vendors:               [],
    statuses:              [],
    rfq_prefix:            "RFQ",
    default_cutoff_days:   7,
    default_delivery_days: 30,
  },
  rfqs:    [],
  items:   [],
  editingRfqId: null,
};

const SETTING_LABELS = {
  projects:      "Projects",
  request_types: "Request Types",
  uoms:          "UOM",
  requestors:    "Requestors",
  creators:      "Creators",
  brands:        "Brands",
  vendors:       "Suggested Vendors",
  statuses:      "Statuses",
};

// ----- tiny helpers ----------------------------------------------------
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, kind = "ok") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  setTimeout(() => el.classList.add("hidden"), 2500);
}

function todayISO()             { return new Date().toISOString().slice(0, 10); }
function addDays(iso, days)     {
  const d = new Date(iso);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function fmtDate(v)             { return v ? String(v).slice(0, 10) : ""; }

function statusClass(status) {
  const map = {
    "Draft": "draft", "Submitted": "submitted", "Quoted": "quoted",
    "PO Issued": "po", "In Transit": "transit", "Received": "received",
    "Closed": "closed", "Cancelled": "cancelled",
  };
  return `status-pill ${map[status] || ""}`;
}

function setEnv(text, kind) {
  const pill = $("#env-pill");
  pill.textContent = text;
  pill.className = `env-pill ${kind || ""}`;
}

// ----- settings load/save ---------------------------------------------
async function loadSettings() {
  const { data, error } = await supabase.from("app_settings").select("key,value");
  if (error) throw error;
  for (const row of data) state.settings[row.key] = row.value;
  populateAllSelects();
  renderSettingsPanel();
}

async function saveSetting(key, value) {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key, value }, { onConflict: "key" });
  if (error) { toast(error.message, "error"); throw error; }
  state.settings[key] = value;
}

function populateAllSelects() {
  for (const el of $$('select[data-setting]')) {
    const key = el.dataset.setting;
    const list = state.settings[key] || [];
    const current = el.value;
    el.innerHTML = `<option value="">— select —</option>` +
      list.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    if (list.includes(current)) el.value = current;
  }
  const dl = $("#vendors-list");
  if (dl) {
    dl.innerHTML = (state.settings.vendors || [])
      .map(v => `<option value="${escapeHtml(v)}"></option>`).join("");
  }
}

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ----- tab switching ---------------------------------------------------
$$(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach(b => b.classList.toggle("active", b === btn));
    const target = btn.dataset.tab;
    $$(".panel").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== target));
    if (target === "rfq-list")  loadRfqs();
    if (target === "item-list") loadItems();
  });
});

// ----- RFQ Number generator -------------------------------------------
async function nextRfqNumber() {
  const prefix = state.settings.rfq_prefix || "RFQ";
  const d = new Date();
  const dd   = String(d.getDate()).padStart(2, "0");
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const dateKey = `${dd}${mm}${yyyy}`;
  const base = `${prefix}/${dateKey}_`;

  const { data, error } = await supabase
    .from("rfq_requests")
    .select("rfq_number")
    .ilike("rfq_number", `${base}%`);
  if (error) { toast(error.message, "error"); throw error; }

  let max = 0;
  for (const r of (data || [])) {
    const tail = r.rfq_number.slice(base.length);
    const n = parseInt(tail, 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return `${base}${String(max + 1).padStart(2, "0")}`;
}

// ----- form: items rows -----------------------------------------------
function newItemRow(idx, item = {}) {
  const tr = document.createElement("tr");
  tr.dataset.idx = idx;
  tr.innerHTML = `
    <td class="row-idx">${idx}</td>
    <td><input type="text" name="brand"        list="brands-list"   value="${escapeHtml(item.brand)}"></td>
    <td><input type="text" name="item"         value="${escapeHtml(item.item)}"></td>
    <td><input type="text" name="item_description" value="${escapeHtml(item.item_description)}"></td>
    <td><input type="number" step="any" name="quantity" value="${escapeHtml(item.quantity)}"></td>
    <td><select name="uom" data-setting="uoms"></select></td>
    <td><input type="text" name="remark" value="${escapeHtml(item.remark)}"></td>
    <td><button type="button" class="btn-ghost remove-row" title="Remove">×</button></td>
  `;
  const uomSel = tr.querySelector('select[name="uom"]');
  uomSel.innerHTML = `<option value="">—</option>` +
    (state.settings.uoms || []).map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  if (item.uom) uomSel.value = item.uom;

  tr.querySelector(".remove-row").addEventListener("click", () => {
    tr.remove();
    reindexItems();
  });
  return tr;
}

function reindexItems() {
  $$("#items-body tr").forEach((tr, i) => {
    tr.dataset.idx = i + 1;
    tr.querySelector(".row-idx").textContent = i + 1;
  });
}

function ensureBrandsDatalist() {
  let dl = document.getElementById("brands-list");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "brands-list";
    document.body.appendChild(dl);
  }
  dl.innerHTML = (state.settings.brands || [])
    .map(v => `<option value="${escapeHtml(v)}"></option>`).join("");
}

// ----- form lifecycle --------------------------------------------------
async function resetForm({ keepNumber = false } = {}) {
  state.editingRfqId = null;
  $("#form-title").textContent = "Create RFQ Request";
  $("#submit-btn").textContent = "Submit RFQ";
  $("#rfq-id").value = "";

  const today = todayISO();
  $("#creation-date").value         = today;
  $("#cutoff-date").value           = addDays(today, state.settings.default_cutoff_days);
  $("#request-delivery-date").value = addDays(today, state.settings.default_delivery_days);
  $("#description").value = "";
  $("#note").value = "";
  $("#suggest-vendor").value = "";
  $("#project").value = "";
  $("#requestor").value = "";
  $("#creator").value = "";
  $("#request-type").value = "";

  $("#items-body").innerHTML = "";
  $("#items-body").appendChild(newItemRow(1));

  if (!keepNumber) {
    $("#rfq-number").value = await nextRfqNumber();
  }
  ensureBrandsDatalist();
}

$("#add-item").addEventListener("click", () => {
  const idx = $$("#items-body tr").length + 1;
  $("#items-body").appendChild(newItemRow(idx));
});

$("#reset-form").addEventListener("click", () => resetForm());

$("#rfq-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = $("#submit-btn");
  submitBtn.disabled = true;

  try {
    const header = {
      rfq_number:            $("#rfq-number").value.trim(),
      creation_date:         $("#creation-date").value,
      description:           $("#description").value.trim() || null,
      project:               $("#project").value || null,
      cutoff_date:           $("#cutoff-date").value || null,
      request_delivery_date: $("#request-delivery-date").value || null,
      requestor:             $("#requestor").value || null,
      creator:               $("#creator").value || null,
      request_type:          $("#request-type").value || null,
      suggest_vendor:        $("#suggest-vendor").value.trim() || null,
      note:                  $("#note").value.trim() || null,
    };

    const items = $$("#items-body tr").map((tr, i) => ({
      line_index:       i + 1,
      brand:            tr.querySelector('[name="brand"]').value.trim() || null,
      item:             tr.querySelector('[name="item"]').value.trim() || null,
      item_description: tr.querySelector('[name="item_description"]').value.trim() || null,
      quantity:         parseFloat(tr.querySelector('[name="quantity"]').value) || null,
      uom:              tr.querySelector('[name="uom"]').value || null,
      remark:           tr.querySelector('[name="remark"]').value.trim() || null,
    })).filter(r => r.brand || r.item || r.quantity);

    if (items.length === 0) {
      toast("Add at least one item", "error");
      submitBtn.disabled = false;
      return;
    }

    let rfqId = state.editingRfqId;

    if (rfqId) {
      const { error: e1 } = await supabase
        .from("rfq_requests")
        .update(header)
        .eq("id", rfqId);
      if (e1) throw e1;
      const { error: e2 } = await supabase.from("rfq_items").delete().eq("rfq_id", rfqId);
      if (e2) throw e2;
      const { error: e3 } = await supabase
        .from("rfq_items")
        .insert(items.map(it => ({ ...it, rfq_id: rfqId })));
      if (e3) throw e3;
      toast("RFQ updated", "ok");
    } else {
      const { data: rfq, error: e1 } = await supabase
        .from("rfq_requests")
        .insert(header)
        .select()
        .single();
      if (e1) throw e1;
      rfqId = rfq.id;
      const { error: e2 } = await supabase
        .from("rfq_items")
        .insert(items.map(it => ({ ...it, rfq_id: rfqId })));
      if (e2) throw e2;
      toast("RFQ submitted", "ok");
    }

    const v = header.suggest_vendor;
    if (v && !(state.settings.vendors || []).includes(v)) {
      const next = [...(state.settings.vendors || []), v];
      await saveSetting("vendors", next);
      populateAllSelects();
    }

    await resetForm();
    $('.tab[data-tab="rfq-list"]').click();
  } catch (err) {
    console.error(err);
    toast(err.message || "Failed to save", "error");
  } finally {
    submitBtn.disabled = false;
  }
});

// ----- RFQ list view ---------------------------------------------------
async function loadRfqs() {
  const { data, error } = await supabase
    .from("rfq_requests")
    .select("*, rfq_items(count)")
    .order("created_at", { ascending: false });
  if (error) { toast(error.message, "error"); return; }
  state.rfqs = data || [];
  renderRfqList();
}

function renderRfqList() {
  const q = $("#rfq-search").value.trim().toLowerCase();
  const rows = state.rfqs.filter(r => {
    if (!q) return true;
    return [r.rfq_number, r.project, r.requestor, r.suggest_vendor, r.request_type, r.status]
      .some(v => String(v || "").toLowerCase().includes(q));
  });
  const statuses = state.settings.statuses || [];
  $("#rfq-list-body").innerHTML = rows.map(r => `
    <tr data-id="${r.id}">
      <td><strong>${escapeHtml(r.rfq_number)}</strong></td>
      <td>${fmtDate(r.creation_date)}</td>
      <td>${escapeHtml(r.project)}</td>
      <td>${escapeHtml(r.requestor)}</td>
      <td>${escapeHtml(r.request_type)}</td>
      <td>${escapeHtml(r.suggest_vendor)}</td>
      <td>${fmtDate(r.cutoff_date)}</td>
      <td>${fmtDate(r.request_delivery_date)}</td>
      <td>${(r.rfq_items && r.rfq_items[0] && r.rfq_items[0].count) || 0}</td>
      <td>
        <select class="rfq-status" data-id="${r.id}">
          ${statuses.map(s => `<option value="${escapeHtml(s)}" ${s === r.status ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}
        </select>
      </td>
      <td class="row-actions">
        <button data-act="edit"   data-id="${r.id}">Edit</button>
        <button data-act="delete" data-id="${r.id}" class="danger">Delete</button>
      </td>
    </tr>
  `).join("");
}

$("#rfq-search").addEventListener("input", renderRfqList);
$("#refresh-rfqs").addEventListener("click", loadRfqs);

$("#rfq-list-body").addEventListener("change", async (e) => {
  if (!e.target.classList.contains("rfq-status")) return;
  const id = e.target.dataset.id;
  const status = e.target.value;
  const { error } = await supabase.from("rfq_requests").update({ status }).eq("id", id);
  if (error) toast(error.message, "error");
  else      toast("Status updated", "ok");
});

$("#rfq-list-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === "delete") {
    if (!confirm("Delete this RFQ and all its items?")) return;
    const { error } = await supabase.from("rfq_requests").delete().eq("id", id);
    if (error) { toast(error.message, "error"); return; }
    toast("Deleted", "ok");
    await loadRfqs();
  } else if (act === "edit") {
    await openRfqForEdit(id);
  }
});

async function openRfqForEdit(id) {
  const { data: r, error } = await supabase
    .from("rfq_requests")
    .select("*, rfq_items(*)")
    .eq("id", id)
    .single();
  if (error) { toast(error.message, "error"); return; }

  state.editingRfqId = id;
  $("#form-title").textContent = `Edit RFQ ${r.rfq_number}`;
  $("#submit-btn").textContent = "Save Changes";
  $("#rfq-id").value = id;
  $("#rfq-number").value             = r.rfq_number;
  $("#creation-date").value          = fmtDate(r.creation_date) || todayISO();
  $("#cutoff-date").value            = fmtDate(r.cutoff_date);
  $("#request-delivery-date").value  = fmtDate(r.request_delivery_date);
  $("#description").value            = r.description || "";
  $("#note").value                   = r.note || "";
  $("#project").value                = r.project || "";
  $("#requestor").value              = r.requestor || "";
  $("#creator").value                = r.creator || "";
  $("#request-type").value           = r.request_type || "";
  $("#suggest-vendor").value         = r.suggest_vendor || "";

  $("#items-body").innerHTML = "";
  const sorted = (r.rfq_items || []).sort((a, b) => a.line_index - b.line_index);
  if (sorted.length === 0) {
    $("#items-body").appendChild(newItemRow(1));
  } else {
    sorted.forEach((it, i) => {
      $("#items-body").appendChild(newItemRow(i + 1, it));
    });
  }

  $('.tab[data-tab="form"]').click();
}

// ----- Item tracking view ---------------------------------------------
async function loadItems() {
  const { data, error } = await supabase
    .from("rfq_items")
    .select("*, rfq_requests(rfq_number,project,requestor)")
    .order("created_at", { ascending: false });
  if (error) { toast(error.message, "error"); return; }
  state.items = data || [];
  renderItemList();
}

function renderItemList() {
  const q = $("#item-search").value.trim().toLowerCase();
  const rows = state.items.filter(i => {
    if (!q) return true;
    const haystack = [
      i.brand, i.item, i.item_description, i.epr_number, i.po_number,
      i.rfq_requests?.rfq_number, i.rfq_requests?.project, i.status,
    ];
    return haystack.some(v => String(v || "").toLowerCase().includes(q));
  });
  $("#item-list-body").innerHTML = rows.map(i => `
    <tr data-id="${i.id}">
      <td><strong>${escapeHtml(i.rfq_requests?.rfq_number)}</strong></td>
      <td>${i.line_index}</td>
      <td>${escapeHtml(i.brand)}</td>
      <td>${escapeHtml(i.item)}</td>
      <td>${escapeHtml(i.item_description)}</td>
      <td>${i.quantity ?? ""}</td>
      <td>${escapeHtml(i.uom)}</td>
      <td>${escapeHtml(i.epr_number)}</td>
      <td>${escapeHtml(i.po_number)}</td>
      <td>${fmtDate(i.contract_eta)}</td>
      <td>${fmtDate(i.target_eta)}</td>
      <td><span class="${statusClass(i.status)}">${escapeHtml(i.status)}</span></td>
      <td class="row-actions">
        <button data-act="edit-item"   data-id="${i.id}">Edit</button>
        <button data-act="delete-item" data-id="${i.id}" class="danger">Delete</button>
      </td>
    </tr>
  `).join("");
}

$("#item-search").addEventListener("input", renderItemList);
$("#refresh-items").addEventListener("click", loadItems);

$("#item-list-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === "delete-item") {
    if (!confirm("Delete this item?")) return;
    const { error } = await supabase.from("rfq_items").delete().eq("id", id);
    if (error) { toast(error.message, "error"); return; }
    toast("Item deleted", "ok");
    await loadItems();
  } else if (btn.dataset.act === "edit-item") {
    openItemModal(id);
  }
});

// ----- Item modal ------------------------------------------------------
function openItemModal(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  populateAllSelects();
  $("#m-item-id").value      = id;
  $("#m-brand").value        = item.brand || "";
  $("#m-item").value         = item.item || "";
  $("#m-desc").value         = item.item_description || "";
  $("#m-qty").value          = item.quantity ?? "";
  $("#m-uom").value          = item.uom || "";
  $("#m-remark").value       = item.remark || "";
  $("#m-epr").value          = item.epr_number || "";
  $("#m-po").value           = item.po_number || "";
  $("#m-contract-eta").value = fmtDate(item.contract_eta);
  $("#m-target-eta").value   = fmtDate(item.target_eta);
  $("#m-status").value       = item.status || "";
  $("#item-modal").classList.remove("hidden");
}

$("#m-cancel").addEventListener("click", () => $("#item-modal").classList.add("hidden"));
$("#m-save").addEventListener("click", async () => {
  const id = $("#m-item-id").value;
  const patch = {
    brand:            $("#m-brand").value.trim() || null,
    item:             $("#m-item").value.trim() || null,
    item_description: $("#m-desc").value.trim() || null,
    quantity:         parseFloat($("#m-qty").value) || null,
    uom:              $("#m-uom").value || null,
    remark:           $("#m-remark").value.trim() || null,
    epr_number:       $("#m-epr").value.trim() || null,
    po_number:        $("#m-po").value.trim() || null,
    contract_eta:     $("#m-contract-eta").value || null,
    target_eta:       $("#m-target-eta").value || null,
    status:           $("#m-status").value || null,
  };
  const { error } = await supabase.from("rfq_items").update(patch).eq("id", id);
  if (error) { toast(error.message, "error"); return; }
  toast("Item saved", "ok");
  $("#item-modal").classList.add("hidden");
  await loadItems();
});

// ----- Settings panel --------------------------------------------------
function renderSettingsPanel() {
  const grid = $("#settings-grid");
  grid.innerHTML = Object.keys(SETTING_LABELS).map(key => {
    const list = state.settings[key] || [];
    return `
      <div class="settings-card" data-key="${key}">
        <h4>${SETTING_LABELS[key]}</h4>
        <ul>
          ${list.map((v, i) => `
            <li>
              <span>${escapeHtml(v)}</span>
              <button data-act="rm" data-i="${i}" title="Remove">×</button>
            </li>`).join("")}
        </ul>
        <div class="add-row">
          <input type="text" placeholder="Add new…" />
          <button class="btn-secondary" data-act="add">Add</button>
        </div>
      </div>
    `;
  }).join("");

  $("#cfg-rfq-prefix").value     = state.settings.rfq_prefix;
  $("#cfg-cutoff-days").value    = state.settings.default_cutoff_days;
  $("#cfg-delivery-days").value  = state.settings.default_delivery_days;
}

$("#settings-grid").addEventListener("click", async (e) => {
  const card = e.target.closest(".settings-card");
  if (!card) return;
  const key = card.dataset.key;
  const list = [...(state.settings[key] || [])];

  if (e.target.dataset.act === "rm") {
    const i = Number(e.target.dataset.i);
    list.splice(i, 1);
    await saveSetting(key, list);
    populateAllSelects();
    renderSettingsPanel();
  } else if (e.target.dataset.act === "add") {
    const input = card.querySelector('input');
    const v = input.value.trim();
    if (!v) return;
    if (list.includes(v)) { toast("Already exists", "error"); return; }
    list.push(v);
    await saveSetting(key, list);
    populateAllSelects();
    renderSettingsPanel();
  }
});

$("#save-defaults").addEventListener("click", async () => {
  const prefix       = $("#cfg-rfq-prefix").value.trim() || "RFQ";
  const cutoffDays   = Number($("#cfg-cutoff-days").value) || 0;
  const deliveryDays = Number($("#cfg-delivery-days").value) || 0;
  await Promise.all([
    saveSetting("rfq_prefix", prefix),
    saveSetting("default_cutoff_days", cutoffDays),
    saveSetting("default_delivery_days", deliveryDays),
  ]);
  toast("Defaults saved", "ok");
  if (!state.editingRfqId) {
    $("#rfq-number").value = await nextRfqNumber();
    $("#cutoff-date").value           = addDays($("#creation-date").value || todayISO(), cutoffDays);
    $("#request-delivery-date").value = addDays($("#creation-date").value || todayISO(), deliveryDays);
  }
});

// ----- Realtime: refresh views when others edit -----------------------
function subscribeRealtime() {
  supabase.channel("rfq-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "rfq_requests" }, () => {
      if (!$('[data-panel="rfq-list"]').classList.contains("hidden")) loadRfqs();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "rfq_items" }, () => {
      if (!$('[data-panel="rfq-list"]').classList.contains("hidden"))  loadRfqs();
      if (!$('[data-panel="item-list"]').classList.contains("hidden")) loadItems();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, async () => {
      await loadSettings();
    })
    .subscribe();
}

// ----- bootstrap -------------------------------------------------------
async function init() {
  if (SUPABASE_ANON_KEY === "REPLACE_WITH_ANON_KEY") {
    setEnv("missing anon key — edit config.js", "err");
    toast("Set the Supabase anon key in config.js", "error");
    return;
  }
  try {
    setEnv("connecting…");
    await loadSettings();
    await resetForm();
    subscribeRealtime();
    setEnv("connected", "ok");
  } catch (err) {
    console.error(err);
    setEnv("connection failed", "err");
    toast(err.message || "Failed to connect to Supabase", "error");
  }
}

init();
