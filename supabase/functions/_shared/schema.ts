// Request validation for the public API. Invalid input becomes a 422 with field-level details.
import { z } from "npm:zod@3.23.8";
import { calc } from "./invoice.ts";
import { numStr, parseIso, type ApiInvoiceInput } from "./mapper.ts";

const isoDate = z.string().refine((s) => parseIso(s) !== null, {
  message: "Must be an ISO 8601 date, e.g. 2026-11-08 or 2026-11-08T14:30:00+01:00.",
});
const money = (what: string) => z.number({ invalid_type_error: `${what} must be a number.` })
  .finite().refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, {
    message: `${what} can have at most 2 decimal places.`,
  });

export const paymentSchema = z.object({
  method: z.enum(["cash", "bank_transfer", "pos"], { errorMap: () => ({ message: "Must be one of cash, bank_transfer, pos." }) }),
  amount: money("amount").refine((n) => n > 0, { message: "Must be greater than 0." }),
  date: isoDate.optional(),
}).strict();

export const invoiceSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(1, "Customer name is required.").max(200),
    phone: z.string().trim().max(40).optional(),
  }).strict(),
  currency: z.enum(["NGN", "USD", "GBP", "EUR"], { errorMap: () => ({ message: "Must be one of NGN, USD, GBP, EUR." }) }),
  issue_date: isoDate.optional(),
  items: z.array(z.object({
    description: z.string().trim().min(1, "Description is required.").max(500),
    serial: z.string().trim().max(200).optional(),
    quantity: z.number({ invalid_type_error: "quantity must be a number." }).finite().min(1, "Must be at least 1.").default(1),
    unit_price: money("unit_price").refine((n) => n > 0, { message: "Must be greater than 0." }),
  }).strict()).min(1, "Add at least one item.").max(200, "At most 200 items."),
  discount: money("discount").refine((n) => n >= 0, { message: "Cannot be negative." }).default(0),
  delivery: money("delivery").refine((n) => n >= 0, { message: "Cannot be negative." }).default(0),
  tax_percent: z.number({ invalid_type_error: "tax_percent must be a number." }).finite().min(0, "Cannot be negative.").max(100, "Cannot be more than 100.").default(0),
  payments: z.array(paymentSchema).max(50, "At most 50 payments.").default([]),
  notes: z.string().max(2000).optional(),
  sales_by: z.string().trim().max(100).optional(),
}).strict().superRefine((v, ctx) => {
  // Same maths as the web app, so "overpaid" means exactly what it means there.
  const c = calc({
    items: v.items.map((i) => ({ qty: numStr(i.quantity), price: numStr(i.unit_price) })),
    payments: v.payments.map((p) => ({ amount: numStr(p.amount) })),
    discount: numStr(v.discount), delivery: numStr(v.delivery), tax: numStr(v.tax_percent),
  });
  if (c.change > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payments"],
      message: `Payments add up to ${c.paid}, which is more than the invoice total of ${c.total}. Overpayment is not allowed.` });
  }
});

export type FieldError = { field: string; message: string };

export function fieldErrors(e: z.ZodError): FieldError[] {
  return e.issues.map((i) => ({ field: i.path.join(".") || "(body)", message: i.message }));
}

export function parseInvoice(body: unknown): { ok: true; value: ApiInvoiceInput } | { ok: false; errors: FieldError[] } {
  const r = invoiceSchema.safeParse(body);
  return r.success ? { ok: true, value: r.data as ApiInvoiceInput } : { ok: false, errors: fieldErrors(r.error) };
}

export function parsePayment(body: unknown) {
  const r = paymentSchema.safeParse(body);
  return r.success ? { ok: true as const, value: r.data } : { ok: false as const, errors: fieldErrors(r.error) };
}
