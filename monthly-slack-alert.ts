// Monthly compliance alert -> Slack, one message per market.
// Triggered by pg_cron on the 1st of each month. Reads with the service role (bypasses RLS).
// Secrets (set in Supabase > Edge Functions > Secrets):
//   CRON_SECRET          random string, must match the x-cron-secret header sent by the cron job
//   SLACK_WEBHOOK_UAE    incoming webhook for the UAE channel
//   SLACK_WEBHOOK_QATAR  incoming webhook for the Qatar channel
//   SLACK_WEBHOOK_URL    optional fallback used for any market without its own webhook
// Query params: ?dry=1 returns the Slack payloads without posting. ?market=UAE limits to one market.
import { createClient } from "jsr:@supabase/supabase-js@2";

const PORTAL_URL = "https://calo-compliance-portal.vercel.app";

const MARKETS: Record<string, { label: string; certs: Record<string, string> }> = {
  UAE:   { label: "UAE Kitchen",   certs: { bfs: "BFS", ohc: "OHC", fsc: "FSC", fac: "FAC" } },
  Qatar: { label: "Qatar Kitchen", certs: { fh: "Food Handler", fa: "First Aid", fs: "Fire Safety" } },
};

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmt = (d: string) => { const x = new Date(d + "T00:00:00Z"); return `${String(x.getUTCDate()).padStart(2,"0")} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`; };
const daysUntil = (d: string) => {
  const now = new Date(); const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((new Date(d + "T00:00:00Z").getTime() - t) / 86400000);
};

type Emp  = { id: string; name: string; employee_id: string; department: string; market: string };
type Cert = { employee_id: string; type: string; expiry_date: string | null; scheduled_date: string | null; market: string };

async function fetchAll<T>(sb: ReturnType<typeof createClient>, table: string, cols: string): Promise<T[]> {
  const out: T[] = []; const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (!data || data.length < page) break;
  }
  return out;
}

// Slack section text is capped at 3000 chars, so split long lists into several blocks
function listBlocks(title: string, lines: string[]) {
  const blocks: unknown[] = [];
  let chunk = `*${title}*\n`;
  for (const line of lines) {
    if ((chunk + line + "\n").length > 2800) { blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } }); chunk = ""; }
    chunk += line + "\n";
  }
  if (chunk.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
  return blocks;
}

function buildMessage(market: string, emps: Emp[], certs: Cert[], reminderDays: number) {
  const cfg = MARKETS[market];
  const empById = new Map(emps.map(e => [e.id, e]));
  const month = (() => { const n = new Date(); return `${MON[n.getUTCMonth()]} ${n.getUTCFullYear()}`; })();

  const counts = { expired: 0, due: 0, soon: 0, missing: 0, valid: 0 };
  const needsBooking: { days: number; line: string }[] = [];
  const booked: { days: number; line: string }[] = [];

  for (const c of certs) {
    const label = cfg.certs[c.type]; const e = empById.get(c.employee_id);
    if (!label || !e) continue;
    if (!c.expiry_date) { counts.missing++; continue; }
    const d = daysUntil(c.expiry_date);
    if (d > 90) { counts.valid++; continue; }
    if (d > reminderDays) { counts.soon++; continue; }
    d < 0 ? counts.expired++ : counts.due++;
    const when = d < 0 ? `expired ${Math.abs(d)}d ago` : d === 0 ? "expires today" : `expires in ${d}d`;
    const who = `*${e.name}* (${e.employee_id}, ${e.department}) · ${label}`;
    if (c.scheduled_date) booked.push({ days: d, line: `• ${who} · ${when} · booked for ${fmt(c.scheduled_date)}` });
    else needsBooking.push({ days: d, line: `• ${who} · ${when}` });
  }
  needsBooking.sort((a, b) => a.days - b.days);
  booked.sort((a, b) => a.days - b.days);

  const MAX = 40;
  const cap = (arr: { line: string }[]) => {
    const lines = arr.slice(0, MAX).map(x => x.line);
    if (arr.length > MAX) lines.push(`_and ${arr.length - MAX} more in the portal_`);
    return lines;
  };

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `${cfg.label} compliance · ${month}` } },
    { type: "section", fields: [
      { type: "mrkdwn", text: `*Expired*\n${counts.expired}` },
      { type: "mrkdwn", text: `*Due in ${reminderDays} days*\n${counts.due}` },
      { type: "mrkdwn", text: `*Due in 90 days*\n${counts.soon}` },
      { type: "mrkdwn", text: `*Missing dates*\n${counts.missing}` },
    ] },
    { type: "divider" },
  ];

  if (!needsBooking.length && !booked.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `All clear. Nobody is expired or due in the next ${reminderDays} days. Nice work, team.` } });
  } else {
    if (needsBooking.length) blocks.push(...listBlocks(`Needs booking (${needsBooking.length})`, cap(needsBooking)));
    if (booked.length)       blocks.push(...listBlocks(`Already booked (${booked.length})`, cap(booked)));
  }

  blocks.push({ type: "actions", elements: [
    { type: "button", text: { type: "plain_text", text: "Open the portal" }, url: PORTAL_URL, style: "primary" },
  ] });

  const text = `${cfg.label} compliance ${month}: ${counts.expired} expired, ${counts.due} due in ${reminderDays} days, ${needsBooking.length} need booking.`;
  return { text, blocks: blocks.slice(0, 50) };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret) return new Response("CRON_SECRET is not set", { status: 500 });
  if (req.headers.get("x-cron-secret") !== secret) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const only = url.searchParams.get("market");

  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const [emps, certs, settings] = await Promise.all([
      fetchAll<Emp>(sb, "employees", "id,name,employee_id,department,market"),
      fetchAll<Cert>(sb, "certificates", "employee_id,type,expiry_date,scheduled_date,market"),
      fetchAll<{ market: string; reminder_days: number }>(sb, "settings", "market,reminder_days"),
    ]);

    const results: Record<string, unknown> = {};
    for (const market of Object.keys(MARKETS)) {
      if (only && only !== market) continue;
      const reminderDays = settings.find(s => s.market === market)?.reminder_days ?? 30;
      const payload = buildMessage(market, emps.filter(e => e.market === market), certs.filter(c => c.market === market), reminderDays);
      if (dry) { results[market] = payload; continue; }

      const hook = Deno.env.get(`SLACK_WEBHOOK_${market.toUpperCase()}`) || Deno.env.get("SLACK_WEBHOOK_URL");
      if (!hook) { results[market] = "skipped: no webhook secret for this market"; continue; }
      const res = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      results[market] = res.ok ? "sent" : `slack error ${res.status}: ${await res.text()}`;
    }
    return new Response(JSON.stringify(results, null, 2), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
