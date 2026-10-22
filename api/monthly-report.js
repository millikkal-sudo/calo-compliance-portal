// Monthly one-page compliance PDF -> private Slack channel (one file per market).
// Runs on Vercel Cron (see vercel.json). Vercel sends "Authorization: Bearer <CRON_SECRET>".
// Env vars (Vercel > Project > Settings > Environment Variables):
//   SUPABASE_SERVICE_ROLE_KEY  Supabase > Project Settings > API > service_role (server only, never in app.js)
//   SLACK_BOT_TOKEN            xoxb-... from your Slack app (scope: files:write)
//   SLACK_CHANNEL_ID           private channel ID (C0...); invite the bot to it
//   CRON_SECRET                any long random string
// Optional: SLACK_CHANNEL_ID_UAE / SLACK_CHANNEL_ID_QATAR to split markets into different channels.
// Manual test in a browser:
//   /api/monthly-report?key=CRON_SECRET&dry=1&market=UAE   -> shows the PDF, posts nothing
//   /api/monthly-report?key=CRON_SECRET                    -> posts now
const { jsPDF } = require("jspdf");
const autoTable = require("jspdf-autotable").default;

const SUPABASE_URL = "https://iflquskysqchhbywvmow.supabase.co";
const MARKETS = {
  UAE:   { label: "UAE Kitchen",   certs: { bfs: "BFS", ohc: "OHC", fsc: "FSC", fac: "FAC" }, groups: [["bfs","ohc"],["fsc"],["fac"]] },
  Qatar: { label: "Qatar Kitchen", certs: { fh: "FH", fa: "FA", fs: "FS" },                   groups: [["fh"],["fa"],["fs"]] },
};
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmt = v => { if (!v) return "--"; const d = new Date(v + "T00:00:00Z"); return `${String(d.getUTCDate()).padStart(2,"0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const todayISO = () => new Date().toISOString().slice(0,10);
const daysUntil = v => Math.round((new Date(v + "T00:00:00Z") - new Date(todayISO() + "T00:00:00Z")) / 86400000);
const rawStatus = exp => { if (!exp) return "Missing"; const d = daysUntil(exp); return d < 0 ? "Expired" : d <= 30 ? "Expiring in 30 Days" : d <= 90 ? "Expiring in 90 Days" : "Valid"; };

async function fetchAll(table, cols, market) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const out = []; const page = 1000;
  for (let from = 0; ; from += page) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${cols}&market=eq.${encodeURIComponent(market)}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + page - 1}` } });
    if (!r.ok) throw new Error(`${table}: ${r.status} ${await r.text()}`);
    const rows = await r.json(); out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

// Same rules as the portal: an employee appears in a cert if they have any row in that cert's group
function summarise(market, emps, certs) {
  const cfg = MARKETS[market];
  const byEmp = new Map();
  for (const c of certs) { if (!byEmp.has(c.employee_id)) byEmp.set(c.employee_id, {}); byEmp.get(c.employee_id)[c.type] = c; }
  const sums = [];
  for (const e of emps) {
    const mine = byEmp.get(e.id) || {};
    for (const type of Object.keys(cfg.certs)) {
      const group = cfg.groups.find(g => g.includes(type)) || [type];
      if (!group.some(t => mine[t])) continue;
      const c = mine[type] || {};
      const raw = rawStatus(c.expiry_date);
      const scheduled = Boolean(c.scheduled_date) && raw !== "Valid";
      sums.push({ emp: e, type, label: cfg.certs[type], raw, status: scheduled ? "Scheduled" : raw,
                  expiry: c.expiry_date, scheduledDate: c.scheduled_date, days: c.expiry_date ? daysUntil(c.expiry_date) : Infinity });
    }
  }
  return sums;
}

