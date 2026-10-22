// Shared helpers for the Slack scheduling bot. Files starting with "_" are not exposed as routes by Vercel.
const SUPABASE_URL = "https://iflquskysqchhbywvmow.supabase.co";
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const CERT_LABELS = {
  bfs: "BFS (Basic Food Safety)", ohc: "OHC (Occupational Health Card)", fsc: "Fire Safety Certificate", fac: "First Aid Certificate",
  fh: "Food Handler Certificate", fa: "First Aid Certificate", fs: "Fire Safety Certificate",
};

// All dates are worked out in Gulf time so "today" matches the team's day
const today = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const fmt = iso => { const d = new Date(iso + "T00:00:00Z"); return `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
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
// Every thread reply is a job for HR, so tag the HR people listed in hr_contacts for that market
async function hrMentions(market) {
  try {
    const rows = await db(`hr_contacts?market=eq.${encodeURIComponent(market)}&select=slack_user_id`);
    return rows.map(r => `<@${r.slack_user_id}>`).join(" ");
  } catch (e) { return ""; } // table missing or empty: post without tags
}
async function postToThread(market, text) {
  const t = await monthThread(market);
  const tags = await hrMentions(market);
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

module.exports = { db, slack, postToThread, closeDms, today, addDays, daysBetween, fmt, fmtDay, CERT_LABELS };
