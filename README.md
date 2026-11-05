# JB Enterprise invoices

Invoice generator for JB Enterprise. The store name is fixed in `js/store.js` (`STORE_NAME`) and printed on every invoice.

Plain HTML, CSS and JavaScript. No build step, no install.

## Run it
Unzip, then double-click `index.html`. (Fonts load from Google Fonts when online; the app also works offline with system fonts.)

## Pages
- `index.html`: invoice list with totals, search and Paid / Part-paid / Unpaid filters
- `new.html`: invoice form with a live preview that matches the store's printed layout
- `invoice.html?id=...`: view an invoice, print or save as PDF, share on WhatsApp, record payments, duplicate

All pages are responsive, so the same files serve the website, laptop and phone layouts.

## Good to know
- Invoices are stored in Supabase (project "Projects", tables `jb_invoices`, `jb_settings`, `jb_staff`). Every signed-in staff device sees the same invoices.
- Only emails on the staff list can open the app. Add someone in the Supabase SQL Editor:
  `insert into public.jb_staff (email) values ('name@example.com');` (lowercase). Remove with `delete from public.jb_staff where email = '...';`
- There is no sign-up in the app. The owner creates each account in Supabase (Authentication → Users → Add user → Create new user, tick Auto Confirm User), adds the email to `jb_staff`, and gives the person their password.
- Invoice numbers are assigned by the database when an invoice is saved, so two devices never get the same number.
- `js/config.js` holds the project URL and publishable key, which are safe to be public. Never put the DATABASE_URL or a secret key in this folder.
- Database setup: `supabase/migrations/`.
- "Download PDF" opens the print dialog; choose "Save as PDF". Only the invoice itself is printed.
- "Copy link" works on any device once the person is signed in as staff.
- To deploy: drag this folder into Vercel or Netlify. It is a static site.

## Folders
- `css/styles.css`, `js/store.js`, `js/config.js`: shared styles, storage (Supabase), maths, the invoice template and connection settings
- `design-source/`: the original design-canvas files (website, mobile and laptop views). Reference only; they need the design tool to open.
# JB-Invoice-Generator
