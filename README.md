# Invoiceit

Invoices for shops and small businesses. Each business signs up, names itself, and sees only its own invoices.

Plain HTML, CSS and JavaScript. No build step, no install.

## Run it
Open `index.html` (the landing page) and click Sign up or Sign in.

## Good to know
- **Invoiceit** is for any business. Sign up with email, password and your business name. After signing in, the top bar shows your business name.
- Staff join a business with a one-time **join code** from an owner (Business page → New staff code). Codes expire after 7 days. Email alone is not enough, because email confirmation is off.
- Each business sees only its own invoices, team and codes. This is enforced in the database (row level security), not just the app.
- Data lives in Supabase (project "Projects"), tables `invoiceit_businesses`, `invoiceit_members`, `invoiceit_join_codes`, `invoiceit_invoices`. The old `jb_*` tables are no longer used by the app and can be dropped once you're happy.
- Invoice numbers are per business and assigned by the database on save, so two devices never get the same number.
- `js/config.js` holds the project URL and publishable key, which are safe to be public. Never put the DATABASE_URL or a secret key in this folder.
- "Download PDF" opens the print dialog; choose "Save as PDF". Only the invoice itself is printed.
- Deploy: this folder is a static site (Vercel / Netlify).

## Owners and staff
- **Owner (admin):** sees the Business tab: subscription and payments, business name/address/phone, team, join codes, removing people. On first sign-in a pop-up asks for the business details once; every invoice then uses them.
- **Staff:** create and view invoices and record payments. They never see or edit business details.

## Trial and billing
- 14 days free from sign-up, then ₦20,000 a month through Paystack (1, 3, 6 or 12 months at a time). Owners can pay any time; paid time is added after the trial or on top of what's left.
- When time runs out the business is locked (the database refuses its data) and the sign-in shows "trial ended" with a pay button for the owner.
- 14 days after access ends unpaid (day 28 for a business that never paid) the business, its invoices, team and codes are deleted. There is no cron job: the app runs the clean-up on every sign-in, so it happens the next time anyone uses Invoiceit after the deadline.
- An email that already had a trial does not get a second one.
- JB Enterprise is marked free forever.
- Payments go through the `invoiceit-billing` edge function (`supabase/functions/`), which needs the `PAYSTACK_SECRET_KEY` secret.

## Pages
- `index.html`: public landing page
- `invoices.html`: invoice list (sign in / sign up appear here when signed out; `#signup` opens sign up)
- `new.html`, `invoice.html?id=...`: write, view, print, share, record payments
- `business.html`: business details and team (owners can edit and add people)
