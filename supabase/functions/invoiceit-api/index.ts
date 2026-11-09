// Invoiceit public REST API. All routes are under /v1:
//   POST /v1/invoices                    create an invoice (1 token; Idempotency-Key header supported)
//   GET  /v1/invoices                    list (?limit=1..100&cursor=&status=PAID|UNPAID|PART-PAID&from=&to=)
//   GET  /v1/invoices/:id                one invoice
//   POST /v1/invoices/:id/payments       record a payment (no overpayment)
//   GET  /v1/invoices/:id/html           the printable invoice page
//   GET  /v1/invoices/:id/pdf            501 until a PDF renderer is plugged in (see _shared/pdf.ts)
//   GET  /v1/usage                       plan, tokens used/remaining, reset date
// Auth: "Authorization: Bearer inv_live_...". The key is hashed here (SHA-256); only the hash is looked up or stored.
// Every query is scoped to the key's business. The service role is used internally because API callers have no
// Supabase session; the database functions it calls take the business id from the key, never from the request.
//
// Deploy with JWT verification OFF (callers send an API key, not a Supabase token):
//   supabase functions deploy invoiceit-api --no-verify-jwt
// Optional secret: INVOICEIT_APP_URL (e.g. https://invoiceit.app) for the team-only app link on each invoice.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { invoicePage, type InvoiceData } from "../_shared/invoice.ts";
import { fromRow, toAppPayment, toBlob, type Business, type InvoiceRow } from "../_shared/mapper.ts";
import { parseInvoice, parsePayment } from "../_shared/schema.ts";
import { renderPdf } from "../_shared/pdf.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const APP_URL = (Deno.env.get("INVOICEIT_APP_URL") ?? "").replace(/\/+$/, "");
const API_BASE = `${SUPABASE_URL}/functions/v1/invoiceit-api/v1`;
const RATE_LIMIT = 60; // requests per key per minute

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "X-Tokens-Remaining, Retry-After, Idempotent-Replayed, X-RateLimit-Limit",
};

type Ctx = { keyId: string; keyPrefix: string; business: Business; active: boolean; remaining: number | null };

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public headers: Record<string, string> = {}) {
    super(message);
  }
}

function respond(status: number, body: unknown, ctx: Ctx | null, extra: Record<string, string> = {}) {
  const h: Record<string, string> = { ...CORS, "Content-Type": "application/json; charset=utf-8", "X-RateLimit-Limit": String(RATE_LIMIT), ...extra };
  if (ctx?.remaining != null) h["X-Tokens-Remaining"] = String(ctx.remaining);
  return new Response(JSON.stringify(body), { status, headers: h });
}
function errorBody(e: ApiError) {
  return { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
}

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function links(id: string) {
  return { app_url: APP_URL ? `${APP_URL}/invoice.html?id=${encodeURIComponent(id)}` : null, html_url: `${API_BASE}/invoices/${encodeURIComponent(id)}/html` };
}
function present(row: InvoiceRow) {
  return fromRow({ ...row, data: { ...row.data, no: row.no } }, links(row.id) as { app_url: string; html_url: string });
}

async function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

/* ---------- auth ---------- */
async function authenticate(req: Request): Promise<Ctx> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "");
  if (!m) throw new ApiError(401, "unauthorized", "Missing API key. Send it as: Authorization: Bearer inv_live_...");
  const key = m[1];
  if (!/^inv_live_[0-9a-f]{32}$/.test(key)) throw new ApiError(401, "unauthorized", "That API key is not valid.");
  const r = await rpc("invoiceit_api_begin", { p_key_hash: await sha256Hex(key), p_rate_limit: RATE_LIMIT });
  if (!r.ok) {
    if (r.reason === "rate_limited") {
      // Log the refused call against the key's business, then refuse.
      await logUsage({ keyId: r.key_id, businessId: r.business_id }, "rate_limited", 429);
      throw new ApiError(429, "rate_limited", `Too many requests. The limit is ${RATE_LIMIT} per minute per key.`, undefined,
        { "Retry-After": String(r.retry_after) });
    }
    throw new ApiError(401, "unauthorized", r.reason === "revoked" ? "This API key has been revoked." : "That API key is not valid.");
  }
  return { keyId: r.key_id, keyPrefix: r.key_prefix, business: r.business, active: r.active, remaining: r.quota?.remaining ?? null };
}

