// Shared helpers for the Slack scheduling bot. Files starting with "_" are not exposed as routes by Vercel.
const SUPABASE_URL = "https://iflquskysqchhbywvmow.supabase.co";
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const CERT_LABELS = {
  bfs: "BFS (Basic Food Safety)", ohc: "OHC (Occupational Health Card)", fsc: "Fire Safety Certificate", fac: "First Aid Certificate", pic: "PIC (Person In Charge)",
  fh: "Food Handler Certificate", fa: "First Aid Certificate", fs: "Fire Safety Certificate",
};

// All dates are worked out in Gulf time so "today" matches the team's day
const today = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const fmt = iso => { if (!iso) return "--"; const d = new Date(iso + "T00:00:00Z"); return `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const fmtDay = iso => { const d = new Date(iso + "T00:00:00Z"); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };

async function db(path, { method = "GET", body, prefer } = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`db ${method} ${path.split("?")[0]}: ${r.status} ${await r.text()}`);
  if (method === "GET" || (prefer || "").includes("return=representation")) return r.json();
  return null;
}

async function slack(method, body) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`slack ${method}: ${j.error}`);
  return j;
}

// HR log: one thread per market per month, created on first use
async function monthThread(market) {
  const month = today().slice(0, 7);
  const found = await db(`slack_threads?market=eq.${encodeURIComponent(market)}&month=eq.${month}&select=channel,ts`);
  if (found[0]) return found[0];
  const channel = process.env.SLACK_HR_CHANNEL_ID || process.env.SLACK_CHANNEL_ID;
  const label = `${MON[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
  const j = await slack("chat.postMessage", {
    channel,
    text: `🗓️ ${market} renewal bookings · ${label}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `🗓️ *${market} renewal bookings · ${label}*\nEvery booking and escalation for this month lands in this thread.` } }],
  });
  await db("slack_threads", { method: "POST", body: { market, month, channel: j.channel, ts: j.ts } });
  return { channel: j.channel, ts: j.ts };
}
// Tag whoever owns this certificate type (hr_contacts.cert_types; empty = every type)
async function hrMentions(market, certType) {
  try {
    const rows = await db(`hr_contacts?market=eq.${encodeURIComponent(market)}&select=slack_user_id,cert_types`);
    const ids = rows
      .filter(r => !r.cert_types || !r.cert_types.length || (certType && r.cert_types.includes(certType)))
      .map(r => r.slack_user_id);
    return [...new Set(ids)].map(id => `<@${id}>`).join(" ");
  } catch (e) { return ""; } // table missing or empty: post without tags
}
async function postToThread(market, text, certType) {
  const t = await monthThread(market);
  const tags = await hrMentions(market, certType);
  await slack("chat.postMessage", { channel: t.channel, thread_ts: t.ts, text: tags ? `${tags} ${text}` : text });
}

// Replace the buttons in every DM for this request (except the one the clicker already sees updated)
async function closeDms(dmLists, skipTs, text) {
  const all = [].concat(...[].concat(dmLists || []).map(x => Array.isArray(x) ? x : [x])).filter(Boolean);
  for (const m of all) {
    if (!m || !m.channel || !m.ts || m.ts === skipTs) continue;
    try { await slack("chat.update", { channel: m.channel, ts: m.ts, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }); }
    catch (e) { /* message may be deleted; not worth failing the booking */ }
  }
}

// Department managers by tier: { 1: [slack ids], 2: [slack ids] }
// department "*" = gets every request (all departments); "*ohc-new" = only new joiner OHC requests
async function managersFor(market, department, isNew) {
  const rows = await db(`dept_managers?market=eq.${encodeURIComponent(market)}&select=department,slack_user_id,tier`);
  const t = { 1: [], 2: [] };
  const want = (department || "").trim().toLowerCase();
  for (const r of rows) {
    const d = (r.department || "").trim().toLowerCase();
    if (d !== want && d !== "*" && !(isNew && d === "*ohc-new")) continue;
    const list = t[r.tier === 2 ? 2 : 1];
    if (!list.includes(r.slack_user_id)) list.push(r.slack_user_id);
  }
  return t;
}
async function dmUsers(users, text, blocks) {
  const dms = [], errors = [];
  for (const user of users) {
    try { const m = await slack("chat.postMessage", { channel: user, text, blocks }); dms.push({ user, channel: m.channel, ts: m.ts }); }
    catch (e) { errors.push({ user, error: e.message, at: new Date().toISOString() }); }
  }
  return { dms, errors };
}

// New joiner OHC: Emirates ID confirmed, supervisors pick an appointment date in the next 14 days
function newOhcBlocks({ id, emp, handover, now }) {
  const options = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(now, i + 1);
    return { text: { type: "plain_text", text: fmtDay(d) }, value: d };
  });
  const lead = handover ? "⏰ *Passed to you* · no reply from the first managers in 48 hours\n" : "";
  return [
    { type: "section", text: { type: "mrkdwn", text:
      `${lead}🆕 *New joiner needs an OHC* · Emirates ID received\n*${emp.name}* (${emp.employee_id}, ${emp.department})\nPick a date in the next two weeks for the OHC appointment. HR will prepare the application form.` } },
    { type: "actions", block_id: "book", elements: [
      { type: "static_select", action_id: "book_date", placeholder: { type: "plain_text", text: "Choose a date" }, options },
      { type: "button", action_id: "book_submit", style: "primary", text: { type: "plain_text", text: "Submit" }, value: id },
      { type: "button", action_id: "book_decline", text: { type: "plain_text", text: "Can't, needs HR" }, value: id },
    ] },
    { type: "context", elements: [{ type: "mrkdwn", text: "Calo Compliance Portal · your pick marks the OHC as Scheduled in the portal" }] },
  ];
}

// Start the new-joiner OHC request (once per OHC record). Returns a short status string.
async function startNewOhcRequest({ market, emp, certId }) {
  const existing = await db(`schedule_requests?certificate_id=eq.${certId}&stage=eq.new&select=id`);
  if (existing.length) return "already requested";
  const tiers = await managersFor(market, emp.department, true);
  const first = tiers[1].length ? tiers[1] : tiers[2];
  const level = tiers[1].length ? 1 : 2;
  if (!first.length) {
    await db("schedule_requests", { method: "POST", body: { certificate_id: certId, market, stage: "new", expiry_date: null, status: "escalated", note: "no manager mapped" } });
    await postToThread(market, `⚠️ *No manager set for ${emp.department}*. New joiner needs an OHC, please book directly: *${emp.name}* (${emp.employee_id})`, "ohc");
    return "no manager set, sent to HR";
  }
  const [row] = await db("schedule_requests", { method: "POST", prefer: "return=representation",
    body: { certificate_id: certId, market, stage: "new", expiry_date: null, status: "sent", level } });
  const blocks = newOhcBlocks({ id: row.id, emp, handover: false, now: today() });
  const { dms, errors } = await dmUsers(first, `New joiner needs an OHC: ${emp.name} (${emp.employee_id})`, blocks);
  await db(`schedule_requests?id=eq.${row.id}`, { method: "PATCH", body: { dm_messages: dms, dm_failed: errors, slack_channel: dms[0] && dms[0].channel, slack_ts: dms[0] && dms[0].ts } });
  if (!dms.length) throw new Error("no manager could be messaged: " + errors.map(e => `${e.user}: ${e.error}`).join("; "));
  return `sent to ${dms.length} manager${dms.length === 1 ? "" : "s"}`;
}

module.exports = { managersFor, dmUsers, newOhcBlocks, startNewOhcRequest, db, slack, postToThread, closeDms, today, addDays, daysBetween, fmt, fmtDay, CERT_LABELS };
