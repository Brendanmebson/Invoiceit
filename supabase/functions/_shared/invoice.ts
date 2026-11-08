// Invoice maths and the printed invoice, ported line for line from js/store.js so the API and the
// web app always agree. No imports, so it runs in Deno (edge functions) and Node (tests) alike.
// If you change calc(), paper() or settle() in js/store.js, change them here too
// (scripts/test-invoice-parity.mjs checks the two give identical output).

export type Item = { desc?: string; serial?: string; qty?: string | number; price?: string | number };
export type Payment = { method?: string; amount?: string | number; date?: string };
export type InvoiceData = {
  no?: string;
  date?: string;
  currency?: string;
  cust?: string;
  phone?: string;
  salesBy?: string;
  createdBy?: string;
  notes?: string;
  discount?: string | number;
  delivery?: string | number;
  tax?: string | number;
  items: Item[];
  payments: Payment[];
  store?: { name?: string; addr?: string; phone?: string };
  [k: string]: unknown;
};
export type Calc = {
  sub: number; disc: number; del: number; tax: number; total: number;
  paid: number; balance: number; change: number; status: "PAID" | "UNPAID" | "PART-PAID";
};

export const SYMS: Record<string, string> = { NGN: "₦", USD: "$", GBP: "£", EUR: "€" };