function requireActive(ctx: Ctx) {
  if (!ctx.active) {
    throw new ApiError(402, "subscription_inactive",
      "This business's Invoiceit subscription has ended. The owner can renew it in Invoiceit to use the API again.");
  }
}

async function logUsage(who: { keyId: string; businessId: string }, endpoint: string, status: number, invoiceId: string | null = null, tokens = 0) {
  const { error } = await admin.from("invoiceit_api_usage").insert({
    business_id: who.businessId, api_key_id: who.keyId, endpoint, status_code: status, invoice_id: invoiceId, tokens_charged: tokens,
  });
  if (error) console.error("usage log failed", error.message);
}

async function readJson(req: Request) {
  const text = await req.text();
  if (text.length > 256_000) throw new ApiError(413, "payload_too_large", "Request body is larger than 256 KB.");
  try { return text ? JSON.parse(text) : {}; } catch { throw new ApiError(400, "invalid_json", "The request body is not valid JSON."); }
}

async function getRow(ctx: Ctx, id: string): Promise<InvoiceRow> {
  const { data, error } = await admin.from("invoiceit_invoices").select("id, no, data, created_at, updated_at")
    .eq("business_id", ctx.business.id).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(404, "not_found", "No invoice with that id in this business.");
  return data as InvoiceRow;
}

function noTokens(q: any): ApiError {
  const resets = q?.resets_at ? new Date(q.resets_at).toISOString().slice(0, 10) : "next month";
  return new ApiError(402, "tokens_exhausted",
    `You have used all ${q?.limit ?? ""} invoice tokens on the ${q?.plan ?? "current"} plan this month. Upgrade your plan in Invoiceit (Business → API), or wait until ${resets} when your allowance resets.`,
    { plan: q?.plan, limit: q?.limit, used: q?.used, resets_at: q?.resets_at });
}

/* ---------- handlers ---------- */
async function createInvoice(req: Request, ctx: Ctx) {
  requireActive(ctx);
  const body = await readJson(req);
  const parsed = parseInvoice(body);
  if (!parsed.ok) throw new ApiError(422, "validation_failed", "The invoice has errors. See details.", parsed.errors);
  const idem = req.headers.get("Idempotency-Key");
  if (idem !== null && (idem.length < 1 || idem.length > 255)) {
    throw new ApiError(422, "validation_failed", "Idempotency-Key must be 1 to 255 characters.", [{ field: "Idempotency-Key", message: "1 to 255 characters." }]);
  }
  const blob = toBlob(parsed.value, ctx.business, ctx.keyPrefix);
  let r: any;
  try {
    r = await rpc("invoiceit_api_create_invoice", {
      p_business_id: ctx.business.id, p_data: blob, p_idempotency_key: idem,
      p_request_hash: await sha256Hex(JSON.stringify(parsed.value)), p_actor: "api:" + ctx.keyPrefix,
    });
  } catch (e) {
    // The database's own invoice checks (currency, negative amounts, overpayment) raise check_violation.
    if ((e as any)?.code === "23514") throw new ApiError(422, "validation_failed", (e as Error).message);
    throw e;
  }
  if (!r.ok) {
    if (r.reason === "no_tokens") throw noTokens(r.quota);
    if (r.reason === "no_access") requireActive({ ...ctx, active: false });
    if (r.reason === "idempotency_mismatch") throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request body.");
    if (r.reason === "idempotency_in_progress") throw new ApiError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed. Retry shortly.");
    throw new ApiError(500, "internal_error", "Could not create the invoice.");
  }
  if (r.replay) {
    const response = r.response ?? { data: present(await getRow(ctx, r.invoice_id)) };
    return { status: r.status_code ?? 201, body: response, invoiceId: r.invoice_id, tokens: 0, headers: { "Idempotent-Replayed": "true" } };
  }
  ctx.remaining = r.quota?.remaining ?? ctx.remaining;
  const response = { data: present(r.invoice) };
  if (idem) await rpc("invoiceit_api_save_idempotent", { p_business_id: ctx.business.id, p_key: idem, p_status: 201, p_response: response });
  return { status: 201, body: response, invoiceId: r.invoice.id as string, tokens: 1 };
}

