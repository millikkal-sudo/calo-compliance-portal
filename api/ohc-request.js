// Called by the portal right after "✓ Emirates ID received".
// Starts the Slack request: supervisors pick an OHC appointment date in the next 14 days.
// Security: the caller must send their portal login token, and be allowed to confirm Emirates IDs.
const { db, startNewOhcRequest } = require("./_lib");
const SUPABASE_URL = "https://iflquskysqchhbywvmow.supabase.co";
const CONFIRMERS = (process.env.EID_CONFIRMERS || "m.illikkal@calo.app").split(",").map(s => s.trim().toLowerCase());

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  try {
    // Who is calling? Ask Supabase to verify the login token from the portal
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Not signed in" });
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!who.ok) return res.status(401).json({ error: "Login not valid" });
    const user = await who.json();
    if (!CONFIRMERS.includes((user.email || "").toLowerCase())) return res.status(403).json({ error: "Not allowed to confirm Emirates ID" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (!body.employeeId) return res.status(400).json({ error: "employeeId missing" });

    const [emp] = await db(`employees?id=eq.${encodeURIComponent(body.employeeId)}&select=id,name,employee_id,department,market,eid_confirmed`);
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    if (emp.eid_confirmed === false) return res.status(409).json({ error: "Emirates ID not confirmed yet" });

    // The OHC record (the portal creates it on confirm; make sure it exists)
    let [cert] = await db(`certificates?employee_id=eq.${emp.id}&type=eq.ohc&select=id,issue_date`);
    if (!cert) [cert] = await db("certificates", { method: "POST", prefer: "return=representation", body: { employee_id: emp.id, type: "ohc", market: emp.market } });
    if (cert.issue_date) return res.status(200).json({ status: "OHC already recorded, nothing to book" });

    const status = await startNewOhcRequest({ market: emp.market, emp, certId: cert.id });
    res.status(200).json({ status });
  } catch (err) {
    console.error("ohc-request:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
};
