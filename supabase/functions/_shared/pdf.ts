// PDF output for the public API.
// Puppeteer/Chromium can't run in Supabase Edge Functions, so there is no renderer yet and
// GET /v1/invoices/:id/pdf answers 501. To add one later, replace renderPdf() only, for example with a call to a
// hosted HTML-to-PDF service or a small Node service running Puppeteer:
//
//   export async function renderPdf(html: string): Promise<Uint8Array | null> {
//     const r = await fetch(Deno.env.get("PDF_RENDERER_URL")!, { method: "POST", headers: { "content-type": "text/html" }, body: html });
//     if (!r.ok) throw new Error(`PDF renderer failed: ${r.status}`);
//     return new Uint8Array(await r.arrayBuffer());
//   }
//
// The HTML passed in is the same page GET /v1/invoices/:id/html returns, with an A4 @page rule.

/* Returns the PDF bytes, or null when no renderer is configured. */
export async function renderPdf(_html: string): Promise<Uint8Array | null> {
  return null;
}