async function listInvoices(url: URL, ctx: Ctx) {
  requireActive(ctx);
  const errors: { field: string; message: string }[] = [];
  const q = url.searchParams;
  const limit = q.has("limit") ? Number(q.get("limit")) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) errors.push({ field: "limit", message: "Must be a whole number from 1 to 100." });
  const status = q.get("status")?.toUpperCase() ?? null;
  if (status && !["PAID", "UNPAID", "PART-PAID"].includes(status)) errors.push({ field: "status", message: "Must be PAID, UNPAID or PART-PAID." });
  const date = (name: string) => {
    const v = q.get(name); if (!v) return null;
    const t = Date.parse(v); if (isNaN(t)) { errors.push({ field: name, message: "Must be an ISO 8601 date." }); return null; }
    return new Date(t).toISOString();
  };
  const from = date("from"), to = date("to");
  let after: { c: string; i: string } | null = null;
  if (q.get("cursor")) {
    try {
      after = JSON.parse(atob(q.get("cursor")!.replace(/-/g, "+").replace(/_/g, "/")));
      if (typeof after?.c !== "string" || typeof after?.i !== "string") throw 0;
    } catch { errors.push({ field: "cursor", message: "Not a valid cursor. Use next_cursor from the previous page." }); }
  }
  if (errors.length) throw new ApiError(422, "validation_failed", "Some query parameters are wrong. See details.", errors);

  const rows = await rpc<InvoiceRow[]>("invoiceit_api_list_invoices", {
    p_business_id: ctx.business.id, p_limit: limit + 1, p_after_created: after?.c ?? null, p_after_id: after?.i ?? null,
    p_status: status, p_from: from, p_to: to,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const hasMore = rows.length > limit;
  const next = hasMore && last ? btoa(JSON.stringify({ c: last.created_at, i: last.id })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
  return { status: 200, body: { data: page.map(present), has_more: hasMore, next_cursor: next } };
}

async function addPayment(req: Request, ctx: Ctx, id: string) {
  requireActive(ctx);
  const parsed = parsePayment(await readJson(req));
  if (!parsed.ok) throw new ApiError(422, "validation_failed", "The payment has errors. See details.", parsed.errors);
  let r: any;
  try {
    r = await rpc("invoiceit_api_add_payment", {
      p_business_id: ctx.business.id, p_invoice_id: id, p_payment: toAppPayment(parsed.value, ctx.business.region), p_actor: "api:" + ctx.keyPrefix,
    });
  } catch (e) {
    if ((e as any)?.code === "23514") throw new ApiError(422, "validation_failed", (e as Error).message);
    throw e;
  }
  if (!r.ok) {
    if (r.reason === "not_found") throw new ApiError(404, "not_found", "No invoice with that id in this business.");
    if (r.reason === "fully_paid") throw new ApiError(422, "already_paid", "This invoice is already fully paid.", { balance: 0 });
    throw new ApiError(422, "overpayment", `The payment is more than the ${r.balance} left to pay. Overpayment is not allowed.`, { balance: Number(r.balance) });
  }
  return { status: 201, body: { data: present(r.invoice) }, invoiceId: id };
}

async function usage(ctx: Ctx) {
  const q = await rpc("invoiceit_api_quota", { p_business_id: ctx.business.id });
  ctx.remaining = q.remaining;
  return { status: 200, body: { data: {
    plan: q.plan, plan_name: q.plan_name, tokens_limit: q.limit, tokens_used: q.used, tokens_remaining: q.remaining,
    resets_at: q.resets_at, subscription_active: q.active,
  } } };
}

/* ---------- router ---------- */
type Result = { status: number; body?: unknown; html?: string; invoiceId?: string | null; tokens?: number; headers?: Record<string, string> };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/invoiceit-api(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  let ctx: Ctx | null = null;
  let endpoint = `${req.method} ${path}`;
  try {
    const m = /^\/v1\/invoices\/([^/]+)(?:\/(payments|html|pdf))?$/.exec(path);
    const route =
      path === "/v1/invoices" ? (req.method === "POST" ? "create" : req.method === "GET" ? "list" : "405") :
      path === "/v1/usage" ? (req.method === "GET" ? "usage" : "405") :
      m ? (m[2] === "payments" ? (req.method === "POST" ? "pay" : "405") : (req.method === "GET" ? (m[2] ?? "get") : "405")) :
      "404";
    if (route === "404") throw new ApiError(404, "not_found", `No such endpoint: ${req.method} ${path}. See the API reference.`);
    if (route === "405") throw new ApiError(405, "method_not_allowed", `${req.method} is not allowed on ${path}.`);
    endpoint = `${req.method} ${m ? path.replace(m[1], ":id") : path}`;

    ctx = await authenticate(req);
    let r: Result;
    switch (route) {
      case "create": r = await createInvoice(req, ctx); break;
      case "list": r = await listInvoices(url, ctx); break;
      case "usage": r = await usage(ctx); break;
      case "pay": r = await addPayment(req, ctx, decodeURIComponent(m![1])); break;
      case "get": { requireActive(ctx); const row = await getRow(ctx, decodeURIComponent(m![1])); r = { status: 200, body: { data: present(row) }, invoiceId: row.id }; break; }
      case "html": {
        requireActive(ctx);
        const row = await getRow(ctx, decodeURIComponent(m![1]));
        r = { status: 200, html: invoicePage({ ...(row.data as InvoiceData), no: row.no }), invoiceId: row.id };
        break;
      }
      case "pdf": {
        requireActive(ctx);
        const row = await getRow(ctx, decodeURIComponent(m![1]));
        const pdf = await renderPdf(invoicePage({ ...(row.data as InvoiceData), no: row.no }));
        if (!pdf) {
          throw new ApiError(501, "not_implemented",
            `PDF output isn't available yet. Use GET /v1/invoices/${row.id}/html and print it or save it as PDF from a browser.`,
            { html_url: links(row.id).html_url });
        }
        await logUsage({ keyId: ctx.keyId, businessId: ctx.business.id }, endpoint, 200, row.id);
        return new Response(pdf, { status: 200, headers: { ...CORS, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="invoice-${row.no}.pdf"` } });
      }
      default: throw new ApiError(500, "internal_error", "Unhandled route.");
    }
    await logUsage({ keyId: ctx.keyId, businessId: ctx.business.id }, endpoint, r.status, r.invoiceId ?? null, r.tokens ?? 0);
    if (r.html !== undefined) {
      const h: Record<string, string> = { ...CORS, "Content-Type": "text/html; charset=utf-8", "X-RateLimit-Limit": String(RATE_LIMIT) };
      if (ctx.remaining != null) h["X-Tokens-Remaining"] = String(ctx.remaining);
      return new Response(r.html, { status: r.status, headers: h });
    }
    return respond(r.status, r.body, ctx, r.headers);
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(500, "internal_error", "Something went wrong on our side. Please try again.");
    if (!(e instanceof ApiError)) console.error("invoiceit-api error", endpoint, e);
    if (ctx) await logUsage({ keyId: ctx.keyId, businessId: ctx.business.id }, endpoint, err.status);
    return respond(err.status, errorBody(err), ctx, err.headers);
  }
});
