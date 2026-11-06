-- Invoiceit: 14-day free trial, ₦20,000/month via Paystack, lock-out and deletion of unpaid businesses.
--   Day 0-14  : free trial, full access.
--   After that: access only while paid_until is in the future (each payment adds 30 days).
--   14 days after access ends without payment (day 28 for a business that never paid): everything is deleted.
-- JB Enterprise is free forever.

alter table public.invoiceit_businesses
  add column trial_ends_at timestamptz,
  add column paid_until timestamptz,
  add column free_forever boolean not null default false;
update public.invoiceit_businesses set trial_ends_at = created_at + interval '14 days' where trial_ends_at is null;
alter table public.invoiceit_businesses
  alter column trial_ends_at set default now() + interval '14 days',
  alter column trial_ends_at set not null;
update public.invoiceit_businesses set free_forever = true where name = 'JB Enterprise';

-- Emails that have already had a free trial, so deleting a business and signing up again doesn't give another one.
create table public.invoiceit_trial_history (
  email text primary key,
  first_trial_at timestamptz not null default now()
);
insert into public.invoiceit_trial_history (email)
select distinct lower(email) from public.invoiceit_members where email <> '' on conflict do nothing;

-- Paystack payments, written only by the invoiceit-billing edge function (service role).
create table public.invoiceit_payments (
  reference text primary key,
  business_id uuid references public.invoiceit_businesses(id) on delete set null,
  amount_kobo integer not null,
  status text not null,
  paid_at timestamptz,
  months integer not null default 1,
  raw jsonb,
  created_at timestamptz not null default now()
);
create index invoiceit_payments_business_idx on public.invoiceit_payments (business_id);

-- When access ends (null = never).
create or replace function public.invoiceit_access_until(b public.invoiceit_businesses)
returns timestamptz language sql immutable as $$
  select case when b.free_forever then null else greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) end;
$$;

-- The caller's business, only while it has access. Every invoice/team/code policy goes through this,
-- so a business whose trial ended can no longer read or write anything.
create or replace function public.invoiceit_my_business()
returns uuid language sql stable security definer set search_path = '' as $$
  select m.business_id
  from public.invoiceit_members m join public.invoiceit_businesses b on b.id = m.business_id
  where m.user_id = auth.uid()
    and (b.free_forever or greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) > now());
$$;

-- Business + role + billing status (works even when locked, so the app can show "trial ended").
create or replace function public.invoiceit_me()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'role', m.role,
    'business', jsonb_build_object('id', b.id, 'name', b.name, 'addr', b.addr, 'phone', b.phone),
    'billing', jsonb_build_object(
      'free_forever', b.free_forever,
      'trial_ends_at', b.trial_ends_at,
      'paid_until', b.paid_until,
      'access_until', case when b.free_forever then null else greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) end,
      'delete_at', case when b.free_forever then null else greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) + interval '14 days' end,
      'active', b.free_forever or greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) > now(),
      'on_trial', not b.free_forever and b.paid_until is null and b.trial_ends_at > now(),
      'price_kobo', 2000000))
  from public.invoiceit_members m join public.invoiceit_businesses b on b.id = m.business_id
  where m.user_id = auth.uid();
$$;

-- Same as before, plus: no second free trial for an email that already had one.
create or replace function public.invoiceit_setup(p_business_name text default null, p_join_code text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_code public.invoiceit_join_codes%rowtype;
  v_bid uuid;
  v_had_trial boolean;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from public.invoiceit_members where user_id = v_uid) then
    return public.invoiceit_me();
  end if;

  if nullif(btrim(coalesce(p_join_code, '')), '') is not null then
    select * into v_code from public.invoiceit_join_codes
      where code = upper(btrim(p_join_code)) and expires_at > now();
    if not found then raise exception 'That join code is wrong or has expired. Ask the owner for a new one.'; end if;
    insert into public.invoiceit_members (business_id, user_id, role, email) values (v_code.business_id, v_uid, v_code.role, v_email);
    delete from public.invoiceit_join_codes where code = v_code.code;
    return public.invoiceit_me();
  end if;

  if nullif(btrim(coalesce(p_business_name, '')), '') is null then
    raise exception 'Enter your business name, or a join code from your business owner.';
  end if;
  v_had_trial := exists (select 1 from public.invoiceit_trial_history where email = v_email);
  insert into public.invoiceit_businesses (name, created_by, trial_ends_at)
    values (btrim(p_business_name), v_uid, case when v_had_trial then now() else now() + interval '14 days' end)
    returning id into v_bid;
  insert into public.invoiceit_members (business_id, user_id, role, email) values (v_bid, v_uid, 'owner', v_email);
  insert into public.invoiceit_trial_history (email) values (v_email) on conflict do nothing;
  return public.invoiceit_me();
end;
$$;

-- Clean-up: delete businesses (cascades to invoices, team, codes) 14 days after access ended unpaid.
-- No cron job: the app calls this on every sign-in, so it runs whenever anyone uses Invoiceit.
create or replace function public.invoiceit_purge_expired()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.invoiceit_businesses b
  where not b.free_forever
    and greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) + interval '14 days' < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Called only by the billing edge function after Paystack confirms a payment. Idempotent per reference.
create or replace function public.invoiceit_record_payment(p_reference text, p_business_id uuid, p_amount_kobo integer, p_paid_at timestamptz, p_raw jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_months integer; v_until timestamptz;
begin
  v_months := greatest(1, p_amount_kobo / 2000000);
  insert into public.invoiceit_payments (reference, business_id, amount_kobo, status, paid_at, months, raw)
    values (p_reference, p_business_id, p_amount_kobo, 'success', p_paid_at, v_months, p_raw)
    on conflict (reference) do nothing;
  if not found then
    select paid_until into v_until from public.invoiceit_businesses where id = p_business_id;
    return v_until; -- already counted
  end if;
  update public.invoiceit_businesses
    set paid_until = greatest(now(), trial_ends_at, coalesce(paid_until, now())) + make_interval(days => 30 * v_months)
    where id = p_business_id
    returning paid_until into v_until;
  return v_until;
end;
$$;

-- Access: new tables are server-only.
alter table public.invoiceit_trial_history enable row level security;
alter table public.invoiceit_payments enable row level security;
revoke all on public.invoiceit_trial_history, public.invoiceit_payments from anon, authenticated;

revoke all on function public.invoiceit_access_until(public.invoiceit_businesses), public.invoiceit_purge_expired(),
  public.invoiceit_record_payment(text, uuid, integer, timestamptz, jsonb) from public, anon, authenticated;
-- Safe for any signed-in user: it only ever removes businesses that are already past their deletion date.
grant execute on function public.invoiceit_purge_expired() to authenticated;
grant execute on function public.invoiceit_record_payment(text, uuid, integer, timestamptz, jsonb) to service_role;
revoke all on function public.invoiceit_my_business(), public.invoiceit_me(), public.invoiceit_setup(text, text) from public, anon;
grant execute on function public.invoiceit_my_business(), public.invoiceit_me(), public.invoiceit_setup(text, text) to authenticated;

-- Owners may edit details only; billing columns are set by the server.
revoke update on public.invoiceit_businesses from authenticated;
grant update (name, addr, phone) on public.invoiceit_businesses to authenticated;

