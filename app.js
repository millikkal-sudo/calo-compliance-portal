// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPABASE_URL  = "https://iflquskysqchhbywvmow.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmbHF1c2t5c3FjaGhieXd2bW93Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NjM3ODIsImV4cCI6MjA5NzQzOTc4Mn0.FFcd80AqZ8hpyi-Bs_rPnCNZNp075YqBYM1yAYeyGUw";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// -- Constants ---------------------------------------------------------------
const SUPABASE_BUCKET = "certificates";
const MAX_FILE_BYTES  = 5 * 1024 * 1024;

const MARKET_CONFIG = {
  UAE: {
    certificates: {
      bfs: { label: "BFS", fullName: "Basic Food Safety",        validYears: 2 },
      ohc: { label: "OHC", fullName: "Occupational Health Card", validYears: 1 },
      fsc: { label: "FSC", fullName: "Fire Safety Certificate",  validYears: 2 },
      fac: { label: "FAC", fullName: "First Aid Certificate",    validYears: 2 },
    },
    sectionSuffix:  { bfs: "Bfs", ohc: "Ohc", fsc: "Fsc", fac: "Fac" },
    // certGroup: types that share one employee list. BFS+OHC share a list.
    // FSC and FAC are independent. An employee added to FSC does NOT appear in FAC.
    certGroups: [["bfs","ohc"], ["fsc"], ["fac"]],
    navLabel:   "UAE Kitchen",
  },
  Qatar: {
    certificates: {
      fh: { label: "FH",  fullName: "Food Handler Certificate", validYears: 1 },
      fa: { label: "FA",  fullName: "First Aid Certificate",    validYears: 1 },
      fs: { label: "FS",  fullName: "Fire Safety Certificate",  validYears: 1 },
    },
    sectionSuffix:  { fh: "Fh", fa: "Fa", fs: "Fs" },
    // Qatar: all cert types are fully independent
    certGroups: [["fh"], ["fa"], ["fs"]],
    navLabel:   "Qatar Kitchen",
  },
};

// ── Cert group helpers ────────────────────────────────────────────────────────
// Returns all types that share a list with the given type (including itself)
function getCertGroup(type) {
  const cfg = MARKET_CONFIG[MARKET];
  if (!cfg) return [type];
  const group = cfg.certGroups.find(g => g.includes(type));
  return group || [type];
}
// Returns true if an employee belongs in a given cert section.
// An employee belongs if:
//   a) they have actual cert data (issue date, expiry, file) for any type in the group, OR
//   b) they have a cert DB record (even empty placeholder) for any type in the group
//      -- this covers bulk-uploaded employees whose sibling certs are empty placeholders
function empBelongsInSection(emp, type) {
  const group = getCertGroup(type);
  return group.some(t => {
    // Check actual cert data
    const cert = emp.certificates && emp.certificates[t];
    if (cert && (cert.issueDate || cert.expiryDate || cert.file || cert.scheduledDate)) return true;
    // Check DB presence (empty placeholder record exists)
    if (emp._certPresence && emp._certPresence.has(t)) return true;
    return false;
  });
}

let MARKET = null, CERTIFICATES = {}, CERT_TYPES = [], SECTION_SUFFIX = {}, LINKED_TYPES = [], UNIVERSAL_TYPES = [];
const EDITOR_EMAILS = [];
const OPS_EMAILS    = [];

function applyMarket(market) {
  MARKET          = market;
  const cfg       = MARKET_CONFIG[market] || MARKET_CONFIG.UAE;
  CERTIFICATES    = cfg.certificates;
  CERT_TYPES      = Object.keys(CERTIFICATES);
  SECTION_SUFFIX  = cfg.sectionSuffix;
  LINKED_TYPES    = []; // deprecated -- use certGroups instead
  UNIVERSAL_TYPES = []; // deprecated -- use certGroups instead
  document.querySelectorAll(".market-label").forEach(function(el) { el.textContent = cfg.navLabel; });
  document.title = "Calo Compliance Portal";
  document.querySelectorAll(".nav-tab[data-view]").forEach(function(tab) {
    var view = tab.dataset.view;
    if (view === "dashboard" || view === "alerts") { tab.classList.remove("hidden"); return; }
    tab.classList.toggle("hidden", CERT_TYPES.indexOf(view) === -1);
  });
  document.querySelectorAll(".view[id]").forEach(function(v) {
    var id = v.id;
    if (id === "dashboard" || id === "alerts") { v.classList.remove("cert-view-hidden"); return; }
    CERT_TYPES.indexOf(id) !== -1 ? v.classList.remove("cert-view-hidden") : v.classList.add("cert-view-hidden");
  });
  ["bfs","ohc","fsc","fac","fh","fa","fs"].forEach(function(t) {
    var p = document.getElementById(t + "Overview");
    if (p) p.classList.toggle("cert-view-hidden", CERT_TYPES.indexOf(t) === -1);
  });
}

function hasCertData(emp, type) {
  var r = (emp.certificates && emp.certificates[type]) || {};
  return Boolean(r.issueDate || r.expiryDate || r.file || r.scheduledDate);
}
// An employee appears in a cert section if they have data for any type in that group
function certApplies(emp, type) {
  return empBelongsInSection(emp, type);
}
const defaultSettings = { reminderDays: 30, managerEmail: "" };

// ── State ─────────────────────────────────────────────────────────────────────
let state     = { employees: [], settings: { ...defaultSettings }, slots: [] };
let session   = null;
let isEditor  = false;
let isOps     = false;
const canSchedule = () => isEditor || isOps;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginView         = document.getElementById("loginView");
const appShell          = document.getElementById("appShell");
const toast             = document.getElementById("toast");
const views             = document.querySelectorAll(".view");
const tabs              = document.querySelectorAll(".nav-tab");
const syncStatus        = document.getElementById("syncStatus");
const syncLabel         = document.getElementById("syncLabel");
const alertSettingsForm = document.getElementById("alertSettingsForm");

// ── Login ─────────────────────────────────────────────────────────────────────
document.getElementById("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email    = document.getElementById("loginEmail").value.trim().toLowerCase();
  const password = document.getElementById("loginPassword").value;
  const errEl    = document.getElementById("loginError");
  const btn      = document.getElementById("loginSubmitBtn");
  errEl.classList.add("hidden");
  btn.textContent = "Signing in…"; btn.disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  btn.textContent = "Sign in"; btn.disabled = false;
  if (error) { errEl.textContent = error.message; errEl.classList.remove("hidden"); return; }
  const user = data.session?.user ?? data.user;
  if (user) await onSignIn(user);
});

document.getElementById("togglePw").addEventListener("click", () => {
  const pw = document.getElementById("loginPassword");
  pw.type = pw.type === "password" ? "text" : "password";
});

async function onSignIn(user) {
  session = user;
  var market = "UAE", role = null;
  try {
    var timeoutP = new Promise(function(res) { setTimeout(function() { res({data:null}); }, 3000); });
    // Fetch ALL roles for this user so global_admin + market admin can coexist
    var queryP = sb.from("user_roles").select("market, role").eq("user_id", user.id);
    var result = await Promise.race([queryP, timeoutP]);
    var rows   = (result && result.data) ? result.data : [];
    // Prefer the most specific role: market admin > global_admin > viewer
    var globalRow = rows.find(function(r) { return r.role === "global_admin"; });
    var adminRow  = rows.find(function(r) { return r.role === "admin"; });
    var viewerRow = rows.find(function(r) { return r.role === "viewer"; });
    if (adminRow)  { market = adminRow.market;  role = "admin"; }
    else if (globalRow) { market = "UAE"; role = "global_admin"; }
    else if (viewerRow) { market = viewerRow.market; role = "viewer"; }
  } catch(e) {}
  // global_admin gets full edit access on their market
  isEditor = (role === "admin" || role === "global_admin");
  isOps    = (role === "viewer");
  applyMarket(market);
  setSyncState("syncing");
  await loadFromSupabase();
  render();
  showToast(`Welcome, ${user.email.split("@")[0]}!`);
}

// ── Sign out ──────────────────────────────────────────────────────────────────
document.getElementById("signOutButton").addEventListener("click", async () => {
  await sb.auth.signOut();
  session = null; isEditor = false; isOps = false;
  state = { employees: [], settings: { ...defaultSettings } };
  render();
});

