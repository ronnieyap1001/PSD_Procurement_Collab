// PSD Procurement Tracker — main app logic.
// Talks directly to Supabase; multi-user concurrent access is handled by
// Postgres + the realtime channel below.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:    true,
    autoRefreshToken:  true,
    detectSessionInUrl: true,
    storageKey:        "psd-procurement-auth",
  },
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
  userPrefs: {
    project:        null,
    request_type:   null,
    requestor:      null,
    creator:        null,
    suggest_vendor: null,
    default_uom:    null,
  },
};

const USER_PREF_KEYS = ["project", "request_type", "requestor", "creator", "suggest_vendor", "default_uom"];

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

// ----- per-user preferences -------------------------------------------
function emptyPrefs() {
  return Object.fromEntries(USER_PREF_KEYS.map(k => [k, null]));
}

async function loadUserPrefs() {
  state.userPrefs = emptyPrefs();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { data, error } = await supabase
    .from("user_preferences")
    .select("preferences")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    console.warn("user_preferences not available:", error.message);
    return;
  }
  if (data?.preferences) {
    state.userPrefs = { ...emptyPrefs(), ...data.preferences };
  }
}

async function saveUserPrefs(patch) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const next = { ...state.userPrefs, ...patch };
  for (const k of Object.keys(next)) {
    if (next[k] === "" || next[k] === undefined) next[k] = null;
  }
  state.userPrefs = next;
  const { error } = await supabase
    .from("user_preferences")
    .upsert(
      { user_id: user.id, preferences: next, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
  if (error) {
    console.warn("Failed to save user preferences:", error.message);
  }
}

async function clearUserPrefs() {
  const { data: { user } } = await supabase.auth.getUser();
  state.userPrefs = emptyPrefs();
  if (!user) return;
  const { error } = await supabase
    .from("user_preferences")
    .delete()
    .eq("user_id", user.id);
  if (error) console.warn("Failed to clear user preferences:", error.message);
}

function prefValueIfAllowed(key, list) {
  const v = state.userPrefs?.[key];
  if (!v) return "";
  if (!list || list.includes(v)) return v;
  return "";
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
  if (item.uom) {
    uomSel.value = item.uom;
  } else {
    const defaultUom = prefValueIfAllowed("default_uom", state.settings.uoms);
    if (defaultUom) uomSel.value = defaultUom;
  }

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
  $("#note").value         = "";

  const s = state.settings;
  $("#project").value        = prefValueIfAllowed("project",      s.projects);
  $("#requestor").value      = prefValueIfAllowed("requestor",    s.requestors);
  $("#creator").value        = prefValueIfAllowed("creator",      s.creators);
  $("#request-type").value   = prefValueIfAllowed("request_type", s.request_types);
  $("#suggest-vendor").value = state.userPrefs?.suggest_vendor || "";

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

    const wasNew = !state.editingRfqId;
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

    const submittedRfqId = rfqId;

    if (wasNew) {
      const firstUom = items.find(it => it.uom)?.uom || null;
      await saveUserPrefs({
        project:        header.project,
        request_type:   header.request_type,
        requestor:      header.requestor,
        creator:        header.creator,
        suggest_vendor: header.suggest_vendor,
        ...(firstUom ? { default_uom: firstUom } : {}),
      });
    }

    await resetForm();
    $('.tab[data-tab="rfq-list"]').click();
    if (wasNew && submittedRfqId) {
      await openEmailModal(submittedRfqId);
    }
  } catch (err) {
    console.error(err);
    toast(err.message || "Failed to save", "error");
  } finally {
    submitBtn.disabled = false;
  }
});

