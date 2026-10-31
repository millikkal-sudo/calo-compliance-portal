// Daily at 09:00 Gulf time (Vercel cron).
// Chain per cert, starting 14 days before expiry when no renewal is booked:
//   tier 1 managers (two people) get a DM  -> 48h, no answer ->
//   tier 2 manager (backup) gets a DM      -> 48h, no answer ->
//   HR gets it in the monthly thread.
// Everyone who has the DM can still answer until someone does; first answer wins.
// Test in a browser: /api/schedule-requests?key=CRON_SECRET&dry=1  -> lists what would happen, sends nothing
const { db, slack, postToThread, closeDms, newOhcBlocks, startNewOhcRequest, today, addDays, daysBetween, fmt, fmtDay, CERT_LABELS } = require("./_lib");
const WAIT_MS = 46 * 3600e3; // "48 hours" measured between two 9am runs, with slack for timing drift

function requestBlocks({ id, emp, type, expiry, days, handover, now }) {
  const options = [1, 2, 3, 4, 5, 6, 7].map(i => {
    const d = addDays(now, i);
    return { text: { type: "plain_text", text: fmtDay(d) + (d > expiry ? "  (after expiry)" : "") }, value: d };
  });
  const when = days < 0 ? `*expired ${Math.abs(days)} day${days === -1 ? "" : "s"} ago*` : days === 0 ? "expires *today*" : `expires *${fmt(expiry)}* (in ${days} day${days === 1 ? "" : "s"})`;
  const lead = handover ? "⏰ *Passed to you* · no reply from the first managers in 48 hours\n" : "";
  return [
    { type: "section", text: { type: "mrkdwn", text:
      `${lead}*${emp.name}* (${emp.employee_id}, ${emp.department})\n${CERT_LABELS[type] || type.toUpperCase()} ${when}.\nPick a renewal date and HR will book it.` } },
    { type: "actions", block_id: "book", elements: [
      { type: "static_select", action_id: "book_date", placeholder: { type: "plain_text", text: "Choose a date" }, options },
      { type: "button", action_id: "book_submit", style: "primary", text: { type: "plain_text", text: "Submit" }, value: id },
      { type: "button", action_id: "book_decline", text: { type: "plain_text", text: "Can't, needs HR" }, value: id },
    ] },
    { type: "context", elements: [{ type: "mrkdwn", text: "Calo Compliance Portal · your pick marks it Scheduled in the portal" }] },
  ];
}

