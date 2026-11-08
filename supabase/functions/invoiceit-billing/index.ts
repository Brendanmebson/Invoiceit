// Invoiceit billing: Paystack checkout for the monthly subscription.
// Price depends on the business's region (see invoiceit_plan in the database): ₦20,000 in Nigeria, $15 elsewhere.
// USD charges need USD enabled on the Paystack account.
// Actions (POST JSON):
//   { action: "init", months, callback_url }  -> owner only; returns Paystack authorization_url
//   { action: "verify", reference }           -> checks the payment with Paystack and adds paid time
// Paystack webhook (POST with x-paystack-signature) -> same as verify, for payments where the browser never came back.
//
// Secrets (Supabase -> Edge Functions -> Secrets): PAYSTACK_SECRET_KEY
// Deploy with JWT verification OFF (the webhook has no Supabase token); init/verify check the user themselves.

import { createClient } from "jsr:@supabase/supabase-js@2";

const PAYSTACK = "https://api.paystack.co";
const SECRET = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function paystack(path: string, init: RequestInit = {}) {
  const r = await fetch(PAYSTACK + path, {
    ...init,
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.status === false) throw new Error(body.message ?? `Paystack error ${r.status}`);
  return body.data;
}

// Adds paid time once Paystack says the charge succeeded. Safe to call twice for the same reference.
async function settle(tx: Record<string, any>) {
  if (tx.status !== "success") throw new Error("Payment was not successful.");
  const businessId = tx.metadata?.business_id;
  if (!businessId) throw new Error("Payment is missing its business.");
  // The database checks the currency and amount against this business's plan.
  const { data, error } = await admin.rpc("invoiceit_record_payment", {
    p_reference: tx.reference,
    p_business_id: businessId,
    p_amount: tx.amount,
    p_currency: tx.currency,
    p_paid_at: tx.paid_at ?? new Date().toISOString(),
    p_raw: tx,
  });
  if (error) throw new Error(error.message);
  return data as string; // new paid_until
}

async function hmacSha512Hex(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SECRET) return json({ error: "Payments are not set up yet (missing Paystack key)." }, 503);

  const raw = await req.text();

  // Paystack webhook
  const signature = req.headers.get("x-paystack-signature");
  if (signature) {
    if ((await hmacSha512Hex(SECRET, raw)) !== signature) return json({ error: "Bad signature" }, 401);
    const event = JSON.parse(raw);
    if (event.event === "charge.success") {
      try {
        const tx = await paystack(`/transaction/verify/${encodeURIComponent(event.data.reference)}`);
        await settle(tx);
      } catch (e) {
        console.error("webhook settle failed", e);
      }
    }
    return json({ ok: true });
  }

  // App calls: must be a signed-in user
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user) return json({ error: "Please sign in again." }, 401);

  let body: Record<string, any>;
  try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "Bad request" }, 400); }

  try {
    if (body.action === "init") {
      const { data: member } = await admin.from("invoiceit_members").select("business_id, role").eq("user_id", user.id).maybeSingle();
      if (!member) return json({ error: "No business found for this account." }, 403);
      if (member.role !== "owner") return json({ error: "Only the business owner can pay." }, 403);
      const months = Math.min(12, Math.max(1, Math.floor(Number(body.months) || 1)));
      const callback = typeof body.callback_url === "string" && /^https?:\/\//.test(body.callback_url) ? body.callback_url : undefined;
      const { data: plan, error: planErr } = await admin.rpc("invoiceit_business_plan", { p_business_id: member.business_id });
      if (planErr || !plan) return json({ error: "Could not work out the price for this business." }, 500);
      const tx = await paystack("/transaction/initialize", {
        method: "POST",
        body: JSON.stringify({
          email: user.email,
          amount: plan.amount * months,
          currency: plan.currency,
          callback_url: callback,
          metadata: { business_id: member.business_id, months, user_id: user.id, app: "invoiceit" },
        }),
      });
      return json({ authorization_url: tx.authorization_url, reference: tx.reference });
    }

    if (body.action === "verify") {
      if (typeof body.reference !== "string" || !body.reference) return json({ error: "Missing reference" }, 400);
      const tx = await paystack(`/transaction/verify/${encodeURIComponent(body.reference)}`);
      const paidUntil = await settle(tx);
      return json({ paid_until: paidUntil });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});