// ----- Email draft modal ----------------------------------------------
function buildEmailDraft(rfq, items) {
  const sortedItems = (items || []).slice().sort((a, b) => (a.line_index || 0) - (b.line_index || 0));
  const vendor   = rfq.suggest_vendor || "Vendor";
  const project  = rfq.project        || "";
  const reqType  = rfq.request_type   || "";
  const cutoff   = fmtDate(rfq.cutoff_date);
  const delivery = fmtDate(rfq.request_delivery_date);
  const desc     = (rfq.description || "").trim();
  const note     = (rfq.note        || "").trim();
  const requestor = rfq.requestor || "";
  const creator   = rfq.creator   || "";

  const subject = `[RFQ ${rfq.rfq_number}]${project ? " " + project : ""} — Request for Quotation`;

  const lines = [];
  lines.push(`Dear ${vendor},`);
  lines.push("");
  lines.push(`We would like to invite you to quote for the following requirement${project ? " for project " + project : ""}.`);
  lines.push("");
  lines.push(`RFQ #          : ${rfq.rfq_number}`);
  if (project)  lines.push(`Project        : ${project}`);
  if (reqType)  lines.push(`Request Type   : ${reqType}`);
  if (requestor)lines.push(`Requestor      : ${requestor}`);
  if (cutoff)   lines.push(`Quote Cutoff   : ${cutoff}`);
  if (delivery) lines.push(`Required ETA   : ${delivery}`);
  if (desc) {
    lines.push("");
    lines.push("Description:");
    lines.push(desc);
  }

  lines.push("");
  lines.push("Items:");
  if (sortedItems.length === 0) {
    lines.push("  (no items)");
  } else {
    sortedItems.forEach((it, i) => {
      const idx   = it.line_index || (i + 1);
      const brand = it.brand || "-";
      const item  = it.item  || "-";
      const itDesc = it.item_description ? ` — ${it.item_description}` : "";
      const qty   = it.quantity != null ? it.quantity : "-";
      const uom   = it.uom ? ` ${it.uom}` : "";
      const remark = it.remark ? `  [Remark: ${it.remark}]` : "";
      lines.push(`  ${idx}. ${brand} | ${item}${itDesc} — Qty: ${qty}${uom}${remark}`);
    });
  }

  if (note) {
    lines.push("");
    lines.push("Note:");
    lines.push(note);
  }

  lines.push("");
  lines.push(cutoff
    ? `Kindly reply with your best offer (price, lead time, validity) by ${cutoff}.`
    : `Kindly reply with your best offer (price, lead time, validity) at your earliest convenience.`);
  lines.push("");
  lines.push("Thank you & best regards,");
  if (creator) lines.push(creator);

  return { subject, body: lines.join("\n") };
}

async function openEmailModal(rfqId) {
  try {
    const { data: rfq, error } = await supabase
      .from("rfq_requests")
      .select("*, rfq_items(*)")
      .eq("id", rfqId)
      .single();
    if (error) throw error;
    const { subject, body } = buildEmailDraft(rfq, rfq.rfq_items || []);
    $("#em-rfq-number").textContent = rfq.rfq_number || "";
    $("#em-to").value      = "";
    $("#em-subject").value = subject;
    $("#em-body").value    = body;
    $("#email-modal").classList.remove("hidden");
    setTimeout(() => $("#em-body").focus(), 50);
  } catch (err) {
    console.error(err);
    toast(err.message || "Failed to load RFQ for email", "error");
  }
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast("Copied to clipboard", "ok");
  } catch (err) {
    console.error(err);
    toast("Copy failed — select and copy manually", "error");
  }
}

$("#em-close").addEventListener("click",   () => $("#email-modal").classList.add("hidden"));
$("#em-close-x").addEventListener("click", () => $("#email-modal").classList.add("hidden"));
$("#email-modal").addEventListener("click", (e) => {
  if (e.target.id === "email-modal") $("#email-modal").classList.add("hidden");
});
$("#em-copy-subject").addEventListener("click", () => copyText($("#em-subject").value));
$("#em-copy-body").addEventListener("click",    () => copyText($("#em-body").value));
$("#em-copy-all").addEventListener("click",     () => {
  const text = `Subject: ${$("#em-subject").value}\n\n${$("#em-body").value}`;
  copyText(text);
});
$("#em-open-mail").addEventListener("click", () => {
  const to      = $("#em-to").value.trim();
  const subject = encodeURIComponent($("#em-subject").value);
  const body    = encodeURIComponent($("#em-body").value);
  const href    = `mailto:${encodeURIComponent(to)}?subject=${subject}&body=${body}`;
  window.location.href = href;
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
        <button data-act="email"  data-id="${r.id}">Email</button>
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
  } else if (act === "email") {
    await openEmailModal(id);
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
        <button data-act="email-item"  data-id="${i.id}" data-rfq-id="${i.rfq_id}">Email</button>
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
  } else if (btn.dataset.act === "email-item") {
    const rfqId = btn.dataset.rfqId;
    if (rfqId) await openEmailModal(rfqId);
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

  renderMyDefaults();
}

function renderMyDefaults() {
  const s = state.settings;
  const setIfAllowed = (selId, key, list) => {
    const el = $(selId);
    if (!el) return;
    el.value = prefValueIfAllowed(key, list);
  };
  setIfAllowed("#up-project",      "project",      s.projects);
  setIfAllowed("#up-request-type", "request_type", s.request_types);
  setIfAllowed("#up-requestor",    "requestor",    s.requestors);
  setIfAllowed("#up-creator",      "creator",      s.creators);
  setIfAllowed("#up-uom",          "default_uom",  s.uoms);
  const vendorEl = $("#up-vendor");
  if (vendorEl) vendorEl.value = state.userPrefs?.suggest_vendor || "";
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

$("#up-save").addEventListener("click", async () => {
  await saveUserPrefs({
    project:        $("#up-project").value      || null,
    request_type:   $("#up-request-type").value || null,
    requestor:      $("#up-requestor").value    || null,
    creator:        $("#up-creator").value      || null,
    default_uom:    $("#up-uom").value          || null,
    suggest_vendor: $("#up-vendor").value.trim() || null,
  });
  toast("Your defaults saved", "ok");
  if (!state.editingRfqId) await resetForm({ keepNumber: true });
});

$("#up-clear").addEventListener("click", async () => {
  if (!confirm("Clear your remembered form defaults?")) return;
  await clearUserPrefs();
  renderMyDefaults();
  toast("Your defaults cleared", "ok");
  if (!state.editingRfqId) await resetForm({ keepNumber: true });
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
  const ch = supabase.channel("rfq-changes")
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
  return ch;
}

// ----- Auth: email + password -----------------------------------------
let realtimeChannel = null;
let appLoaded       = false;

function showAuthOverlay() {
  $("#auth-overlay").classList.remove("hidden");
  document.querySelectorAll(".app-shell").forEach(el => el.classList.add("hidden"));
}
function hideAuthOverlay() {
  $("#auth-overlay").classList.add("hidden");
  document.querySelectorAll(".app-shell").forEach(el => el.classList.remove("hidden"));
}
function setAuthMessage(kind, msg) {
  const errEl  = $("#auth-error");
  const infoEl = $("#auth-info");
  errEl.classList.add("hidden");
  infoEl.classList.add("hidden");
  if (!msg) return;
  if (kind === "error") { errEl.textContent  = msg; errEl.classList.remove("hidden"); }
  else                  { infoEl.textContent = msg; infoEl.classList.remove("hidden"); }
}

async function handleSignIn(e) {
  e?.preventDefault?.();
  const email    = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!email || !password) { setAuthMessage("error", "Email and password are required."); return; }
  setAuthMessage(null);
  const signInBtn = $("#auth-signin");
  signInBtn.disabled = true;
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setAuthMessage("error", error.message); return; }
    // onAuthStateChange will boot the app.
  } finally {
    signInBtn.disabled = false;
  }
}

