// Converts between the clean API shape (numbers, ISO dates, snake_case) and the jsonb blob the web app
// stores in invoiceit_invoices.data (strings, "dd-mm-yyyy hh:mm AM/PM", the app's field names).
// Pure functions, no imports beyond ./invoice.ts, so they can be tested with Node.
import { calc, type InvoiceData } from "./invoice.ts";

export type ApiInvoiceInput = {
  customer: { name: string; phone?: string };
  currency: "NGN" | "USD" | "GBP" | "EUR";
  issue_date?: string;
  items: { description: string; serial?: string; quantity: number; unit_price: number }[];
  discount: number;
  delivery: number;
  tax_percent: number;
  payments: { method: "cash" | "bank_transfer" | "pos"; amount: number; date?: string }[];
  notes?: string;
  sales_by?: string;
};
export type Business = { id: string; name: string; addr: string; phone: string; region: string };
export type InvoiceRow = { id: string; no: string; data: InvoiceData; created_at: string; updated_at: string };

const METHOD_TO_APP: Record<string, string> = { cash: "Cash", bank_transfer: "Bank Transfer", pos: "POS" };
const METHOD_FROM_APP: Record<string, string> = { "Cash": "cash", "Bank Transfer": "bank_transfer", "POS": "pos" };

// Where "now" is read for a business when the caller gives no date (the web app uses the device's clock).
const REGION_TZ: Record<string, string> = { ng: "Africa/Lagos", uk: "Europe/London", eu: "Europe/Paris", us: "America/New_York", intl: "UTC" };

const pad = (n: number | string, w = 2) => String(n).padStart(w, "0");

/* Number to the string form the app stores: up to 2 decimals, no trailing zeros ("1500", "19.99"). */
export function numStr(n: number): string {
  return String(Math.round(n * 100) / 100);
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number };

/* Wall-clock parts of an ISO 8601 string, as written (an offset is kept as the local time it describes). */
export function parseIso(s: string): Wall | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (!m) return null;
  const w = { y: +m[1], mo: +m[2], d: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0 };
  const check = new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi));
  if (check.getUTCFullYear() !== w.y || check.getUTCMonth() !== w.mo - 1 || check.getUTCDate() !== w.d || w.h > 23 || w.mi > 59) return null;
  return w;
}

function nowWall(region: string, now = new Date()): Wall {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: REGION_TZ[region] ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour % 24, mi: +parts.minute };
}

/* "05-11-2026 06:01 PM", the app's invoice date format. */
export function appDateTime(w: Wall): string {
  const ap = w.h >= 12 ? "PM" : "AM";
  const h12 = w.h % 12 === 0 ? 12 : w.h % 12;
  return `${pad(w.d)}-${pad(w.mo)}-${w.y} ${pad(h12)}:${pad(w.mi)} ${ap}`;
}
/* "05-11-2026", the app's payment date format. */
export function appDate(w: Wall): string {
  return `${pad(w.d)}-${pad(w.mo)}-${w.y}`;
}

/* App date ("dd-mm-yyyy" with optional " hh:mm AM/PM") back to ISO without an offset: the business's local time. */
export function isoFromApp(s: unknown, withTime: boolean): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?$/i.exec(String(s ?? "").trim());
  if (!m) return null;
  const date = `${m[3]}-${m[2]}-${m[1]}`;
  if (!withTime) return date;
  let h = m[4] ? +m[4] % 12 : 0;
  if (m[6] && m[6].toUpperCase() === "PM") h += 12;
  return `${date}T${pad(h)}:${m[5] ?? "00"}:00`;
}

/* Clean API input -> the jsonb blob the web app stores. */
export function toBlob(input: ApiInvoiceInput, business: Business, keyPrefix: string, now = new Date()): InvoiceData {
  const issued = input.issue_date ? parseIso(input.issue_date)! : nowWall(business.region, now);
  const today = nowWall(business.region, now);
  return {
    date: appDateTime(issued),
    cust: input.customer.name,
    phone: input.customer.phone ?? "",
    salesBy: input.sales_by ?? "",
    store: { name: business.name, addr: business.addr, phone: business.phone },
    currency: input.currency,
    items: input.items.map((i) => ({ desc: i.description, serial: i.serial ?? "", qty: numStr(i.quantity), price: numStr(i.unit_price) })),
    payments: input.payments.map((p) => ({
      method: METHOD_TO_APP[p.method],
      amount: numStr(p.amount),
      date: appDate(p.date ? parseIso(p.date)! : today),
    })),
    discount: input.discount ? numStr(input.discount) : "",
    delivery: input.delivery ? numStr(input.delivery) : "",
    tax: input.tax_percent ? numStr(input.tax_percent) : "",
    notes: input.notes ?? "",
    createdBy: "api:" + keyPrefix,
  };
}

/* One payment from the API -> the app's payment entry. */
export function toAppPayment(p: { method: string; amount: number; date?: string }, region: string, now = new Date()) {
  return { method: METHOD_TO_APP[p.method], amount: numStr(p.amount), date: appDate(p.date ? parseIso(p.date)! : nowWall(region, now)) };
}

/* A stored invoice row -> the API response: numbers, ISO dates and computed totals. */
export function fromRow(row: InvoiceRow, links: { app_url: string; html_url: string }) {
  const d = row.data;
  const c = calc(d);
  const n = (v: unknown) => { const x = parseFloat(String(v ?? "").replace(/,/g, "")); return isNaN(x) ? 0 : x; };
  return {
    id: row.id,
    number: row.no,
    status: c.status,
    currency: d.currency ?? null,
    issue_date: isoFromApp(d.date, true),
    customer: { name: d.cust ?? "", phone: d.phone || null },
    items: d.items.map((i) => ({
      description: i.desc ?? "",
      serial: i.serial || null,
      quantity: String(i.qty ?? "").trim() === "" ? 1 : n(i.qty),
      unit_price: n(i.price),
      line_total: Math.round((String(i.qty ?? "").trim() === "" ? 1 : n(i.qty)) * n(i.price) * 100) / 100,
    })),
    payments: d.payments.map((p) => ({
      method: METHOD_FROM_APP[p.method ?? ""] ?? String(p.method ?? "").toLowerCase().replace(/\s+/g, "_"),
      amount: n(p.amount),
      date: isoFromApp(p.date, false),
    })),
    subtotal: Math.round(c.sub * 100) / 100,
    discount: Math.round(c.disc * 100) / 100,
    delivery: Math.round(c.del * 100) / 100,
    tax_percent: n(d.tax),
    tax: Math.round(c.tax * 100) / 100,
    total: c.total,
    paid: c.paid,
    balance: c.balance,
    notes: d.notes || null,
    sales_by: d.salesBy || null,
    created_by: d.createdBy ?? null,
    business: { name: d.store?.name ?? "", address: d.store?.addr ?? "", phone: d.store?.phone ?? "" },
    created_at: row.created_at,
    updated_at: row.updated_at,
    links,
  };
}