// ── Supabase: load ────────────────────────────────────────────────────────────
async function loadFromSupabase() {
  try {
    const [{ data: emps, error: e1 }, { data: certs, error: e2 }, { data: cfg }, { data: slots }] = await Promise.all([
      sb.from("employees").select("*").eq("market", MARKET).order("created_at", { ascending: false }),
      sb.from("certificates").select("id,employee_id,type,issue_date,expiry_date,file_name,file_path,scheduled_date,schedule_note").eq("market", MARKET),
      sb.from("settings").select("*").eq("market", MARKET).single(),
      sb.from("schedule_slots").select("*").eq("market", MARKET).order("slot_date", { ascending: true }),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;

    // Build cert presence map: empId -> Set of cert types that have a DB row
    // This includes empty placeholder rows created during bulk upload for group siblings
    const empCertPresence = {};
    (certs || []).forEach(c => {
      if (!empCertPresence[c.employee_id]) empCertPresence[c.employee_id] = new Set();
      empCertPresence[c.employee_id].add(c.type);
    });

    state.employees = (emps || []).map(emp => {
      const ec = (certs || []).filter(c => c.employee_id === emp.id);
      const certificates = {}, _certIds = {};
      // Load all cert types across ALL markets so group sibling lookup works
      const allTypes = Object.keys(Object.assign({},
        MARKET_CONFIG.UAE.certificates, MARKET_CONFIG.Qatar.certificates));
      allTypes.forEach(t => {
        const c = ec.find(x => x.type === t) || {};
        certificates[t] = c.id ? { issueDate: c.issue_date||"", expiryDate: c.expiry_date||"",
                                   scheduledDate: c.scheduled_date||"", scheduleNote: c.schedule_note||"",
                                   file: c.file_name ? { name: c.file_name, filePath: c.file_path, dataUrl: null } : null } : {};
        _certIds[t] = c.id || null;
      });
      return {
        id: emp.id, name: emp.name, employeeId: emp.employee_id,
        department: emp.department, createdAt: emp.created_at, updatedAt: emp.updated_at,
        certificates, _certIds,
        _certPresence: empCertPresence[emp.id] || new Set(),
      };
    });
    state.settings = cfg ? { reminderDays: cfg.reminder_days, managerEmail: cfg.manager_email||"" } : { ...defaultSettings };
    state.slots = (slots || []).map(s => ({ id: s.id, date: s.slot_date, label: s.label||"", capacity: s.capacity ?? 15 }));
    setSyncState("idle");
  } catch(err) {
    console.error("loadFromSupabase:", err);
    setSyncState("error");
    showToast("Could not load data -- check connection.");
  }
}

// ── Supabase: write helpers ───────────────────────────────────────────────────

// Returns the DB id of the upserted employee
// Uses employee_id (the text code like CK-1024) as conflict key so
// employees added before Supabase existed get correctly matched/updated
async function upsertEmployee(emp) {
  const { data, error } = await sb.from("employees").upsert(
    { id: emp.id, name: emp.name, employee_id: emp.employeeId, department: emp.department, market: MARKET, updated_at: new Date().toISOString() },
    { onConflict: "employee_id" }   // match on the unique text code, not UUID
  ).select("id").single();
  if (error) throw error;
  // Sync the real DB id back into state so cert saves use the right FK
  if (data.id !== emp.id) {
    const inState = state.employees.find(x => x.employeeId === emp.employeeId);
    if (inState) inState.id = data.id;
  }
  return data.id;
}

// Returns the cert row id so callers can update _certIds
// empStateId = the id stored in state (may be a local UUID not yet in DB)
// We resolve the real DB employee id via employee_id code before inserting
async function upsertCertificate(empStateId, type, cert, existingCertId) {
  // Look up the real DB row id using the unique employee_id code
  const emp = state.employees.find(x => x.id === empStateId);
  if (!emp) throw new Error(`Employee not found in state: ${empStateId}`);

  // Get the real Supabase row id by employee_id code (the unique text id like CK-1024)
  const { data: empRow, error: empErr } = await sb
    .from("employees")
    .select("id")
    .eq("employee_id", emp.employeeId)
    .single();
  if (empErr || !empRow) throw new Error(`Employee "${emp.employeeId}" not found in database. Please save the employee first.`);

  const realEmpId = empRow.id;

  // Also update the in-state id to match DB so future calls are instant
  if (emp.id !== realEmpId) {
    emp.id = realEmpId;
    if (!emp._certIds) emp._certIds = {};
  }

  const payload = {
    employee_id: realEmpId, type, market: MARKET,
    issue_date:     cert.issueDate     || null,
    expiry_date:    cert.expiryDate    || null,
    file_name:      cert.file?.name     || null,
    file_path:      cert.file?.filePath || null,
    scheduled_date: cert.scheduledDate || null,
    schedule_note:  cert.scheduleNote  || null,
    updated_at:     new Date().toISOString(),
  };
  if (existingCertId) payload.id = existingCertId;
  const { data, error } = await sb.from("certificates")
    .upsert(payload, { onConflict: "employee_id,type" })
    .select("id").single();
  if (error) throw error;
  return data.id;
}

// Upload file to Supabase Storage -- returns { filePath, publicUrl } or throws
// empCode = the text employee ID like "CK-1024" -- used as folder name in storage
// so paths are stable and human-readable regardless of DB UUID changes
async function uploadFileToStorage(empCode, type, file) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`File too large (max 5 MB). "${file.name}" is ${(file.size/1024/1024).toFixed(1)} MB.`);
  const ext      = file.name.split(".").pop().toLowerCase();
  const filePath = `${MARKET}/${empCode}/${type}/${Date.now()}.${ext}`;
  const { error } = await sb.storage.from(SUPABASE_BUCKET).upload(filePath, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  const { data: { publicUrl } } = sb.storage.from(SUPABASE_BUCKET).getPublicUrl(filePath);
  return { filePath, publicUrl };
}

// Delete old storage file if it exists
async function deleteStorageFile(filePath) {
  if (!filePath) return;
  await sb.storage.from(SUPABASE_BUCKET).remove([filePath]).catch(console.warn);
}

async function deleteEmployeeFromDb(id)     { const { error } = await sb.from("employees").delete().eq("id", id); if (error) throw error; }
async function deleteCertFromDb(empId, type){ const { error } = await sb.from("certificates").delete().eq("employee_id", empId).eq("type", type); if (error) throw error; }
async function saveSettingsToDb(s)          { const { error } = await sb.from("settings").upsert({ market: MARKET, manager_email: s.managerEmail, reminder_days: s.reminderDays }, { onConflict:"market" }); if (error) throw error; }

// ── Sync indicator ────────────────────────────────────────────────────────────
function setSyncState(s) {
  syncStatus.className = "sync-status sync-" + s;
  syncLabel.textContent = s === "syncing" ? "Saving…" : s === "error" ? "Save failed" : "Saved";
}

// ── readCertFile -- reads File object, uploads to Storage, returns cert file obj ─
// empCode = text employee ID like "CK-1024" used as storage folder
async function readCertFile(file, empCode, type) {
  if (!file) return null;
  if (file.type !== "application/pdf" && !file.type.startsWith("image/")) { showToast("Upload a PDF or image."); throw new Error("bad type"); }
  if (file.size > MAX_FILE_BYTES) { showToast(`File too large -- max 5 MB.`); throw new Error("too large"); }

  // Always get a local dataUrl for immediate preview
  const dataUrl = await toDataUrl(file);

  // Upload to Supabase Storage using the text employee code as folder
  let filePath = null;
  if (isEditor && empCode) {
    const result = await uploadFileToStorage(empCode, type, file);
    filePath = result.filePath;
  }
  return { name: file.name, type: file.type, size: file.size, dataUrl, filePath, uploadedAt: new Date().toISOString() };
}

// ── fileLink -- renders a download/view link ───────────────────────────────────
function fileLink(f) {
  if (!f) return '<span class="muted">--</span>';
  // Prefer public Storage URL, fall back to dataUrl (local session only)
  const href = f.filePath
    ? sb.storage.from(SUPABASE_BUCKET).getPublicUrl(f.filePath).data.publicUrl
    : f.dataUrl;
  if (!href) return `<span class="muted" title="File recorded but not yet loaded">${escHtml(f.name)}</span>`;
  return `<a class="table-link" href="${href}" target="_blank" rel="noopener">${escHtml(f.name)}</a>`;
}

// ── Tab navigation ─────────────────────────────────────────────────────────────
tabs.forEach(tab => tab.addEventListener("click", () => {
  tabs.forEach(t => t.classList.toggle("active", t === tab));
  views.forEach(v => v.classList.toggle("active-view", v.id === tab.dataset.view));
}));
function showView(id) {
  tabs.forEach(t => t.classList.toggle("active", t.dataset.view === id));
  views.forEach(v => v.classList.toggle("active-view", v.id === id));
}

// ── Cert upload modal ─────────────────────────────────────────────────────────
const certUploadModal     = document.getElementById("certUploadModal");
const certUploadModalForm = document.getElementById("certUploadModalForm");

function openCertModal(empId, type) {
  const emp = state.employees.find(x => x.id === empId); if (!emp) return;
  document.getElementById("certUploadModalTitle").textContent = `Upload ${CERTIFICATES[type].label} - ${emp.name}`;
  certUploadModalForm.elements.employeeId.value = empId;
  certUploadModalForm.elements.type.value       = type;
  certUploadModalForm.elements.issueDate.value  = emp.certificates[type]?.issueDate  || "";
  certUploadModalForm.elements.expiryDate.value = emp.certificates[type]?.expiryDate || "";
  certUploadModalForm.elements.file.value = "";
  certUploadModal.classList.remove("hidden");
}
function closeCertModal() { certUploadModal.classList.add("hidden"); certUploadModalForm.reset(); }
document.getElementById("certUploadModalClose").addEventListener("click", closeCertModal);
document.getElementById("certUploadModalCancel").addEventListener("click", closeCertModal);
certUploadModal.addEventListener("click", e => { if (e.target === certUploadModal) closeCertModal(); });
certUploadModalForm.elements.issueDate.addEventListener("change", e => {
  const type = certUploadModalForm.elements.type.value;
  if (e.target.value && type) certUploadModalForm.elements.expiryDate.value = calcExpiry(e.target.value, CERTIFICATES[type].validYears);
});
certUploadModalForm.addEventListener("submit", async e => {
  e.preventDefault();
  const d    = formData(e.currentTarget);
  const emp  = state.employees.find(x => x.id === d.employeeId); if (!emp) return;
  const type = d.type;
  const file = e.currentTarget.elements.file.files[0];
  const prev = emp.certificates[type] || {};
  setSyncState("syncing");
  try {
    // Delete old storage file if replacing
    if (file && prev.file?.filePath) await deleteStorageFile(prev.file.filePath);
    const uploaded = file ? await readCertFile(file, emp.employeeId, type) : prev.file || null;
    const certData = {
      issueDate:  d.issueDate  || prev.issueDate  || "",
      expiryDate: d.expiryDate || prev.expiryDate || (d.issueDate ? calcExpiry(d.issueDate, CERTIFICATES[type].validYears) : ""),
      file: uploaded,
    };
    emp.certificates[type] = certData;
    // FIX BUG1: await the upsert immediately (no debounce for file ops), update _certIds
    const certId = await upsertCertificate(emp.id, type, certData, emp._certIds?.[type]);
    if (!emp._certIds) emp._certIds = {};
    emp._certIds[type] = certId;
    setSyncState("idle");
    closeCertModal(); renderAll();
    showToast(`${CERTIFICATES[type].label} saved for ${emp.name}.`);
  } catch(err) {
    console.error(err); setSyncState("error");
    showToast(`Save failed: ${err.message}`);
  }
});

// ── Schedule slots helpers ─────────────────────────────────────────────────────
function slotBookedCount(date) {
  // How many certificates (BFS + OHC) are scheduled on this date
  return getCertSummaries().filter(s => s.scheduledDate === date).length;
}
function upcomingSlots() {
  const today = new Date(); today.setHours(0,0,0,0);
  return state.slots.filter(sl => new Date(`${sl.date}T00:00:00`) >= today);
}

// ── Schedule modal ────────────────────────────────────────────────────────────
const scheduleModal     = document.getElementById("scheduleModal");
const scheduleModalForm = document.getElementById("scheduleModalForm");

function openScheduleModal(empId, type) {
  if (!canSchedule()) return;
  const emp = state.employees.find(x => x.id === empId); if (!emp) return;
  const cert = emp.certificates[type] || {};
  document.getElementById("scheduleModalTitle").textContent = `Schedule ${CERTIFICATES[type].label} Renewal - ${emp.name}`;
  scheduleModalForm.elements.employeeId.value   = empId;
  scheduleModalForm.elements.type.value         = type;
  scheduleModalForm.elements.scheduleNote.value = cert.scheduleNote || "";

  const dateWrap = document.getElementById("scheduleDateWrap");
  const slotWrap = document.getElementById("scheduleSlotWrap");
  const dateInput = scheduleModalForm.elements.scheduledDate;
  const slotSelect = scheduleModalForm.elements.scheduledSlot;

  if (isEditor) {
    // Editors: free date picker (full authority)
    dateWrap.classList.remove("hidden"); slotWrap.classList.add("hidden");
    dateInput.required = true; slotSelect.required = false;
    dateInput.value = cert.scheduledDate || "";
  } else {
    // Ops: can only pick from editor-approved slot dates
    dateWrap.classList.add("hidden"); slotWrap.classList.remove("hidden");
    dateInput.required = false; slotSelect.required = true;
    const slots = upcomingSlots();
    if (!slots.length) {
      slotSelect.innerHTML = `<option value="">No dates available -- contact HR</option>`;
    } else {
      slotSelect.innerHTML = [`<option value="">Select a date…</option>`, ...slots.map(sl => {
        const booked  = slotBookedCount(sl.date);
        const isCurrent = cert.scheduledDate === sl.date;
        const full    = booked >= sl.capacity && !isCurrent;
        const txt = `${fmtDate(sl.date)}${sl.label ? ` -- ${escHtml(sl.label)}` : ""} (${booked}/${sl.capacity}${full ? " FULL" : ""})`;
        return `<option value="${sl.date}" ${full ? "disabled" : ""} ${isCurrent ? "selected" : ""}>${txt}</option>`;
      })].join("");
    }
  }
  scheduleModal.classList.remove("hidden");
}

function closeScheduleModal() {
  scheduleModal.classList.add("hidden");
  scheduleModalForm.reset();
}

document.getElementById("scheduleModalClose").addEventListener("click", closeScheduleModal);
document.getElementById("scheduleModalCancel").addEventListener("click", closeScheduleModal);
scheduleModal.addEventListener("click", e => { if (e.target === scheduleModal) closeScheduleModal(); });

scheduleModalForm.addEventListener("submit", async e => {
  e.preventDefault(); if (!canSchedule()) return;
  const d    = formData(e.currentTarget);
  const emp  = state.employees.find(x => x.id === d.employeeId); if (!emp) return;
  const type = d.type;
  const prev = emp.certificates[type] || {};

  // Editors use the free date; ops use the slot dropdown
  const chosenDate = isEditor ? d.scheduledDate : d.scheduledSlot;
  if (!chosenDate) { showToast("Please select a date."); return; }

  if (!isEditor) {
    // Validate the slot server-side of the app: must exist, be upcoming, and have capacity
    const slot = upcomingSlots().find(sl => sl.date === chosenDate);
    if (!slot) { showToast("That date is not available. Please pick from the list."); return; }
    const booked = slotBookedCount(slot.date);
    const alreadyOnThisDate = prev.scheduledDate === slot.date;
    if (!alreadyOnThisDate && booked >= slot.capacity) {
      showToast(`❌ ${fmtDate(slot.date)} is full (${booked}/${slot.capacity}). Pick another date.`);
      openScheduleModal(d.employeeId, type); // refresh counts in dropdown
      return;
    }
  }

  const certData = { ...prev, scheduledDate: chosenDate, scheduleNote: d.scheduleNote || "" };
  emp.certificates[type] = certData;
  setSyncState("syncing");
  try {
    const certId = await upsertCertificate(emp.id, type, certData, emp._certIds?.[type]);
    if (!emp._certIds) emp._certIds = {};
    emp._certIds[type] = certId;
    setSyncState("idle"); closeScheduleModal(); renderAll();
    showToast(`✅ Renewal scheduled for ${emp.name} on ${fmtDate(chosenDate)}.`);
  } catch(err) { setSyncState("error"); showToast(`Save failed: ${err.message}`); }
});

document.getElementById("scheduleModalClear").addEventListener("click", async () => {
  if (!canSchedule()) return;
  const empId = scheduleModalForm.elements.employeeId.value;
  const type  = scheduleModalForm.elements.type.value;
  const emp   = state.employees.find(x => x.id === empId); if (!emp) return;
  if (!confirm("Clear the scheduled renewal date?")) return;
  const prev = emp.certificates[type] || {};
  const certData = { ...prev, scheduledDate: "", scheduleNote: "" };
  emp.certificates[type] = certData;
  setSyncState("syncing");
  try {
    await upsertCertificate(emp.id, type, certData, emp._certIds?.[type]);
    setSyncState("idle"); closeScheduleModal(); renderAll();
    showToast("Schedule cleared.");
  } catch(err) { setSyncState("error"); showToast(`Failed: ${err.message}`); }
});

// ── Schedule slots: editor management ─────────────────────────────────────────
const slotForm = document.getElementById("slotForm");
slotForm.addEventListener("submit", async e => {
  e.preventDefault(); if (!isEditor) return;
  const d = formData(e.currentTarget);
  const date  = d.slotDate;
  const label = (d.slotLabel || "").trim();
  if (!date) return;
  if (state.slots.some(sl => sl.date === date)) { showToast("That date is already in the list."); return; }
  setSyncState("syncing");
  try {
    const { data, error } = await sb.from("schedule_slots")
      .insert({ slot_date: date, label: label || null, capacity: 15, market: MARKET })
      .select().single();
    if (error) throw error;
    state.slots.push({ id: data.id, date: data.slot_date, label: data.label || "", capacity: data.capacity ?? 15 });
    state.slots.sort((a,b) => a.date.localeCompare(b.date));
    slotForm.reset(); setSyncState("idle"); renderSlots();
    showToast(`✅ ${fmtDate(date)} added to schedule dates.`);
  } catch(err) { setSyncState("error"); showToast(`Failed to add date: ${err.message}`); }
});

async function deleteSlot(id) {
  if (!isEditor) return;
  const slot = state.slots.find(sl => sl.id === id); if (!slot) return;
  const booked = slotBookedCount(slot.date);
  const msg = booked
    ? `Remove ${fmtDate(slot.date)}? ${booked} employee(s) are scheduled on this date -- their schedules will be KEPT, but ops cannot add more to it.`
    : `Remove ${fmtDate(slot.date)} from the schedule dates?`;
  if (!confirm(msg)) return;
  setSyncState("syncing");
  try {
    const { error } = await sb.from("schedule_slots").delete().eq("id", id);
    if (error) throw error;
    state.slots = state.slots.filter(sl => sl.id !== id);
    setSyncState("idle"); renderSlots();
    showToast("Schedule date removed.");
  } catch(err) { setSyncState("error"); showToast(`Failed: ${err.message}`); }
}

function renderSlots() {
  const el = document.getElementById("slotList"); if (!el) return;
  const today = new Date(); today.setHours(0,0,0,0);
  const slots = [...state.slots].sort((a,b) => a.date.localeCompare(b.date));
  if (!slots.length) { el.innerHTML = '<div class="empty-state">No schedule dates yet. Add dates above for the operations team.</div>'; return; }
  el.innerHTML = slots.map(sl => {
    const booked = slotBookedCount(sl.date);
    const past   = new Date(`${sl.date}T00:00:00`) < today;
    const full   = booked >= sl.capacity;
    const badgeTxt = past ? "past" : (full ? "FULL" : `${booked}/${sl.capacity}`);
    return `<div class="slot-item ${past ? "slot-past" : ""}">
      <div><strong>${fmtDate(sl.date)}</strong>${sl.label ? ` <span class="muted">-- ${escHtml(sl.label)}</span>` : ""}</div>
      <span class="slot-count ${full && !past ? "slot-full" : ""}">${badgeTxt}</span>
      <button class="text-btn danger" data-action="del-slot" data-id="${sl.id}" type="button">Remove</button>
    </div>`;
  }).join("");
}

// ── Per-section (BFS / OHC) wiring ────────────────────────────────────────────
function initSection(type) {
  // Use the section suffix from whichever market config has this type
  const allSuffixes = Object.assign({}, MARKET_CONFIG.UAE.sectionSuffix, MARKET_CONFIG.Qatar.sectionSuffix);
  const sfx = allSuffixes[type];
  if (!sfx) return; // unknown type, skip
  const employeeForm    = document.getElementById(`employeeForm${sfx}`);
  if (!employeeForm) return; // DOM element not found, skip
  const showBulkCertBtn = document.getElementById(`showBulkCert${sfx}`);
  const showBulkEmpBtn  = document.getElementById(`showBulkUpload${sfx}`);
  const bulkCertSection = document.getElementById(`bulkCertSection${sfx}`);
  const bulkEmpSection  = document.getElementById(`bulkEmpSection${sfx}`);
  const bulkUploadForm  = document.getElementById(`bulkUploadForm${sfx}`);
  const downloadTplBtn  = document.getElementById(`downloadEmployeeTemplate${sfx}`);
  const cancelEditBtn   = document.getElementById(`cancelEmployeeEdit${sfx}`);
  const bulkCertInput   = document.getElementById(`bulkCertInput${sfx}`);
  const bulkCertFolder  = document.getElementById(`bulkCertFolder${sfx}`);
  const bulkCertPreview = document.getElementById(`bulkCertPreview${sfx}`);
  const bulkCertActions = document.getElementById(`bulkCertActions${sfx}`);
  const bulkCertConfirm = document.getElementById(`bulkCertConfirm${sfx}`);
  const bulkCertClear   = document.getElementById(`bulkCertClear${sfx}`);
  const search          = document.getElementById(`employeeSearch${sfx}`);
  const deptFilter      = document.getElementById(`employeeDepartmentFilter${sfx}`);
  const statFilter      = document.getElementById(`employeeStatusFilter${sfx}`);
  const certificateForm = document.getElementById(`certificateForm${sfx}`);

  // Add / edit employee
  employeeForm.addEventListener("submit", async e => {
    e.preventDefault(); if (!isEditor) return;
    const d        = formData(e.currentTarget);
    let existing   = state.employees.find(x => x.id === d.editingId);
    const dupId    = state.employees.find(x => x.employeeId.toLowerCase() === d.employeeId.trim().toLowerCase() && x.id !== d.editingId);
    if (dupId) {
      if (UNIVERSAL_TYPES.includes(type) && certApplies(dupId, type)) { showToast("Employee ID already in use."); return; }
      // Existing ID not yet on this list: enroll that employee instead of rejecting
      existing = dupId;
    }
    const id        = existing?.id || crypto.randomUUID();
    const issueDate = parseDate(d[`${type}IssueDate`]);
    if (!issueDate && !certApplies(existing || {certificates:{}}, type)) {
      showToast(`${CERTIFICATES[type].label} Issue Date is required to add someone to this list.`); return;
    }
    const certData  = existing ? JSON.parse(JSON.stringify(existing.certificates)) : createEmptyCertificates();
    if (issueDate) certData[type] = { ...(certData[type]||{}), issueDate, expiryDate: calcExpiry(issueDate, CERTIFICATES[type].validYears) };
    const emp = { id, name: d.name.trim(), employeeId: d.employeeId.trim(), department: d.department.trim(),
                  certificates: certData, _certIds: existing?._certIds || {},
                  createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.employees = existing ? state.employees.map(x => x.id === existing.id ? emp : x) : [emp, ...state.employees];
    resetEmployeeForm(type); renderAll(); setSyncState("syncing");
    try {
      const dbId = await upsertEmployee(emp);
      // Save cert data for the added type
      if (issueDate) {
        const certId = await upsertCertificate(dbId, type, certData[type], emp._certIds?.[type]);
        const inState = state.employees.find(x => x.id === id);
        if (inState) { if (!inState._certIds) inState._certIds = {}; inState._certIds[type] = certId; }
      }
      // For group-shared types (e.g. BFS+OHC): ensure sibling types have an empty
      // cert record in DB so the employee appears in the sibling section too
      const group = getCertGroup(type);
      for (const sibling of group) {
        if (sibling === type) continue;
        if (!certData[sibling] || (!certData[sibling].issueDate && !certData[sibling].expiryDate)) {
          // Create an empty placeholder cert record so employee shows in sibling section
          const emptyCert = { issueDate: "", expiryDate: "", scheduledDate: "", scheduleNote: "" };
          certData[sibling] = emptyCert;
          const inState = state.employees.find(x => x.id === id);
          if (inState) inState.certificates[sibling] = emptyCert;
          const sibCertId = await upsertCertificate(dbId, sibling, emptyCert, emp._certIds?.[sibling]);
          if (inState) { if (!inState._certIds) inState._certIds = {}; inState._certIds[sibling] = sibCertId; }
        }
      }
      setSyncState("idle");
    } catch(err) { console.error(err); setSyncState("error"); showToast(`Save failed: ${err.message}`); }
    showToast(dupId ? `Added ${emp.name} to ${CERTIFICATES[type].label} list.` : existing ? "Employee updated." : "Employee added.");
  });

  cancelEditBtn.addEventListener("click", () => resetEmployeeForm(type));

  // Bulk cert toggle
  showBulkCertBtn.addEventListener("click", () => {
    const h = bulkCertSection.classList.toggle("hidden");
    bulkEmpSection.classList.add("hidden"); showBulkEmpBtn.textContent = "⬆ Bulk Upload Employees";
    showBulkCertBtn.textContent = h ? `📎 Bulk Upload ${CERTIFICATES[type].label} Files` : "✕ Close Files";
  });
  // Bulk emp toggle
  showBulkEmpBtn.addEventListener("click", () => {
    const h = bulkEmpSection.classList.toggle("hidden");
    bulkCertSection.classList.add("hidden"); showBulkCertBtn.textContent = `📎 Bulk Upload ${CERTIFICATES[type].label} Files`;
    showBulkEmpBtn.textContent = h ? "⬆ Bulk Upload Employees" : "✕ Close";
  });

  downloadTplBtn.addEventListener("click", () => downloadTemplate(type));

  // CSV bulk employee upload
  bulkUploadForm.addEventListener("submit", async e => {
    e.preventDefault(); if (!isEditor) return;
    const form = e.currentTarget;
    const file = form.elements.csvFile.files[0]; if (!file) return;
    const btn  = form.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Importing…";
    showProgressToast("Reading file…", 0);
    try {
      const result = await importFromCsv(await file.text());
      form.reset(); renderAll();
      hideProgressToast();
      showToast(`✅ Done: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped.`);
    } catch(err) {
      hideProgressToast();
      showToast(`❌ Import failed: ${err.message}`);
    } finally {
      btn.disabled = false; btn.textContent = "Upload & Import";
    }
  });

  // Bulk cert file upload
  let bulkRows = [];
  const CERT_FILE_RE = /\.(pdf|png|jpe?g|gif|webp|bmp|heic|heif)$/i;
  function handleBulkSelection(fileList) {
    const files = Array.from(fileList || []).filter(f => CERT_FILE_RE.test(f.name));
    if (!files.length) { bulkCertPreview.classList.add("hidden"); bulkCertActions.classList.add("hidden"); bulkRows = []; return; }
    bulkRows = buildPreview(files, type);
    renderPreview(bulkRows, bulkCertPreview, type);
    bulkCertActions.classList.remove("hidden");
  }
  bulkCertInput.addEventListener("change", () => handleBulkSelection(bulkCertInput.files));
  if (bulkCertFolder) bulkCertFolder.addEventListener("change", () => handleBulkSelection(bulkCertFolder.files));
  bulkCertConfirm.addEventListener("click", async () => {
    if (!isEditor) return;
    if (!bulkRows.length) { showToast("No files selected."); return; }
    const matchedCount = bulkRows.filter(r => r.match).length;
    if (!matchedCount) { showToast("No files matched any employee ID. Check filenames match Employee IDs e.g. CK-1024.pdf"); return; }

    // Disable button during upload
    const confirmBtn = document.getElementById(`bulkCertConfirm${sfx}`);
    confirmBtn.disabled = true; confirmBtn.textContent = "Uploading…";
    setSyncState("syncing");
    try {
      const count = await applyBulkFiles(bulkRows, type);
      hideProgressToast();
      setSyncState("idle"); renderAll();
      showToast(count > 0 ? `✅ ${count} ${CERTIFICATES[type].label} file(s) attached successfully.` : `⚠️ No files were attached -- check console for errors.`);
    } catch(err) {
      hideProgressToast();
      setSyncState("error");
      showToast(`❌ Bulk attach failed: ${err.message}`);
    } finally {
      confirmBtn.disabled = false; confirmBtn.textContent = "Attach Files";
    }
    bulkCertInput.value = ""; if (bulkCertFolder) bulkCertFolder.value = ""; bulkCertPreview.classList.add("hidden"); bulkCertActions.classList.add("hidden"); bulkRows = [];
  });
  bulkCertClear.addEventListener("click", () => {
    bulkCertInput.value = ""; if (bulkCertFolder) bulkCertFolder.value = ""; bulkCertPreview.classList.add("hidden"); bulkCertActions.classList.add("hidden"); bulkRows = [];
  });

  search.addEventListener("input",      () => renderSectionRows(type));
  deptFilter.addEventListener("change", () => renderSectionRows(type));
  statFilter.addEventListener("change", () => renderSectionRows(type));

  // Cert edit panel
  certificateForm.addEventListener("submit", async e => {
    e.preventDefault(); if (!isEditor) return;
    const d    = formData(e.currentTarget);
    const emp  = state.employees.find(x => x.id === d.employeeId); if (!emp) return;
    const file = e.currentTarget.elements.file.files[0];
    const prev = emp.certificates[type] || {};
    setSyncState("syncing");
    try {
      if (file && prev.file?.filePath) await deleteStorageFile(prev.file.filePath);
      const uploaded = file ? await readCertFile(file, emp.employeeId, type) : prev.file || null;
      const certData = { issueDate: d.issueDate, expiryDate: d.expiryDate || calcExpiry(d.issueDate, CERTIFICATES[type].validYears), file: uploaded };
      emp.certificates[type] = certData;
      // FIX BUG1: update _certIds after upsert
      const certId = await upsertCertificate(emp.id, type, certData, emp._certIds?.[type]);
      if (!emp._certIds) emp._certIds = {};
      emp._certIds[type] = certId;
      setSyncState("idle"); hideCertEdit(type); renderAll();
      showToast(`${CERTIFICATES[type].label} saved for ${emp.name}.`);
    } catch(err) { console.error(err); setSyncState("error"); showToast(`Save failed: ${err.message}`); }
  });
  certificateForm.elements.issueDate.addEventListener("change", e => {
    if (e.target.value) certificateForm.elements.expiryDate.value = calcExpiry(e.target.value, CERTIFICATES[type].validYears);
  });
  document.getElementById(`cancelCertEdit${sfx}`).addEventListener("click", () => hideCertEdit(type));
}

// ── Employee helpers ──────────────────────────────────────────────────────────
function resetEmployeeForm(type) {
  const sfx = SECTION_SUFFIX[type];
  document.getElementById(`employeeForm${sfx}`).reset();
  document.getElementById(`employeeForm${sfx}`).elements.editingId.value = "";
  document.getElementById(`employeeFormTitle${sfx}`).textContent    = "Add Employee";
  document.getElementById(`employeeSubmitButton${sfx}`).textContent = "Add Employee";
  document.getElementById(`cancelEmployeeEdit${sfx}`).classList.add("hidden");
}
function showCertEdit(empId, type) {
  const emp = state.employees.find(x => x.id === empId); if (!emp) return;
  const sfx  = SECTION_SUFFIX[type];
  const form = document.getElementById(`certificateForm${sfx}`);
  document.getElementById(`certEditTitle${sfx}`).textContent = `Edit ${CERTIFICATES[type].label} - ${emp.name}`;
  form.elements.employeeId.value = empId;
  form.elements.issueDate.value  = emp.certificates[type]?.issueDate  || "";
  form.elements.expiryDate.value = emp.certificates[type]?.expiryDate || "";
  document.getElementById(`certEditPanel${sfx}`).classList.remove("hidden");
  document.getElementById(`certEditPanel${sfx}`).scrollIntoView({ behavior: "smooth", block: "start" });
}
function hideCertEdit(type) {
  document.getElementById(`certEditPanel${SECTION_SUFFIX[type]}`).classList.add("hidden");
  document.getElementById(`certificateForm${SECTION_SUFFIX[type]}`).reset();
}
function editEmployee(id, type) {
  if (!isEditor) return;
  const e = state.employees.find(x => x.id === id); if (!e) return;
  const sfx  = SECTION_SUFFIX[type];
  const form = document.getElementById(`employeeForm${sfx}`);
  form.elements.editingId.value  = e.id;
  form.elements.name.value       = e.name;
  form.elements.employeeId.value = e.employeeId;
  form.elements.department.value = e.department;
  form.elements[`${type}IssueDate`].value = e.certificates?.[type]?.issueDate || "";
  document.getElementById(`employeeFormTitle${sfx}`).textContent    = `Editing: ${e.name}`;
  document.getElementById(`employeeSubmitButton${sfx}`).textContent = "Save Changes";
  document.getElementById(`cancelEmployeeEdit${sfx}`).classList.remove("hidden");
  showView(type); form.elements.name.focus();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function deleteEmployee(id) {
  if (!isEditor) return;
  const e = state.employees.find(x => x.id === id);
  if (!e || !confirm(`Remove ${e.name}?`)) return;
  // Delete storage files first
  for (const t of CERT_TYPES) { if (e.certificates[t]?.file?.filePath) await deleteStorageFile(e.certificates[t].file.filePath); }
  state.employees = state.employees.filter(x => x.id !== id);
  renderAll(); setSyncState("syncing");
  try { await deleteEmployeeFromDb(id); setSyncState("idle"); } catch(err) { setSyncState("error"); showToast(`Delete failed: ${err.message}`); }
  showToast("Employee removed.");
}
async function clearCertificate(empId, type) {
  if (!isEditor) return;
  const e = state.employees.find(x => x.id === empId);
  if (!e) return;
  const hasFile = e.certificates[type]?.file;
  const hasDates = e.certificates[type]?.issueDate;
  if (!hasFile && !hasDates) return;

  // Ask specifically what to delete
  const hasFileMsg = hasFile ? `certificate file "${e.certificates[type].file.name}"` : "";
  const confirmMsg = hasFile
    ? `Remove the uploaded ${CERTIFICATES[type].label} file for ${e.name}?

The issue date and expiry date will be kept.`
    : `Clear all ${CERTIFICATES[type].label} certificate dates for ${e.name}?`;
  if (!confirm(confirmMsg)) return;

  setSyncState("syncing");
  try {
    if (hasFile) {
      // Only remove the file -- keep issue date and expiry date
      const oldPath = e.certificates[type].file.filePath;
      if (oldPath) await deleteStorageFile(oldPath);
      e.certificates[type] = {
        ...e.certificates[type],
        file: null,
      };
      // Update DB row: null out file columns only, keep dates
      const { error } = await sb.from("certificates")
        .update({ file_name: null, file_path: null, updated_at: new Date().toISOString() })
        .eq("employee_id", empId)
        .eq("type", type);
      if (error) throw error;
      showToast(`${CERTIFICATES[type].label} file removed. Dates kept.`);
    } else {
      // No file -- wipe the whole cert record (dates only)
      e.certificates[type] = {};
      await deleteCertFromDb(empId, type);
      if (e._certIds) e._certIds[type] = null;
      showToast(`${CERTIFICATES[type].label} certificate cleared.`);
    }
    renderAll(); setSyncState("idle");
  } catch(err) {
    setSyncState("error");
    showToast(`Delete failed: ${err.message}`);
  }
}

// ── Delegated click handler ────────────────────────────────────────────────────
document.body.addEventListener("click", e => {
  const btn = e.target.closest("[data-action]"); if (!btn) return;
  const a = btn.dataset.action;
  if (a === "edit-emp")    editEmployee(btn.dataset.id, btn.dataset.section);
  if (a === "del-emp")     deleteEmployee(btn.dataset.id);
  if (a === "edit-cert")   showCertEdit(btn.dataset.eid, btn.dataset.type);
  if (a === "del-cert")    clearCertificate(btn.dataset.eid, btn.dataset.type);
  if (a === "upload-cert")  openCertModal(btn.dataset.eid, btn.dataset.type);
  if (a === "schedule-cert") openScheduleModal(btn.dataset.eid, btn.dataset.type);
  if (a === "del-slot")    deleteSlot(btn.dataset.id);
  if (a === "mail-alert")  openGmailDraft([JSON.parse(btn.dataset.item)]);
});

// ── Bulk cert file matching ────────────────────────────────────────────────────
function buildPreview(files, type) {
  return Array.from(files).map(f => {
    const match = matchFile(f.name);
    // Skip if this employee already has a certificate FILE attached for this type
    const already = !!(match && match.employee.certificates?.[type]?.file);
    return { file: f, match, already };
  });
}
function matchFile(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  const norm  = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const lower = base.toLowerCase();
  const nb    = norm(base);

  // 1. Exact employee ID match  (CK-1024.pdf)
  let emp = state.employees.find(e => e.employeeId.trim().toLowerCase() === lower);
  if (emp) return { employee: emp, how: "ID" };

  // 2. Exact full name match  (Ahmed Mohammed.pdf)
  emp = state.employees.find(e => e.name.trim().toLowerCase() === lower);
  if (emp) return { employee: emp, how: "name" };

  // 3. Normalised full name (ignores spaces/punctuation)  (AhmedMohammed.pdf)
  emp = state.employees.find(e => norm(e.name) === nb);
  if (emp) return { employee: emp, how: "name" };

  // 4. First name only -- file base matches first word of employee name  (Ahmed.pdf)
  emp = state.employees.find(e => e.name.trim().toLowerCase().split(/\s+/)[0] === lower);
  if (emp) return { employee: emp, how: "first name" };

  // 5. Employee name STARTS WITH file base  (Ajay.pdf -> Ajay Kumar)
  emp = state.employees.find(e => norm(e.name).startsWith(nb) && nb.length >= 4);
  if (emp) return { employee: emp, how: "partial" };

  // 6. File base is contained within employee name  (AjayKumar.pdf -> Ajay Kumar)
  emp = state.employees.find(e => norm(e.name).includes(nb) && nb.length >= 4);
  if (emp) return { employee: emp, how: "partial" };

  return null;
}
function renderPreview(rows, el, type) {
  const toUpload = rows.filter(r => r.match && !r.already).length;
  const skipped  = rows.filter(r => r.match && r.already).length;
  const unmatched = rows.length - toUpload - skipped;
  let html = `<p class="bulk-summary"><strong>${CERTIFICATES[type].label}</strong> · ${toUpload} new file(s) will be uploaded`
    + (skipped ? ` · <span class="status-expiring">${skipped} skipped (already uploaded)</span>` : ``)
    + (unmatched ? ` · <span class="status-expired">${unmatched} no match</span>` : ``) + `</p>`;
  html += `<div class="table-wrap"><table><thead><tr><th>File</th><th>Matched Employee</th><th>Status</th></tr></thead><tbody>`;
  rows.forEach(r => {
    const matchCell = r.match
      ? `<span class="${r.already ? "muted" : "status-valid"}">${escHtml(r.match.employee.name)}</span>`
      : `<span class="status-expired">No match</span>`;
    let statusCell;
    if (!r.match)        statusCell = `<span class="muted">--</span>`;
    else if (r.already)  statusCell = `<span class="status-expiring">Already uploaded -- will skip</span>`;
    else                 statusCell = `<span class="status-valid">Will upload (${escHtml(r.match.how)})</span>`;
    html += `<tr><td>${escHtml(r.file.name)}</td><td>${matchCell}</td><td>${statusCell}</td></tr>`;
  });
  html += `</tbody></table></div>`;
  el.innerHTML = html; el.classList.remove("hidden");
}
async function applyBulkFiles(rows, type) {
  const skipped = rows.filter(r => r.match && r.already).length;
  const matched = rows.filter(r => r.match && !r.already);
  if (!matched.length) {
    showToast(skipped ? `All ${skipped} matched file(s) already uploaded -- nothing to do.` : "No files matched any employee ID.");
    return 0;
  }
  if (skipped) showToast(`Skipping ${skipped} file(s) already uploaded…`);

  let count = 0, failed = 0;
  for (let i = 0; i < matched.length; i++) {
    const r   = matched[i];
    const emp = state.employees.find(e => e.id === r.match.employee.id);
    if (!emp) continue;

    const pct = Math.round(((i) / matched.length) * 90);
    showProgressToast(`Uploading ${i + 1} of ${matched.length}: ${r.file.name}`, pct);

    try {
      // Delete old storage file if replacing
      if (emp.certificates[type]?.file?.filePath) await deleteStorageFile(emp.certificates[type].file.filePath);

      // Use employeeId (text code) as the storage folder -- not the DB UUID
      const fileObj  = await readCertFile(r.file, emp.employeeId, type);
      const certData = { ...(emp.certificates[type] || {}), file: fileObj };
      emp.certificates[type] = certData;

      // Upsert the cert record -- upsertCertificate resolves the real DB id internally
      const certId = await upsertCertificate(emp.id, type, certData, emp._certIds?.[type]);
      if (!emp._certIds) emp._certIds = {};
      emp._certIds[type] = certId;
      count++;
    } catch(err) {
      failed++;
      console.error(`Failed to attach ${r.file.name}:`, err.message);
      showToast(`❌ Failed: ${r.file.name} -- ${err.message}`);
      await new Promise(r => setTimeout(r, 1500)); // show error briefly
    }
  }

  showProgressToast("Saving to database…", 95);
  return count;
}

// ── Alert settings ─────────────────────────────────────────────────────────────
alertSettingsForm.addEventListener("submit", async e => {
  e.preventDefault();
  const d = formData(e.currentTarget);
  state.settings = { reminderDays: Number(d.reminderDays), managerEmail: (d.managerEmail||"").trim().toLowerCase() };
  setSyncState("syncing");
  try { await saveSettingsToDb(state.settings); setSyncState("idle"); } catch(err) { setSyncState("error"); }
  renderAll();
  openGmailDraft(getAlertItems().map(summaryToItem));
});
document.getElementById("prepareAllAlerts").addEventListener("click", () => openGmailDraft(getAlertItems().map(summaryToItem)));
document.getElementById("exportPdf").addEventListener("click", exportPDF);
document.getElementById("exportPdfTop").addEventListener("click", exportPDF);

// ── Gmail draft ────────────────────────────────────────────────────────────────
function openGmailDraft(items) {
  if (!items.length) { showToast("No alerts due."); return; }
  const to      = state.settings.managerEmail || "";
  const subject = encodeURIComponent(`${MARKET} Kitchen Certificate Alert - ${items.length} item(s) need attention`);
  const lines   = ["Hello,","",`The following ${items.length} certificate renewal(s) require attention:`,"",
    ...items.map(i=>`• ${i.employeeName} (${i.employeeId}) · ${i.certType}: ${i.status}`+(i.expiryDate?` · Expires: ${fmtDate(i.expiryDate)}`:"")+(i.daysLeft!==null?` · ${fmtDays(i.daysLeft)}`:"")),
    "","Please arrange renewals and update the portal once new certificates are issued.","","Calo Compliance Portal - " + MARKET + " Kitchen"];
  window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${subject}&body=${encodeURIComponent(lines.join("\n"))}`, "_blank");
  showToast("Opening Gmail draft…");
}

// ── Render ─────────────────────────────────────────────────────────────────────
function render() {
  const ok = Boolean(session?.email);
  loginView.classList.toggle("hidden", ok);
  appShell.classList.toggle("hidden", !ok);
  document.getElementById("signedInEmail").textContent = session?.email || "--";
  if (!ok) return;
  document.querySelectorAll(".editor-only").forEach(el => el.classList.toggle("hidden", !isEditor));
  document.querySelectorAll(".editor-only-col").forEach(el => el.classList.toggle("hidden", !isEditor));
  const badgeEl = document.getElementById("viewerBadge");
  badgeEl.classList.toggle("hidden", isEditor);
  badgeEl.textContent = isOps ? "🗓 Operations · scheduling access" : "👁 View only";
  renderAll();
}
function renderAll() {
  renderDeptFilterOptions(); renderDashboard();
  CERT_TYPES.forEach(renderSectionRows);
  renderAlertSettings(); renderAlertQueue(); renderSlots();
}
function renderDeptFilterOptions() {
  const depts = [...new Set(state.employees.map(e=>e.department).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  CERT_TYPES.forEach(type => {
    const el  = document.getElementById(`employeeDepartmentFilter${SECTION_SUFFIX[type]}`);
    const cur = el.value || "all";
    el.innerHTML = ['<option value="all">All departments</option>', ...depts.map(d=>`<option value="${escHtml(d)}">${escHtml(d)}</option>`)].join("");
    el.value = depts.includes(cur) ? cur : "all";
  });
}
function renderDashboard() {
  const sums   = getCertSummaries();
  const by     = countBy(sums,"status");
  // Urgent by REAL status -- includes scheduled items so they show in the scheduled section below
  const urgent = sums.filter(s=>s.rawStatus==="Expired"||s.rawStatus==="Expiring in 30 Days").sort((a,b)=>a.daysLeft-b.daysLeft);
  const uc     = (by.Expired||0)+(by["Expiring in 30 Days"]||0); // excludes scheduled = still needs action
  // Split urgent into unscheduled (needs action) and scheduled (being handled)
  const unscheduled = urgent.filter(s => s.status !== "Scheduled");
  const scheduled   = urgent.filter(s => s.status === "Scheduled");
  document.getElementById("employeeMetric").textContent = state.employees.length;
  document.getElementById("urgentMetric").textContent   = uc;
  document.getElementById("attentionCount").textContent = `${unscheduled.length} items` + (scheduled.length ? ` · ${scheduled.length} scheduled` : ``);
  const pill = document.getElementById("overallStatus");
  pill.textContent = uc ? "Action Needed" : "Compliant"; pill.classList.toggle("risk", Boolean(uc));
  CERT_TYPES.forEach(type => {
    const typeSums = state.employees.filter(e=>certApplies(e,type)).map(e=>getCertSummary(e,type));
    // Count by REAL status (expiry-date based) -- scheduling never moves a cert out of these boxes
    const tb = countBy(typeSums,"rawStatus");
    document.getElementById(`${type}ValidMetric`).textContent   = tb.Valid||0;
    document.getElementById(`${type}NinetyMetric`).textContent  = tb["Expiring in 90 Days"]||0;
    document.getElementById(`${type}ThirtyMetric`).textContent  = tb["Expiring in 30 Days"]||0;
    document.getElementById(`${type}ExpiredMetric`).textContent = tb.Expired||0;
    document.getElementById(`${type}MissingMetric`).textContent = tb.Missing||0;
    // Scheduled = certs with a renewal date set (overlaps with the counts above)
    document.getElementById(`${type}ScheduledMetric`).textContent = typeSums.filter(s => s.scheduledDate && s.rawStatus !== "Valid").length;
  });

  const allDashRows = [
    ...unscheduled.map(s => `<tr>
      <td>${escHtml(s.emp.name)}<br><small>${escHtml(s.emp.employeeId)}</small></td>
      <td>${escHtml(s.cert.label)}</td>
      <td>${fmtDate(s.expiryDate)}</td>
      <td>${badge(s.rawStatus, s.scheduledDate)}</td>
      <td><button class="send-manager-btn" type="button" data-action="mail-alert" data-item='${escAttr(JSON.stringify(summaryToItem(s)))}'>✉ Send to Manager</button></td>
    </tr>`),
    ...(scheduled.length ? [`<tr><td colspan="5" class="dash-section-divider">📅 Scheduled renewals (${scheduled.length})</td></tr>`] : []),
    ...scheduled.map(s => `<tr class="scheduled-row">
      <td>${escHtml(s.emp.name)}<br><small>${escHtml(s.emp.employeeId)}</small></td>
      <td>${escHtml(s.cert.label)}</td>
      <td>${fmtDate(s.expiryDate)}</td>
      <td>${badge(s.status, s.scheduledDate)}</td>
      <td><span class="schedule-note-inline">${s.scheduleNote ? escHtml(s.scheduleNote) : "--"}</span></td>
    </tr>`),
  ];
  setRows("attentionRows", allDashRows, 5, "No urgent renewals.");
  const grouped = sums.reduce((g,s)=>{
    const d=s.emp.department||"Unassigned"; g[d]||={d,total:0,urgent:0,warn:0};
    g[d].total++; if(s.status==="Expired"||s.status==="Expiring in 30 Days")g[d].urgent++; if(s.status==="Expiring in 90 Days")g[d].warn++;
    return g;
  },{});
  document.getElementById("departmentRiskList").innerHTML=Object.values(grouped).sort((a,b)=>b.urgent-a.urgent).map(x=>
    `<div class="risk-item"><strong>${escHtml(x.d)}</strong><span>${x.urgent} urgent · ${x.warn} due soon · ${x.total} total</span></div>`
  ).join("")||'<div class="empty-state">No records yet.</div>';
}
function renderSectionRows(type) {
  const sfx  = SECTION_SUFFIX[type];
  const q    = document.getElementById(`employeeSearch${sfx}`).value.trim().toLowerCase();
  const dept = document.getElementById(`employeeDepartmentFilter${sfx}`).value;
  const stat = document.getElementById(`employeeStatusFilter${sfx}`).value;
  const emps = state.employees.filter(e => {
    if (!certApplies(e,type)) return false;
    const s = getCertSummary(e,type);
    return [e.name,e.employeeId,e.department].join(" ").toLowerCase().includes(q)
      && (dept==="all"||e.department===dept)
      && (stat==="all"||(stat==="Expiring"?(s.status==="Expiring in 30 Days"||s.status==="Expiring in 90 Days"):s.status===stat));
  });
  const emptyMsg = UNIVERSAL_TYPES.includes(type)
    ? "No employees match this filter."
    : `No employees enrolled in ${CERTIFICATES[type].label} yet. Add them via the form above (use their existing Employee ID), bulk CSV, or by uploading their certificate file.`;
  setRows(`staffRows${sfx}`, emps.map(e=>{
    const s = getCertSummary(e,type);
    const uploadBtn = isEditor && !s.record.file
      ? `<button class="upload-cert-btn" title="Upload ${CERTIFICATES[type].label} file" data-action="upload-cert" data-eid="${e.id}" data-type="${type}">＋</button>` : "";
    const scheduleBtn = canSchedule() && s.status !== "Valid"
      ? `<button class="schedule-btn ${s.status==="Scheduled"?"scheduled-active":""}" title="${s.status==="Scheduled"?`Scheduled: ${fmtDate(s.scheduledDate)}`:"Schedule renewal"}" data-action="schedule-cert" data-eid="${e.id}" data-type="${type}">📅 ${s.status==="Scheduled"?"Rescheduled":"Schedule"}</button>` : "";
    const editorActions = isEditor ? `
      <button class="text-btn" data-action="edit-emp" data-id="${e.id}" data-section="${type}">Edit</button>
      <button class="text-btn danger" data-action="del-emp" data-id="${e.id}">Remove</button>` : "";
    return `<tr>
      <td><strong>${escHtml(e.name)}</strong></td><td>${escHtml(e.employeeId)}</td><td>${escHtml(e.department)}</td>
      <td>
        ${isEditor?`<button class="cert-status-btn" data-action="edit-cert" data-eid="${e.id}" data-type="${type}">${badge(s.status,s.scheduledDate)}</button>`:badge(s.status,s.scheduledDate)}
        ${scheduleBtn}
      </td>
      <td>${fmtDate(s.issueDate)}</td><td>${fmtDate(s.expiryDate)}</td>
      <td class="cert-file-cell">
        ${uploadBtn}${fileLink(s.record.file)}
        ${isEditor&&s.record.file?`<button class="icon-btn danger" title="Remove certificate file (keeps dates)" data-action="del-cert" data-eid="${e.id}" data-type="${type}">🗑</button>`:""}
      </td>
      ${isEditor?`<td class="row-actions editor-only">${editorActions}</td>`:""}
    </tr>`;
  }), isEditor?8:7, emptyMsg);
}
function renderAlertSettings() {
  alertSettingsForm.elements.reminderDays.value = String(state.settings.reminderDays);
  alertSettingsForm.elements.managerEmail.value = state.settings.managerEmail||"";
}
function renderAlertQueue() {
  const items = getAlertItems();
  document.getElementById("alertQueue").innerHTML = items.length
    ? items.map(s=>`<div class="alert-item">
        <div><strong>${escHtml(s.emp.name)} · ${escHtml(s.cert.label)} ${escHtml(s.rawStatus.toLowerCase())}</strong>
        <span>${escHtml(s.emp.department)} · expires ${fmtDate(s.expiryDate)} · ${fmtDays(s.daysLeft)}</span></div>
        <div class="alert-actions"><button class="primary-btn send-manager-btn" data-action="mail-alert" data-item='${escAttr(JSON.stringify(summaryToItem(s)))}'>✉ Send to Manager</button></div>
      </div>`).join("")
    : '<div class="empty-state">No alerts due.</div>';
}

// ── Certificate logic ──────────────────────────────────────────────────────────
function getCertSummaries() { return state.employees.flatMap(e=>CERT_TYPES.filter(t=>certApplies(e,t)).map(t=>getCertSummary(e,t))); }
function getCertSummary(emp,type) {
  const cert=CERTIFICATES[type], record=emp.certificates[type]||{};
  const issueDate=record.issueDate||"", expiryDate=record.expiryDate||(issueDate?calcExpiry(issueDate,cert.validYears):"");
  const daysLeft=expiryDate?daysUntil(expiryDate):Infinity;
  const rawStatus=certStatus(expiryDate);
  const scheduledDate=record.scheduledDate||"";
  const scheduleNote=record.scheduleNote||"";
  const status=effectiveStatus(rawStatus, scheduledDate);
  return {emp,type,cert,record,issueDate,expiryDate,daysLeft,rawStatus,status,scheduledDate,scheduleNote};
}
function certStatus(exp){if(!exp)return"Missing";const d=daysUntil(exp);if(d<0)return"Expired";if(d<=30)return"Expiring in 30 Days";if(d<=90)return"Expiring in 90 Days";return"Valid";}
// Returns "Scheduled" if a scheduledDate is set and cert is not Valid
function effectiveStatus(status, scheduledDate) {
  if (status === "Valid") return "Valid";
  if (scheduledDate) return "Scheduled";
  return status;
}
function daysUntil(ds){const t=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate());return Math.ceil((t(new Date(`${ds}T00:00:00`))-t(new Date()))/86400000);}
function calcExpiry(issue,years){const d=new Date(`${issue}T00:00:00`);d.setFullYear(d.getFullYear()+years);return d.toISOString().slice(0,10);}
function summaryToItem(s){return{employeeName:s.emp.name,employeeId:s.emp.employeeId,department:s.emp.department,certType:s.cert.label,status:s.status,expiryDate:s.expiryDate||null,daysLeft:isFinite(s.daysLeft)?s.daysLeft:null};}
function getAlertItems(){return getCertSummaries().filter(s=>s.status!=="Missing"&&s.status!=="Scheduled"&&s.status!=="Valid"&&(s.daysLeft<0||s.daysLeft<=state.settings.reminderDays)).sort((a,b)=>a.daysLeft-b.daysLeft);}

// ── CSV import ─────────────────────────────────────────────────────────────────
async function importFromCsv(text) {
  const allRows = parseCsv(text).filter(r => r.some(c => c.trim()));
  if (allRows.length < 2) return { added: 0, updated: 0, skipped: 0 };
  const hdrs = allRows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const dataRows = allRows.slice(1);
  const getCol = (row, k) => { const i = hdrs.indexOf(k); return i >= 0 ? (row[i] || "").trim() : ""; };
  showProgressToast("Parsing " + dataRows.length + " rows...", 5);
  const empMap = new Map();
  let skipped = 0, addedCount = 0, updatedCount = 0;
  for (const raw of dataRows) {
    const row = [...raw]; while (row.length < hdrs.length) row.push("");
    const empId = getCol(row,"employeeid"), name = getCol(row,"name"), dept = getCol(row,"department");
    if (!empId || !name || !dept) { skipped++; continue; }
    const certDates = {};
    CERT_TYPES.forEach(t => { const d = parseDate(getCol(row, t + "issuedate")); if (d) certDates[t] = d; });
    const existing = state.employees.find(e => e.employeeId.toLowerCase() === empId.toLowerCase());
    const createdAt = existing?.createdAt || new Date().toISOString();
    const empRow = { name, employee_id: empId, department: dept, market: MARKET, created_at: createdAt, updated_at: new Date().toISOString() };
    empMap.set(empId.toLowerCase(), { empRow, certDates, isNew: !existing });
  }
  const allEntries = [...empMap.values()];
  if (!allEntries.length) return { added: 0, updated: 0, skipped };
  allEntries.forEach(e => e.isNew ? addedCount++ : updatedCount++);
  const BATCH = 200, empIdToDbId = {};
  showProgressToast("Writing " + allEntries.length + " employees...", 30);
  for (let i = 0; i < allEntries.length; i += BATCH) {
    const chunk = allEntries.slice(i, i + BATCH).map(e => e.empRow);
    const pct = 30 + Math.round((i / allEntries.length) * 40);
    showProgressToast("Writing employees " + (i+1) + "-" + Math.min(i+BATCH,allEntries.length) + " of " + allEntries.length + "...", pct);
    const { data: upserted, error } = await sb.from("employees")
      .upsert(chunk, { onConflict: "employee_id" }).select("id, employee_id");
    if (error) throw new Error("Employee upsert failed: " + error.message);
    (upserted || []).forEach(r => { empIdToDbId[r.employee_id.toLowerCase()] = r.id; });
  }
  const certRows = [];
  for (const { empRow, certDates } of allEntries) {
    const realId = empIdToDbId[empRow.employee_id.toLowerCase()];
    if (!realId) continue;
    // Track which types already have data so we can fill siblings
    const typesWithData = CERT_TYPES.filter(t => certDates[t]);
    // Add cert rows for types that have data from CSV
    CERT_TYPES.forEach(type => {
      if (certDates[type]) {
        certRows.push({ employee_id: realId, type, market: MARKET,
          issue_date: certDates[type],
          expiry_date: calcExpiry(certDates[type], CERTIFICATES[type].validYears),
          updated_at: new Date().toISOString() });
      }
    });
    // For group-shared types: if ANY type in a group has data, create empty
    // placeholder records for siblings so employee appears in all group sections
    const cfg = MARKET_CONFIG[MARKET];
    if (cfg && cfg.certGroups) {
      cfg.certGroups.forEach(group => {
        const groupHasData = group.some(t => certDates[t]);
        if (!groupHasData) return; // no data for this group, skip
        group.forEach(sibling => {
          if (certDates[sibling]) return; // already has data, skip
          // Create empty placeholder so employee shows in sibling section
          certRows.push({ employee_id: realId, type: sibling, market: MARKET,
            issue_date: null, expiry_date: null, updated_at: new Date().toISOString() });
        });
      });
    }
  }
  if (certRows.length > 0) {
    showProgressToast("Writing " + certRows.length + " certificate records...", 75);
    for (let i = 0; i < certRows.length; i += BATCH) {
      const { error } = await sb.from("certificates").upsert(certRows.slice(i,i+BATCH), { onConflict: "employee_id,type" });
      if (error) throw new Error("Certificate upsert failed: " + error.message);
    }
  }
  showProgressToast("Reloading data...", 90);
  await loadFromSupabase();
  setSyncState("idle");
  return { added: addedCount, updated: updatedCount, skipped };
}

function downloadTemplate(type) {
  const certCols = CERT_TYPES.map(t => t + "IssueDate");
  const cols = ["employeeId","name","department"].concat(certCols);
  const ex   = ["EMP-1001","Sample Employee","Kitchen"].concat(CERT_TYPES.map(() => "2026-01-15"));
  const slug = MARKET.toLowerCase().replace(/\s+/g, "-");
  downloadFile(slug + "-certs-template-" + today() + ".csv",
    [cols,ex].map(r => r.map(csvEsc).join(",")).join("\n"), "text/csv;charset=utf-8;");
}

// ── PDF export ─────────────────────────────────────────────────────────────────
function exportPDF() {
  if (!window.jspdf?.jsPDF) { showToast("PDF library still loading -- try again."); return; }
  const {jsPDF}=window.jspdf, doc=new jsPDF({unit:"pt",format:"a4"});
  const pageW=doc.internal.pageSize.getWidth(), margin=40; let y=50;

  // ── Header ──────────────────────────────────────────────────────────────────
  doc.setFont("helvetica","bold");doc.setFontSize(20);doc.setTextColor(17,24,39);doc.text("CALO",margin,y);
  doc.setFontSize(11);doc.setFont("helvetica","normal");doc.setTextColor(107,114,128);doc.text((MARKET_CONFIG[MARKET] ? MARKET_CONFIG[MARKET].navLabel : MARKET) + " Compliance Portal",margin,y+16);
  doc.setFontSize(14);doc.setFont("helvetica","bold");doc.setTextColor(17,24,39);doc.text("Staff Certificate Compliance Report -- " + MARKET,margin,y+40);
  doc.setFontSize(9);doc.setFont("helvetica","normal");doc.setTextColor(107,114,128);doc.text(`Generated: ${fmtDate(today())}`,margin,y+56);y+=80;

  // ── Collect data ─────────────────────────────────────────────────────────────
  const sums=getCertSummaries();
  const typeCounts = Object.fromEntries(CERT_TYPES.map(t=>[t, countBy(state.employees.filter(e=>certApplies(e,t)).map(e=>getCertSummary(e,t)),"status")]));
  const scheduledSums = sums.filter(s=>s.status==="Scheduled");
  const unhandled     = sums.filter(s=>["Expired","Expiring in 30 Days","Expiring in 90 Days","Missing"].includes(s.rawStatus)&&!s.scheduledDate);
  const uc = (sums.filter(s=>s.rawStatus==="Expired"||s.rawStatus==="Expiring in 30 Days").length);

  // ── Executive summary tiles ──────────────────────────────────────────────────
  doc.setFontSize(11);doc.setFont("helvetica","bold");doc.setTextColor(17,24,39);doc.text("EXECUTIVE SUMMARY",margin,y);y+=14;
  const tiles=[
    {label:"TOTAL EMPLOYEES",   value:state.employees.length},
    ...CERT_TYPES.flatMap(t=>{const L=CERTIFICATES[t].label,b=typeCounts[t];return[
      {label:`${L} VALID`,        value:b.Valid||0},
      {label:`${L} EXPIRING 30D`, value:b["Expiring in 30 Days"]||0},
      {label:`${L} EXPIRED`,      value:b.Expired||0},
    ];}),
    {label:"ACTION NEEDED",     value:uc},
    {label:"SCHEDULED RENEWALS",value:scheduledSums.length},
    {label:"UNHANDLED",         value:unhandled.length},
  ];
  const tc=5,gap=8,tH=52,tW=(pageW-margin*2-gap*(tc-1))/tc;
  tiles.forEach((t,i)=>{
    const col=i%tc,row=Math.floor(i/tc),x=margin+col*(tW+gap),ty=y+row*(tH+gap);
    const isUrgent=t.label==="ACTION NEEDED"||t.label==="UNHANDLED";
    const isGood=t.label==="SCHEDULED RENEWALS";
    doc.setDrawColor(226,230,236);
    if(isUrgent){doc.setFillColor(254,226,226);}else if(isGood){doc.setFillColor(220,252,231);}else{doc.setFillColor(248,250,252);}
    doc.roundedRect(x,ty,tW,tH,4,4,"FD");
    doc.setFontSize(6.5);doc.setFont("helvetica","bold");
    if(isUrgent){doc.setTextColor(185,28,28);}else if(isGood){doc.setTextColor(21,128,61);}else{doc.setTextColor(107,114,128);}
    doc.text(t.label,x+8,ty+16,{maxWidth:tW-16});
    doc.setFontSize(18);doc.setFont("helvetica","bold");
    if(isUrgent){doc.setTextColor(185,28,28);}else if(isGood){doc.setTextColor(21,128,61);}else{doc.setTextColor(17,24,39);}
    doc.text(String(t.value),x+8,ty+38);
  });
  y+=Math.ceil(tiles.length/tc)*(tH+gap)+18;

  // ── Scheduled Renewals section ───────────────────────────────────────────────
  if (scheduledSums.length>0) {
    if(y>580){doc.addPage();y=50;}
    doc.setFontSize(11);doc.setFont("helvetica","bold");doc.setTextColor(21,128,61);
    doc.text("📅  Scheduled Renewals",margin,y);
    doc.autoTable({
      startY:y+8, margin:{left:margin,right:margin},
      head:[["Name","ID","Department","Certificate","Cert Status","Renewal Date","Note"]],
      body:scheduledSums.sort((a,b)=>a.scheduledDate.localeCompare(b.scheduledDate)).map(s=>[
        s.emp.name, s.emp.employeeId, s.emp.department,
        s.cert.label, s.rawStatus,
        fmtDate(s.scheduledDate),
        s.scheduleNote||"--"
      ]),
      styles:{fontSize:8,cellPadding:5},
      headStyles:{fillColor:[21,128,61],textColor:255,fontStyle:"bold"},
      columnStyles:{
        4:{textColor:[185,28,28],fontStyle:"bold"},
        5:{textColor:[21,128,61],fontStyle:"bold"},
      },
      theme:"grid"
    });
    y=doc.lastAutoTable.finalY+26;
  }

  // ── Unhandled (needs action) section ─────────────────────────────────────────
  if (unhandled.length>0) {
    if(y>580){doc.addPage();y=50;}
    doc.setFontSize(11);doc.setFont("helvetica","bold");doc.setTextColor(185,28,28);
    doc.text("⚠  Needs Immediate Action",margin,y);
    doc.autoTable({
      startY:y+8, margin:{left:margin,right:margin},
      head:[["Name","ID","Department","Certificate","Status","Expiry Date","Days"]],
      body:unhandled.sort((a,b)=>a.daysLeft-b.daysLeft).map(s=>[
        s.emp.name, s.emp.employeeId, s.emp.department,
        s.cert.label, s.rawStatus, fmtDate(s.expiryDate),
        isFinite(s.daysLeft)?(s.daysLeft<0?`${Math.abs(s.daysLeft)}d overdue`:`${s.daysLeft}d left`):"--"
      ]),
      styles:{fontSize:8,cellPadding:5},
      headStyles:{fillColor:[185,28,28],textColor:255,fontStyle:"bold"},
      columnStyles:{4:{textColor:[185,28,28],fontStyle:"bold"},6:{textColor:[185,28,28]}},
      theme:"grid"
    });
    y=doc.lastAutoTable.finalY+26;
  }

  // ── Full registers (one per certificate type) ────────────────────────────────
  const registerColors = { bfs:[22,163,74], ohc:[109,40,217], fsc:[220,38,38], fac:[2,132,199] };
  CERT_TYPES.forEach(t => {
    if(y>580){doc.addPage();y=50;}
    doc.setFontSize(11);doc.setFont("helvetica","bold");doc.setTextColor(17,24,39);
    doc.text(`${CERTIFICATES[t].label} -- ${CERTIFICATES[t].fullName} (Full Register)`,margin,y);
    doc.autoTable({
      startY:y+8,margin:{left:margin,right:margin},
      head:[["Name","ID","Department","Status","Issue Date","Expiry Date","Renewal Scheduled"]],
      body:state.employees.filter(e=>certApplies(e,t)).map(e=>{
        const s=getCertSummary(e,t);
        return[e.name,e.employeeId,e.department,s.status,fmtDate(s.issueDate),fmtDate(s.expiryDate),s.scheduledDate?fmtDate(s.scheduledDate):"--"];
      }),
      styles:{fontSize:8,cellPadding:4},
      headStyles:{fillColor:registerColors[t]||[55,65,81],textColor:255,fontStyle:"bold"},
      didParseCell: (data) => {
        if(data.section==="body"&&data.column.index===3) {
          const v=data.cell.raw;
          if(v==="Expired"||v==="Expiring in 30 Days") data.cell.styles.textColor=[185,28,28];
          else if(v==="Scheduled") data.cell.styles.textColor=[21,128,61];
          else if(v==="Valid") data.cell.styles.textColor=[21,128,61];
        }
      },
      theme:"grid"
    });
    y=doc.lastAutoTable.finalY+26;
  });

  // ── Footer on every page ─────────────────────────────────────────────────────
  const pc=doc.internal.getNumberOfPages();
  for(let p=1;p<=pc;p++){
    doc.setPage(p);
    doc.setFontSize(8);doc.setTextColor(156,163,175);
    doc.text(`UAE Kitchen Compliance Portal · Confidential · Page ${p} of ${pc}`,pageW/2,doc.internal.pageSize.getHeight()-20,{align:"center"});
  }
  doc.save(`${MARKET.toLowerCase()}-kitchen-compliance-${today()}.pdf`);
  showToast("PDF report ready.");
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function createEmptyCertificates(){return Object.fromEntries(CERT_TYPES.map(t=>[t,{}]));}
function formData(form){return Object.fromEntries(new FormData(form).entries());}
function setRows(id,rows,cols,empty){document.getElementById(id).innerHTML=rows.length?rows.join(""):`<tr><td colspan="${cols}" class="empty-state">${empty}</td></tr>`;}
function countBy(arr,key){return arr.reduce((c,i)=>{c[i[key]]=(c[i[key]]||0)+1;return c;},{});}
function badge(status, scheduledDate=""){
  if(status==="Scheduled") return`<span class="badge scheduled" title="Scheduled for ${fmtDate(scheduledDate)}">📅 Scheduled ${fmtDate(scheduledDate)}</span>`;
  const cls=status==="Valid"?"good":status==="Expiring in 90 Days"?"watch":status==="Expiring in 30 Days"?"warn":status==="Missing"?"neutral":"bad";
  return`<span class="badge ${cls}">${escHtml(status)}</span>`;
}
function fmtDate(v){if(!v)return"--";return new Intl.DateTimeFormat("en-US",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(`${v}T00:00:00`));}
function fmtDays(d){if(!isFinite(d))return"not recorded";if(d<0)return`${Math.abs(d)} days overdue`;if(d===0)return"expires today";return`${d} days remaining`;}
function escHtml(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
function escAttr(v){return String(v??"").replace(/'/g,"&#039;").replace(/"/g,"&quot;");}
function toDataUrl(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsDataURL(file);});}
function downloadFile(name,content,type){const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(new Blob([content],{type})),download:name});a.click();URL.revokeObjectURL(a.href);}
function parseCsv(text){const rows=[];let row=[],cell="",inQ=false;for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(c==='"'&&inQ&&n==='"'){cell+='"';i++;}else if(c==='"'){inQ=!inQ;}else if(c===","&&!inQ){row.push(cell);cell="";}else if((c==="\n"||c==="\r")&&!inQ){if(c==="\r"&&n==="\n")i++;row.push(cell);rows.push(row);row=[];cell="";}else{cell+=c;}}row.push(cell);rows.push(row);return rows;}
function csvEsc(v){const s=String(v??"");return/[,"\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`  :s;}
function parseDate(v){if(!v||!String(v).trim())return null;const s=String(v).trim();if(/^\d{4}-\d{2}-\d{2}$/.test(s)){const d=new Date(`${s}T00:00:00`);return isNaN(d)?null:s;}const ey=yy=>{const n=parseInt(yy,10);return String(n<=29?2000+n:1900+n);};const nm=s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/,]*(\d{2,4})$/);if(nm){const[,dd,mon,ry]=nm;const yyyy=ry.length===2?ey(ry):ry;const d=new Date(`${dd} ${mon} ${yyyy}`);if(!isNaN(d))return d.toISOString().slice(0,10);}const dmy=s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);if(dmy){const[,dd,mm,ry]=dmy;const yyyy=ry.length===2?ey(ry):ry;const iso=`${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}`;const d=new Date(`${iso}T00:00:00`);if(!isNaN(d))return iso;}const d=new Date(s);if(!isNaN(d))return d.toISOString().slice(0,10);return null;}
function today(){return new Date().toISOString().slice(0,10);}
function showToast(msg){
  // hide progress toast first
  const pt = document.getElementById("progressToast");
  if (pt) pt.classList.remove("visible");
  toast.textContent = msg;
  toast.classList.add("visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("visible"), 4000);
}

function showProgressToast(msg, pct) {
  let pt = document.getElementById("progressToast");
  if (!pt) {
    pt = document.createElement("div");
    pt.id = "progressToast";
    pt.className = "progress-toast";
    pt.innerHTML = `<div class="progress-toast-msg"></div><div class="progress-bar-wrap"><div class="progress-bar-fill"></div></div><div class="progress-toast-pct"></div>`;
    document.body.appendChild(pt);
  }
  pt.querySelector(".progress-toast-msg").textContent  = msg;
  pt.querySelector(".progress-bar-fill").style.width   = `${pct}%`;
  pt.querySelector(".progress-toast-pct").textContent  = `${pct}%`;
  pt.classList.add("visible");
  // hide normal toast while progress is showing
  toast.classList.remove("visible");
}

function hideProgressToast() {
  const pt = document.getElementById("progressToast");
  if (pt) pt.classList.remove("visible");
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// Init ALL possible cert sections at boot so event listeners are always attached.
// applyMarket() will hide/show the right ones after login.
Object.keys(Object.assign({}, MARKET_CONFIG.UAE.certificates, MARKET_CONFIG.Qatar.certificates))
  .forEach(function(t) { try { initSection(t); } catch(e) {} });
render(); // show login screen immediately while we check session

// onAuthStateChange is the single source of truth for auth state.
// It fires on every page load with the restored session (INITIAL_SESSION event),
// on sign-in (SIGNED_IN), and on sign-out (SIGNED_OUT).
sb.auth.onAuthStateChange(async (event, sbSession) => {
  if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
    if (sbSession?.user && sbSession.user.id !== session?.id) {
      // New or restored session -- load data and render
      await onSignIn(sbSession.user);
    }
  } else if (event === "SIGNED_OUT" || event === "USER_DELETED") {
    session = null; isEditor = false; isOps = false;
    state = { employees: [], settings: { ...defaultSettings } };
    render();
  }
});
