// Slack Interactivity endpoint: handles the Submit / "Can't, needs HR" buttons in the manager DMs.
// Slack app > Interactivity & Shortcuts > Request URL: https://calo-compliance-portal.vercel.app/api/slack-interact
const crypto = require("crypto");
const { db, postToThread, closeDms, fmt, fmtDay, CERT_LABELS } = require("./_lib");

async function readRaw(req) {
  if (req.rawBody) return req.rawBody.toString("utf8");
  const chunks = []; for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}
function verified(req, raw) {
  const ts = req.headers["x-slack-request-timestamp"], sig = req.headers["x-slack-signature"] || "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const mine = "v0=" + crypto.createHmac("sha256", process.env.SLACK_SIGNING_SECRET || "").update(`v0:${ts}:${raw}`).digest("hex");
  return sig.length === mine.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mine));
}
const reply = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const done = text => ({ replace_original: true, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });

module.exports = async (req, res) => {
  const raw = await readRaw(req);
  if (!verified(req, raw)) return res.status(401).send("Invalid signature");
  const p = JSON.parse(new URLSearchParams(raw).get("payload") || "{}");
  const action = p.type === "block_actions" && p.actions && p.actions[0];
  if (!action || action.action_id === "book_date") return res.status(200).end(); // picking from the list needs no reply

  try {
    const [r] = await db(`schedule_requests?id=eq.${encodeURIComponent(action.value)}&select=id,status,market,expiry_date,certificate_id,certificates(type,employees(name,employee_id,department))`);
    if (!r) { await reply(p.response_url, done("This request no longer exists.")); return res.status(200).end(); }
    const e = r.certificates?.employees || {}; const type = r.certificates?.type || "";
    const label = CERT_LABELS[type] || type.toUpperCase();
    if (r.status !== "sent") { await reply(p.response_url, done(`Already handled (${r.status}): *${e.name}* · ${label}.`)); return res.status(200).end(); }
    const nowIso = new Date().toISOString();
    const sameCycle = `schedule_requests?certificate_id=eq.${r.certificate_id}&expiry_date=eq.${r.expiry_date}&status=eq.sent`;

    if (action.action_id === "book_submit") {
      const date = p.state?.values?.book?.book_date?.selected_option?.value;
      if (!date) {
        await reply(p.response_url, { response_type: "ephemeral", replace_original: false, text: "Pick a date from the list first, then tap Submit." });
        return res.status(200).end();
      }
      // Claim it first so two managers pressing Submit at once can't both book
      const claimed = await db(sameCycle, { method: "PATCH", prefer: "return=representation",
        body: { status: "booked", booked_date: date, responded_by: p.user?.id, responded_at: nowIso } });
      if (!claimed.length) { await reply(p.response_url, done(`Already handled by someone else: *${e.name}* · ${label}.`)); return res.status(200).end(); }
      await db(`certificates?id=eq.${r.certificate_id}`, { method: "PATCH", body: {
        scheduled_date: date, schedule_note: `Booked via Slack by ${p.user?.name || p.user?.username || p.user?.id}`, updated_at: nowIso } });
      await postToThread(r.market, `✅ *Please book:* *${e.name}* (${e.employee_id}, ${e.department}) · ${label} · *${fmtDay(date)} ${date.slice(0, 4)}* · expires ${fmt(r.expiry_date)} · picked by <@${p.user?.id}>`);
      await reply(p.response_url, done(`✅ *Booked:* *${e.name}* · ${label} on *${fmtDay(date)}*.\nHR has it, and the portal now shows Scheduled.`));
      await closeDms(claimed.map(x => x.dm_messages), p.message?.ts, `✅ Booked by <@${p.user?.id}>: *${e.name}* · ${label} on *${fmtDay(date)}*. Nothing to do.`);
    } else if (action.action_id === "book_decline") {
      const claimed = await db(sameCycle, { method: "PATCH", prefer: "return=representation",
        body: { status: "declined", responded_by: p.user?.id, responded_at: nowIso } });
      if (!claimed.length) { await reply(p.response_url, done(`Already handled by someone else: *${e.name}* · ${label}.`)); return res.status(200).end(); }
      await postToThread(r.market, `❗ *Needs HR:* *${e.name}* (${e.employee_id}, ${e.department}) · ${label} · expires ${fmt(r.expiry_date)} · <@${p.user?.id}> can't schedule this one.`);
      await reply(p.response_url, done(`Sent to HR: *${e.name}* · ${label}. They'll take it from here.`));
      await closeDms(claimed.map(x => x.dm_messages), p.message?.ts, `Sent to HR by <@${p.user?.id}>: *${e.name}* · ${label}. Nothing to do.`);
    }
  } catch (err) {
    await reply(p.response_url, { response_type: "ephemeral", replace_original: false, text: `Something went wrong, HR has not been notified: ${err.message}` }).catch(() => {});
  }
  return res.status(200).end();
};