function buildPdf(market, emps, sums) {
  const cfg = MARKETS[market];
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight(), margin = 40; let y = 50;

  doc.setFont("helvetica","bold"); doc.setFontSize(20); doc.setTextColor(17,24,39); doc.text("CALO", margin, y);
  doc.setFontSize(11); doc.setFont("helvetica","normal"); doc.setTextColor(107,114,128); doc.text(`${cfg.label} Compliance Portal`, margin, y+16);
  doc.setFontSize(14); doc.setFont("helvetica","bold"); doc.setTextColor(17,24,39); doc.text(`Staff Certificate Compliance Report -- ${market}`, margin, y+40);
  doc.setFontSize(9); doc.setFont("helvetica","normal"); doc.setTextColor(107,114,128); doc.text(`Generated: ${fmt(todayISO())}`, margin, y+56); y += 80;

  const count = (t, st) => sums.filter(s => s.type === t && s.status === st).length;
  const scheduled = sums.filter(s => s.status === "Scheduled");
  const unhandled = sums.filter(s => ["Expired","Expiring in 30 Days","Expiring in 90 Days","Missing"].includes(s.raw) && !s.scheduledDate);
  const actionNeeded = sums.filter(s => s.raw === "Expired" || s.raw === "Expiring in 30 Days").length;

  doc.setFontSize(11); doc.setFont("helvetica","bold"); doc.setTextColor(17,24,39); doc.text("EXECUTIVE SUMMARY", margin, y); y += 14;
  const tiles = [
    { label: "TOTAL EMPLOYEES", value: emps.length },
    ...Object.entries(cfg.certs).flatMap(([t, L]) => [
      { label: `${L} VALID`, value: count(t,"Valid") },
      { label: `${L} EXPIRING 30D`, value: count(t,"Expiring in 30 Days") },
      { label: `${L} EXPIRED`, value: count(t,"Expired") },
    ]),
    { label: "ACTION NEEDED", value: actionNeeded, tone: "bad" },
    { label: "SCHEDULED RENEWALS", value: scheduled.length, tone: "good" },
    { label: "UNHANDLED", value: unhandled.length, tone: "bad" },
  ];
  const tc = 5, gap = 8, tH = 52, tW = (pageW - margin*2 - gap*(tc-1)) / tc;
  tiles.forEach((t, i) => {
    const x = margin + (i % tc) * (tW + gap), ty = y + Math.floor(i / tc) * (tH + gap);
    doc.setDrawColor(226,230,236);
    t.tone === "bad" ? doc.setFillColor(254,226,226) : t.tone === "good" ? doc.setFillColor(220,252,231) : doc.setFillColor(248,250,252);
    doc.roundedRect(x, ty, tW, tH, 4, 4, "FD");
    const rgb = t.tone === "bad" ? [185,28,28] : t.tone === "good" ? [21,128,61] : [107,114,128];
    doc.setFontSize(6.5); doc.setFont("helvetica","bold"); doc.setTextColor(...rgb); doc.text(t.label, x+8, ty+16, { maxWidth: tW-16 });
    doc.setFontSize(18); doc.setTextColor(...(t.tone ? rgb : [17,24,39])); doc.text(String(t.value), x+8, ty+38);
  });
  y += Math.ceil(tiles.length / tc) * (tH + gap) + 18;

  const ROW_H = 18, HEAD_H = 20, FOOT = 60;
  if (unhandled.length) {
    doc.setFontSize(11); doc.setFont("helvetica","bold"); doc.setTextColor(185,28,28);
    doc.text(`Needs Immediate Action (${unhandled.length})`, margin, y);
    const room = Math.max(0, Math.floor((pageH - FOOT - (y + 8) - HEAD_H - 16) / ROW_H));
    const sorted = unhandled.sort((a, b) => a.days - b.days), shown = sorted.slice(0, room);
    autoTable(doc, {
      startY: y + 8, margin: { left: margin, right: margin, bottom: FOOT },
      head: [["Name","ID","Department","Certificate","Status","Expiry Date","Days"]],
      body: shown.map(s => [s.emp.name, s.emp.employee_id, s.emp.department, s.label, s.raw, fmt(s.expiry),
        isFinite(s.days) ? (s.days < 0 ? `${Math.abs(s.days)}d overdue` : `${s.days}d left`) : "--"]),
      styles: { fontSize: 8, cellPadding: 5, overflow: "ellipsize" },
      headStyles: { fillColor: [185,28,28], textColor: 255, fontStyle: "bold" },
      columnStyles: { 4: { textColor: [185,28,28], fontStyle: "bold" }, 6: { textColor: [185,28,28] } },
      theme: "grid",
    });
    y = doc.lastAutoTable.finalY + 14;
    if (sorted.length > shown.length) {
      doc.setFontSize(9); doc.setFont("helvetica","normal"); doc.setTextColor(107,114,128);
      doc.text(`+ ${sorted.length - shown.length} more in the portal.`, margin, y);
    }
  } else {
    doc.setFontSize(11); doc.setFont("helvetica","bold"); doc.setTextColor(21,128,61);
    doc.text("All clear. Nothing expired or due in the next 30 days.", margin, y);
  }
  while (doc.internal.getNumberOfPages() > 1) doc.deletePage(doc.internal.getNumberOfPages());
  doc.setPage(1); doc.setFontSize(8); doc.setTextColor(156,163,175);
  doc.text(`${cfg.label} Compliance Portal · Confidential`, pageW/2, pageH-20, { align: "center" });
  return { buffer: Buffer.from(doc.output("arraybuffer")), actionNeeded, unhandled: unhandled.length, scheduled: scheduled.length };
}

async function slack(method, body, isForm) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
               "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" },
    body: isForm ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}`);
  return j;
}

async function uploadToSlack(channel, filename, buffer, comment) {
  const { upload_url, file_id } = await slack("files.getUploadURLExternal", { filename, length: String(buffer.length) }, true);
  const up = await fetch(upload_url, { method: "POST", body: buffer });
  if (!up.ok) throw new Error(`upload: ${up.status}`);
  await slack("files.completeUploadExternal", { files: [{ id: file_id, title: filename }], channel_id: channel, initial_comment: comment });
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url, "http://x");
  const ok = secret && (req.headers.authorization === `Bearer ${secret}` || url.searchParams.get("key") === secret);
  if (!ok) return res.status(401).send("Unauthorized");

  const dry = url.searchParams.get("dry") === "1";
  const only = url.searchParams.get("market");
  const month = (() => { const n = new Date(); return `${MON[n.getUTCMonth()]} ${n.getUTCFullYear()}`; })();
  const results = {};
  try {
    for (const market of Object.keys(MARKETS)) {
      if (only && only !== market) continue;
      const [emps, certs] = await Promise.all([
        fetchAll("employees", "id,name,employee_id,department", market),
        fetchAll("certificates", "employee_id,type,expiry_date,scheduled_date", market),
      ]);
      if (!emps.length) { results[market] = "skipped: no employees"; continue; }
      const pdf = buildPdf(market, emps, summarise(market, emps, certs));
      const filename = `${market.toLowerCase()}-compliance-${todayISO()}.pdf`;
      if (dry) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
        return res.status(200).send(pdf.buffer);
      }
      const channel = process.env[`SLACK_CHANNEL_ID_${market.toUpperCase()}`] || process.env.SLACK_CHANNEL_ID;
      const comment = `*${MARKETS[market].label} compliance · ${month}*\n${pdf.actionNeeded} need action now · ${pdf.unhandled} not booked yet · ${pdf.scheduled} already booked`;
      await uploadToSlack(channel, filename, pdf.buffer, comment);
      results[market] = "sent";
    }
    res.status(200).json(results);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err), results });
  }
};