export function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}
export function num(v: unknown): number {
  const n = parseFloat(String(v == null ? "" : v).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}
export function plain(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function money(n: number, cur?: string): string {
  return (SYMS[cur ?? ""] || "") + " " + plain(n);
}
export function qty(i: Item): number {
  return String(i.qty == null ? "" : i.qty).trim() === "" ? 1 : num(i.qty);
}
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function calc(inv: InvoiceData): Calc {
  const sub = inv.items.reduce((a, i) => a + qty(i) * num(i.price), 0);
  const disc = Math.min(num(inv.discount), sub);
  const del = num(inv.delivery);
  const tax = (sub - disc) * num(inv.tax) / 100;
  let total = sub - disc + del + tax;
  let paid = inv.payments.reduce((a, p) => a + num(p.amount), 0);
  total = round2(total); paid = round2(paid);
  const balance = Math.max(round2(total - paid), 0); // still to pay
  const change = Math.max(round2(paid - total), 0);  // paid too much, give back
  const status = balance === 0 && total > 0 ? "PAID" : (paid <= 0 ? "UNPAID" : "PART-PAID");
  return { sub, disc, del, tax, total, paid, balance, change, status };
}

/* Plain-language check of items total against payments. */
export function settle(c: Calc, cur?: string): { kind: string; text: string } {
  if (c.total <= 0) return { kind: "none", text: "Add items to see the total." };
  if (c.balance > 0) return { kind: "owed", text: (c.paid > 0 ? "Part paid. " : "Nothing paid yet. ") + money(c.balance, cur) + " left to pay." };
  if (c.change > 0) return { kind: "over", text: "Payments are " + money(c.change, cur) + " more than the total. Overpaying is not allowed, so reduce a payment." };
  return { kind: "ok", text: "Fully paid. Payments match the items total." };
}

/* The printed invoice, laid out like the store's real receipts. Same markup as Store.paper(). */
export function paper(inv: InvoiceData): string {
  const c = calc(inv), cur = inv.currency, m = (n: number) => money(n, cur);
  const store = inv.store ?? {};
  const rows = inv.items.map((i) => {
    const line = qty(i) * num(i.price);
    return '<div class="p-grid p-tr"><div><div class="pn">' + esc(i.desc) + "</div>" +
      (String(i.serial || "").trim() ? '<div class="sn">' + esc(i.serial) + "</div>" : "") + "</div>" +
      "<span>" + plain(qty(i)) + " Pc(s)</span><span>" + plain(num(i.price)) + "</span><span>" + plain(line) + "</span></div>";
  }).join("");
  const pays = inv.payments.map((p) =>
    '<div class="p-pay"><span>' + esc(p.method) + "</span><span>" + m(num(p.amount)) + "</span><span>" + esc(p.date) + "</span></div>"
  ).join("");
  let sum = '<div class="p-sum"><b>Subtotal:</b><span>' + m(c.sub) + "</span></div>";
  if (c.disc > 0) sum += '<div class="p-sum"><b>Discount:</b><span>-' + m(c.disc) + "</span></div>";
  if (c.del > 0) sum += '<div class="p-sum"><b>Delivery:</b><span>' + m(c.del) + "</span></div>";
  if (num(inv.tax) > 0) sum += '<div class="p-sum"><b>VAT (' + esc(inv.tax) + "%):</b><span>" + m(c.tax) + "</span></div>";
  sum += '<div class="p-sum"><b>Total:</b><span>' + m(c.total) + "</span></div>";
  return '<article class="paper"><div class="in-pad">' +
    '<div class="p-head"><span class="p-name">' + esc(store.name) + '</span><span class="p-addr">' + esc(store.addr) +
    '</span><span class="p-mob"><b>Mobile:</b> ' + esc(store.phone) + "</span></div>" +
    '<div class="p-title">Invoice</div>' +
    '<div class="p-meta"><div class="col"><span><b>Invoice No.</b> ' + esc(inv.no) + '</span><b>Customer</b><span style="text-transform:uppercase;overflow-wrap:anywhere">' +
    esc(inv.cust) + "</span><span><b>Mobile</b>: " + esc(inv.phone) + "</span></div><span><b>Date</b> " + esc(inv.date) + "</span></div>" +
    '<div style="font-size:12px;text-transform:uppercase"><b>Sales by</b> ' + esc(inv.salesBy) + "</div>" +
    '<div><div class="p-grid p-th"><span>Product</span><span>Quantity</span><span>Unit Price</span><span>Subtotal</span></div>' + rows + "</div>" +
    '<div class="p-rule"></div>' +
    '<div class="p-bottom"><div>' + pays + '<div class="p-pay two"><b>Total Paid</b><span>' + m(c.paid) + "</span></div>" +
    (c.balance > 0 ? '<div class="p-pay two"><b>Balance to pay</b><span>' + m(c.balance) + "</span></div>" : "") +
    (c.change > 0 ? '<div class="p-pay two"><b>Overpaid</b><span>' + m(c.change) + "</span></div>" : "") + "</div><div>" + sum + "</div></div>" +
    (String(inv.notes || "").trim() ? '<div class="p-notes">' + esc(inv.notes) + "</div>" : "") +
    "</div></article>";
}

/* The invoice's own styles from css/styles.css, plus A4 page setup, for a standalone page. */
export const PRINT_CSS = `
@page{size:A4;margin:14mm 12mm}
*{box-sizing:border-box}
html,body{margin:0;background:#E7E8EA}
body{display:flex;justify-content:center;padding:24px 12px}
.paper{width:100%;max-width:720px;min-height:877px;background:#fff;color:#111;font-family:'Open Sans',system-ui,sans-serif;font-weight:400;overflow:hidden;box-shadow:0 0 0 2px #111}
.paper .in-pad{padding:40px 32px 48px;display:flex;flex-direction:column;gap:22px}
.p-head{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center}
.p-name{font-family:'Arimo',Arial,sans-serif;font-size:32px;line-height:1.1;text-transform:uppercase;overflow-wrap:anywhere}
.p-addr{font-size:10.5px;text-transform:uppercase;overflow-wrap:anywhere}
.p-mob{font-size:12px}
.p-title{text-align:center;font-family:'Arimo',Arial,sans-serif;font-size:24px;text-transform:uppercase}
.p-meta{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 16px;font-size:12px;line-height:1.7}
.p-meta .col{display:flex;flex-direction:column;min-width:0}
.paper b{font-weight:700}
.p-grid{display:grid;grid-template-columns:minmax(0,1fr) 82px 88px 92px;gap:8px;font-size:12px}
.p-th{padding:6px 0 8px;font-weight:700}
.p-th span:nth-child(n+2),.p-tr span:nth-child(n+2){text-align:right}
.p-tr{padding:7px 0;border-bottom:1px dotted #9A9A9A}
.p-tr .pn{text-transform:uppercase;overflow-wrap:anywhere}
.p-tr .sn{font-size:10px;margin-top:3px;overflow-wrap:anywhere}
.p-rule{margin-top:14px;border-top:2px dotted #111}
.p-bottom{display:flex;flex-wrap:wrap;gap:24px 36px;font-size:12px}
.p-bottom>div{flex:1 1 240px;min-width:0;display:flex;flex-direction:column}
.p-pay{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1.2fr) minmax(0,1fr);gap:8px;padding:7px 0;border-bottom:1px dotted #9A9A9A}
.p-pay.two{grid-template-columns:minmax(0,1.1fr) minmax(0,2.2fr)}
.p-sum{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px dotted #9A9A9A}
.p-notes{font-size:10.5px;line-height:1.6;color:#333;white-space:pre-line}
@media (max-width:640px){.paper .in-pad{padding:24px 16px 28px}.p-name{font-size:24px}.p-grid{grid-template-columns:minmax(0,1fr) 62px 70px 78px;font-size:11px}}
@media print{html,body{background:#fff}body{display:block;padding:0}.paper{box-shadow:none;max-width:none;min-height:0}}
`;

/* A complete HTML page for one invoice: fonts, print CSS and the paper() markup. */
export function invoicePage(inv: InvoiceData): string {
  const title = "Invoice " + esc(inv.no) + (inv.store?.name ? " · " + esc(inv.store.name) : "");
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>" + title + "</title>" +
    "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">" +
    "<link href=\"https://fonts.googleapis.com/css2?family=Arimo:wght@400;500&family=Open+Sans:wght@400;600;700&display=swap\" rel=\"stylesheet\">" +
    "<style>" + PRINT_CSS + "</style></head><body>" + paper(inv) + "</body></html>";
}
