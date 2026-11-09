-- Invoiceit hardening (phase 7). Applies to the web app and the API alike.
--   1. Invoice data is checked by the database: known currency, no negative amounts, tax 0-100, no overpayment.
--   2. Every change to an invoice's data is recorded in invoiceit_invoice_audit with who made it and the data before.
--   3. The subscription price no longer depends only on the region the browser sent at sign-up: the billing function
--      records the payer's country (from the request) at checkout, and a business marked 'ng' whose payer is
--      outside Nigeria is charged the international price.
-- The (business_id, created_at) index on invoices was added in 20261109010000_invoiceit_api_endpoints.sql.

-- ---------- 1. invoice checks ----------
create or replace function public.invoiceit_invoices_validate()
returns trigger language plpgsql set search_path = '' as $$
declare d jsonb := new.data; it jsonb; c jsonb;
begin
  if d ->> 'currency' is null or d ->> 'currency' not in ('NGN', 'USD', 'GBP', 'EUR') then
    raise exception 'Invoice currency must be NGN, USD, GBP or EUR.' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(d -> 'items') is distinct from 'array' then
    raise exception 'Invoice items must be a list.' using errcode = 'check_violation';
  end if;
  if d ? 'payments' and jsonb_typeof(d -> 'payments') is distinct from 'array' then
    raise exception 'Invoice payments must be a list.' using errcode = 'check_violation';
  end if;
  for it in select * from jsonb_array_elements(d -> 'items') loop
    if public.invoiceit_num(it ->> 'price') < 0 or public.invoiceit_num(it ->> 'qty') < 0 then
      raise exception 'Item prices and quantities cannot be negative.' using errcode = 'check_violation';
    end if;
  end loop;
  for it in select * from jsonb_array_elements(coalesce(d -> 'payments', '[]'::jsonb)) loop
    if public.invoiceit_num(it ->> 'amount') < 0 then
      raise exception 'Payment amounts cannot be negative.' using errcode = 'check_violation';
    end if;
  end loop;
  if public.invoiceit_num(d ->> 'discount') < 0 or public.invoiceit_num(d ->> 'delivery') < 0 then
    raise exception 'Discount and delivery cannot be negative.' using errcode = 'check_violation';
  end if;
  if public.invoiceit_num(d ->> 'tax') < 0 or public.invoiceit_num(d ->> 'tax') > 100 then
    raise exception 'VAT must be between 0 and 100 percent.' using errcode = 'check_violation';
  end if;
  c := public.invoiceit_calc(d);
  -- One cent of slack: the app rounds with floats, the database with exact decimals.
  if (c ->> 'change')::numeric > 0.01 then
    raise exception 'Payments (%) are more than the invoice total (%). Overpayment is not allowed.', c ->> 'paid', c ->> 'total'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger invoiceit_invoices_validate
  before insert or update of data on public.invoiceit_invoices
  for each row execute function public.invoiceit_invoices_validate();

-- ---------- 2. audit trail ----------
create table public.invoiceit_invoice_audit (
  id bigint generated always as identity primary key,
  invoice_id text not null,
  invoice_no text,
  business_id uuid not null references public.invoiceit_businesses(id) on delete cascade,
  action text not null check (action in ('update', 'delete')),
  changed_by uuid,                -- the signed-in user, null for API or server changes
  actor text not null,            -- the user's email, or 'api:<key prefix>', or 'server'
  old_data jsonb not null,
  created_at timestamptz not null default now()
);
create index invoiceit_invoice_audit_invoice_idx on public.invoiceit_invoice_audit (business_id, invoice_id, created_at desc);

create or replace function public.invoiceit_invoices_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_actor text;
begin
  if tg_op = 'UPDATE' and old.data is not distinct from new.data then return new; end if;
  v_actor := coalesce(nullif(current_setting('invoiceit.actor', true), ''),
    (select nullif(email, '') from public.invoiceit_members where user_id = auth.uid()),
    auth.uid()::text, 'server');
  insert into public.invoiceit_invoice_audit (invoice_id, invoice_no, business_id, action, changed_by, actor, old_data)
    values (old.id, old.no, old.business_id, lower(tg_op), auth.uid(), v_actor, old.data);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger invoiceit_invoices_audit
  after update or delete on public.invoiceit_invoices
  for each row execute function public.invoiceit_invoices_audit();

alter table public.invoiceit_invoice_audit enable row level security;
revoke all on public.invoiceit_invoice_audit from anon, authenticated;
grant select on public.invoiceit_invoice_audit to authenticated;
create policy "audit: owner reads own business" on public.invoiceit_invoice_audit for select to authenticated
  using (business_id = (select public.invoiceit_my_business()) and (select public.invoiceit_is_owner()));
revoke all on function public.invoiceit_invoices_audit(), public.invoiceit_invoices_validate() from public, anon, authenticated;

-- ---------- 3. server-side pricing ----------
alter table public.invoiceit_businesses add column billing_country text check (billing_country ~ '^[A-Z]{2}$');

-- The price a business pays. 'ng' only gets the Naira price if the payer's country (recorded by the billing
-- function at checkout) is Nigeria or unknown; any other country pays the international price.
create or replace function public.invoiceit_business_plan(p_business_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.invoiceit_plan(case when region = 'ng' and billing_country is not null and billing_country <> 'NG' then 'intl' else region end)
  from public.invoiceit_businesses where id = p_business_id;
$$;

-- Billing function only: the payer's country at checkout (ISO 3166 alpha-2), taken from the request, not the browser.
create or replace function public.invoiceit_set_billing_country(p_business_id uuid, p_country text)
returns void language sql security definer set search_path = '' as $$
  update public.invoiceit_businesses set billing_country = upper(p_country)
    where id = p_business_id and upper(coalesce(p_country, '')) ~ '^[A-Z]{2}$' and upper(p_country) <> 'XX';
$$;

-- Same as the regions migration, but the price shown is the server's price for this business.
create or replace function public.invoiceit_me()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'role', m.role,
    'business', jsonb_build_object('id', b.id, 'name', b.name, 'addr', b.addr, 'phone', b.phone,
      'region', b.region, 'currency', public.invoiceit_region_currency(b.region)),
    'billing', jsonb_build_object(
      'free_forever', b.free_forever,
      'trial_ends_at', b.trial_ends_at,
      'paid_until', b.paid_until,
      'access_until', case when b.free_forever then null else greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) end,
      'delete_at', case when b.free_forever then null else greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) + interval '14 days' end,
      'active', b.free_forever or greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) > now(),
      'on_trial', not b.free_forever and b.paid_until is null and b.trial_ends_at > now(),
      'price', public.invoiceit_business_plan(b.id)))
  from public.invoiceit_members m join public.invoiceit_businesses b on b.id = m.business_id
  where m.user_id = auth.uid();
$$;

revoke all on function public.invoiceit_set_billing_country(uuid, text) from public, anon, authenticated;
grant execute on function public.invoiceit_set_billing_country(uuid, text) to service_role;
-- billing_country is not in the owner's update grant (name, addr, phone), so owners can't set it.