async function dmAll(users, text, blocks, who, out) {
  const dms = [];
  for (const user of users) {
    try { const m = await slack("chat.postMessage", { channel: user, text, blocks }); dms.push({ user, channel: m.channel, ts: m.ts }); }
    catch (e) { out.errors.push(`${who} -> ${user}: ${e.message}`); }
  }
  return dms;
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url, "http://x");
  if (!secret || (req.headers.authorization !== `Bearer ${secret}` && url.searchParams.get("key") !== secret)) return res.status(401).send("Unauthorized");
  const dry = url.searchParams.get("dry") === "1";
  const now = today();
  const out = { date: now, firstAsk: [], newJoinerOhc: [], passedToBackup: [], toHR: [], alreadyBookedInPortal: [], noManager: [], errors: [] };

  try {
    const managers = await db("dept_managers?select=market,department,slack_user_id,tier");
    for (const market of ["UAE", "Qatar"]) {
      const tiers = new Map(); // department -> { 1: [ids], 2: [ids] }
      for (const m of managers.filter(x => x.market === market)) {
        const k = m.department.trim().toLowerCase();
        const t = tiers.get(k) || { 1: [], 2: [] };
        t[m.tier === 2 ? 2 : 1].push(m.slack_user_id); tiers.set(k, t);
      }
      if (!tiers.size) continue; // market not switched on yet
      const tierOf = dept => tiers.get((dept || "").trim().toLowerCase()) || { 1: [], 2: [] };

      // ── 1. Move along open requests that waited 48h ───────────────────────────
      const cutoff = new Date(Date.now() - WAIT_MS).toISOString();
      const open = await db(`schedule_requests?select=id,level,stage,expiry_date,dm_messages,certificate_id,certificates(type,issue_date,scheduled_date,employees(name,employee_id,department))&market=eq.${market}&status=eq.sent&level_at=lt.${cutoff}`);
      for (const r of open) {
        const c = r.certificates || {}; const e = c.employees || {}; const label = CERT_LABELS[c.type] || (c.type || "").toUpperCase();
        const isNew = r.stage === "new";
        const who = isNew ? `${e.name} · new joiner OHC` : `${e.name} · ${(c.type || "").toUpperCase()} · expires ${fmt(r.expiry_date)}`;
        try {
          if (isNew && c.issue_date) { // OHC card already entered in the portal
            if (dry) { out.alreadyBookedInPortal.push(who); continue; }
            await db(`schedule_requests?id=eq.${r.id}`, { method: "PATCH", body: { status: "booked", note: "OHC recorded in portal", responded_at: new Date().toISOString() } });
            await closeDms(r.dm_messages, null, `OHC already recorded for *${e.name}*. Nothing to do.`);
            out.alreadyBookedInPortal.push(who); continue;
          }
          if (c.scheduled_date) { // HR booked it straight in the portal meanwhile
            if (dry) { out.alreadyBookedInPortal.push(who); continue; }
            await db(`schedule_requests?id=eq.${r.id}`, { method: "PATCH", body: { status: "booked", booked_date: c.scheduled_date, note: "booked in portal", responded_at: new Date().toISOString() } });
            await closeDms(r.dm_messages, null, `Already booked in the portal: *${e.name}* · ${label} on ${fmt(c.scheduled_date)}. Nothing to do.`);
            out.alreadyBookedInPortal.push(who); continue;
          }
          const backup = tierOf(e.department)[2];
          if (r.level === 1 && backup.length) {
            if (dry) { out.passedToBackup.push(`${who} -> ${backup.length} backup`); continue; }
            const blocks = isNew
              ? newOhcBlocks({ id: r.id, emp: e, handover: true, now })
              : requestBlocks({ id: r.id, emp: e, type: c.type, expiry: r.expiry_date, days: daysBetween(now, r.expiry_date), handover: true, now });
            const dms = await dmAll(backup, isNew ? `New joiner needs an OHC (passed to you): ${e.name}` : `Renewal date needed (passed to you): ${e.name} · ${(c.type || "").toUpperCase()}`, blocks, who, out);
            if (dms.length) {
              await db(`schedule_requests?id=eq.${r.id}`, { method: "PATCH", body: { level: 2, level_at: new Date().toISOString(), dm_messages: [...(r.dm_messages || []), ...dms] } });
              out.passedToBackup.push(who); continue;
            }
          }
          if (dry) { out.toHR.push(who); continue; }
          await postToThread(market, isNew
            ? `⏰ *No reply from managers in time:* new joiner *${e.name}* (${e.employee_id}, ${e.department}) needs an OHC appointment. Please arrange directly.`
            : `⏰ *No reply from managers in time:* *${e.name}* (${e.employee_id}, ${e.department}) · ${label} · expires ${fmt(r.expiry_date)}. Please book directly.`, c.type);
          await db(`schedule_requests?id=eq.${r.id}`, { method: "PATCH", body: { status: "escalated", responded_at: new Date().toISOString() } });
          await closeDms(r.dm_messages, null, `No reply in time, so HR now has this one: *${e.name}* · ${label}.`);
          out.toHR.push(who);
        } catch (err) { out.errors.push(`${who}: ${err.message}`); }
      }

      // ── 2. Start the chain for certs that just entered the 14-day window ──────
      const emps = await db(`employees?select=id,name,employee_id,department&market=eq.${market}&limit=10000`);
      const empById = new Map(emps.map(e => [e.id, e]));
      const certs = await db(`certificates?select=id,employee_id,type,expiry_date&market=eq.${market}&scheduled_date=is.null&expiry_date=gte.${now}&expiry_date=lte.${addDays(now, 14)}&limit=10000`);
      const existing = certs.length
        ? await db(`schedule_requests?select=certificate_id,expiry_date&certificate_id=in.(${certs.map(c => c.id).join(",")})`)
        : [];
      for (const c of certs) {
        if (existing.some(r => r.certificate_id === c.id && r.expiry_date === c.expiry_date)) continue; // chain already running or finished
        const emp = empById.get(c.employee_id); if (!emp) continue;
        const who = `${emp.name} · ${c.type.toUpperCase()} · expires ${fmt(c.expiry_date)}`;
        const t = tierOf(emp.department);
        const first = t[1].length ? t[1] : t[2];
        const level = t[1].length ? 1 : 2;
        if (dry) { (first.length ? out.firstAsk : out.noManager).push(`${who} -> ${first.length ? first.length + " manager(s)" : emp.department}`); continue; }
        try {
          if (!first.length) {
            await db("schedule_requests", { method: "POST", body: { certificate_id: c.id, market, stage: "14", expiry_date: c.expiry_date, status: "escalated", note: "no manager mapped" } });
            await postToThread(market, `⚠️ *No manager set for ${emp.department}*, please book directly: *${emp.name}* (${emp.employee_id}) · ${CERT_LABELS[c.type] || c.type} · expires ${fmt(c.expiry_date)}`, c.type);
            out.noManager.push(who); continue;
          }
          const [row] = await db("schedule_requests", { method: "POST", prefer: "return=representation",
            body: { certificate_id: c.id, market, stage: "14", expiry_date: c.expiry_date, status: "sent", level } });
          const blocks = requestBlocks({ id: row.id, emp, type: c.type, expiry: c.expiry_date, days: daysBetween(now, c.expiry_date), handover: false, now });
          const dms = await dmAll(first, `Renewal date needed: ${emp.name} · ${c.type.toUpperCase()} expires ${fmt(c.expiry_date)}`, blocks, who, out);
          if (!dms.length) throw new Error("no manager could be messaged");
          await db(`schedule_requests?id=eq.${row.id}`, { method: "PATCH", body: { dm_messages: dms, slack_channel: dms[0].channel, slack_ts: dms[0].ts } });
          out.firstAsk.push(who);
        } catch (e) { out.errors.push(`${who}: ${e.message}`); }
      }

      // ── 3. Safety net: Emirates ID confirmed in the last 7 days but no OHC request went out ──
      if (market === "UAE") {
        try {
          const since = new Date(Date.now() - 7 * 864e5).toISOString();
          const joiners = await db(`employees?select=id,name,employee_id,department,eid_confirmed_by&market=eq.${market}&eid_confirmed=eq.true&eid_confirmed_at=gte.${since}`);
          const manual = joiners.filter(j => !String(j.eid_confirmed_by || "").startsWith("auto"));
          if (manual.length) {
            const ohc = await db(`certificates?select=id,employee_id,issue_date&type=eq.ohc&employee_id=in.(${manual.map(j => j.id).join(",")})`);
            const asked = ohc.length ? await db(`schedule_requests?select=certificate_id&stage=eq.new&certificate_id=in.(${ohc.map(c => c.id).join(",")})`) : [];
            for (const c of ohc) {
              if (c.issue_date || asked.some(a => a.certificate_id === c.id)) continue;
              const j = manual.find(x => x.id === c.employee_id);
              if (dry) { out.newJoinerOhc.push(`${j.name} (retry)`); continue; }
              try { out.newJoinerOhc.push(`${j.name}: ${await startNewOhcRequest({ market, emp: j, certId: c.id })}`); }
              catch (err) { out.errors.push(`${j.name} new OHC: ${err.message}`); }
            }
          }
        } catch (err) { out.errors.push(`new joiner check: ${err.message}`); }
      }
    }
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err), ...out });
  }
};
module.exports.requestBlocks = requestBlocks;