async function handleSignUp() {
  const email    = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!email || !password) { setAuthMessage("error", "Email and password are required."); return; }
  if (password.length < 6) { setAuthMessage("error", "Password must be at least 6 characters."); return; }
  setAuthMessage(null);
  const signUpBtn = $("#auth-signup");
  signUpBtn.disabled = true;
  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) { setAuthMessage("error", error.message); return; }
    if (data.session) {
      // Email confirmation disabled — user is signed in.
      return;
    }
    setAuthMessage("info", "Account created. Check your email to confirm before signing in.");
  } finally {
    signUpBtn.disabled = false;
  }
}

async function handleSignOut() {
  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.error(err);
    toast(err.message || "Sign out failed", "error");
  }
}

$("#auth-form").addEventListener("submit", handleSignIn);
$("#auth-signup").addEventListener("click", handleSignUp);
$("#sign-out").addEventListener("click", handleSignOut);

async function loadAppForUser(user) {
  $("#user-email").textContent = user?.email || "";
  hideAuthOverlay();
  if (appLoaded) return;
  try {
    setEnv("connecting…");
    await loadSettings();
    await loadUserPrefs();
    renderMyDefaults();
    await resetForm();
    if (!realtimeChannel) realtimeChannel = subscribeRealtime();
    setEnv("connected", "ok");
    appLoaded = true;
  } catch (err) {
    console.error(err);
    setEnv("connection failed", "err");
    toast(err.message || "Failed to connect to Supabase", "error");
  }
}

function tearDownAppOnSignOut() {
  appLoaded = false;
  if (realtimeChannel) {
    try { supabase.removeChannel(realtimeChannel); } catch (_) {}
    realtimeChannel = null;
  }
  state.rfqs = [];
  state.items = [];
  state.editingRfqId = null;
  state.userPrefs = emptyPrefs();
  $("#rfq-list-body").innerHTML = "";
  $("#item-list-body").innerHTML = "";
  $("#item-modal").classList.add("hidden");
  $("#email-modal").classList.add("hidden");
  $("#auth-password").value = "";
  setAuthMessage(null);
  showAuthOverlay();
  setEnv("signed out");
}

supabase.auth.onAuthStateChange((event, session) => {
  if (session?.user) {
    loadAppForUser(session.user);
  } else if (event === "SIGNED_OUT") {
    tearDownAppOnSignOut();
  }
});

// ----- bootstrap -------------------------------------------------------
async function init() {
  if (SUPABASE_ANON_KEY === "REPLACE_WITH_ANON_KEY") {
    setEnv("missing anon key — edit config.js", "err");
    toast("Set the Supabase anon key in config.js", "error");
    return;
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    await loadAppForUser(session.user);
  } else {
    showAuthOverlay();
  }
}

init();
