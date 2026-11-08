// Checks that the API's invoice maths (supabase/functions/_shared/invoice.ts) gives exactly the same
// results as the web app's (js/store.js): calc(), settle() and the printed paper() HTML.
// Run: node scripts/test-invoice-parity.mjs   (Node 22.6+; .ts is loaded with type stripping)
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as api from "../supabase/functions/_shared/invoice.ts";

// Load js/store.js with just enough of a browser around it to define window.Store.
const sandbox = { window: { supabase: { createClient: () => ({}) }, INVOICEIT_CONFIG: {} }, document: {}, location: {}, console };
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../js/store.js", import.meta.url), "utf8"), sandbox);
const web = sandbox.window.Store;

const cases = [
  { currency: "NGN", items: [{ desc: "Office desk", qty: "1", price: "185000" }, { desc: "Office chair", qty: "2", price: "45,000" }], payments: [{ method: "Bank Transfer", amount: "150000", date: "05-11-2026" }] },
  { currency: "USD", items: [{ desc: "A <b>", serial: "SN & 1", qty: "", price: "19.99" }], payments: [], discount: "5", delivery: "3.5", tax: "7.5", notes: "Thanks\n'quoted'" },
  { currency: "GBP", items: [{ desc: "x", qty: "3", price: "33.333" }], payments: [{ method: "Cash", amount: "99.999" }] },
  { currency: "EUR", items: [{ desc: "y", qty: "0", price: "10" }], payments: [] },
  { currency: "NGN", items: [{ desc: "z", qty: "1", price: "100" }], payments: [{ method: "POS", amount: "150" }], discount: "500" },
  { currency: "USD", items: [{ desc: "big", qty: "1.5", price: "1234567.891" }], payments: [{ method: "Cash", amount: "1000000" }], tax: "12.345" },
];
// Plus random ones
for (let k = 0; k < 300; k++) {
  const r = (max, dp = 2) => (Math.random() * max).toFixed(dp);
  cases.push({
    currency: ["NGN", "USD", "GBP", "EUR"][k % 4],
    items: Array.from({ length: 1 + (k % 4) }, (_, i) => ({ desc: "Item " + i, qty: k % 7 ? r(5, 0) : "", price: r(100000) })),
    payments: Array.from({ length: k % 3 }, () => ({ method: "Cash", amount: r(150000), date: "01-01-2026" })),
    discount: k % 5 ? "" : r(500), delivery: k % 6 ? "" : r(300), tax: k % 4 ? "" : r(20, 1),
  });
}

let failures = 0;
for (const [n, c] of cases.entries()) {
  const inv = { no: "000" + n, date: "05-11-2026 06:01 PM", cust: "Ada", phone: "080", salesBy: "Bo", store: { name: "Shop", addr: "Lagos", phone: "070" }, ...c };
  const a = JSON.stringify(web.calc(structuredClone(inv))), b = JSON.stringify(api.calc(structuredClone(inv)));
  const pa = web.paper(structuredClone(inv)), pb = api.paper(structuredClone(inv));
  const sa = JSON.stringify(web.settle(web.calc(inv), inv.currency)), sb = JSON.stringify(api.settle(api.calc(inv), inv.currency));
  if (a !== b || pa !== pb || sa !== sb) {
    failures++;
    if (failures <= 3) console.error("MISMATCH case", n, { web: a, api: b, paperSame: pa === pb, settleSame: sa === sb });
  }
}
for (const v of ["1,000", "abc", null, "12.5x", " 7 "]) if (web.num(v) !== api.num(v)) { failures++; console.error("num mismatch", v); }
if (web.esc(`<a href="x">'&'</a>`) !== api.esc(`<a href="x">'&'</a>`)) { failures++; console.error("esc mismatch"); }

console.log(failures ? `FAILED: ${failures} mismatches out of ${cases.length} invoices` : `OK: ${cases.length} invoices identical (calc, settle, paper)`);
process.exit(failures ? 1 : 0);
