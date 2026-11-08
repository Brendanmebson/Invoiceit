-- Invoiceit: each business has a region, which sets
--   * its default invoice currency (ng ₦, us $, uk £, eu €, intl $), and
--   * what it pays: Nigeria ₦20,000 a month, everywhere else $15 a month (Paystack only charges NGN or USD).
-- The region is chosen once at sign-up (from the device time zone) and only the server can change it,
-- so an owner can't switch to a cheaper price.
-- Deploy the invoiceit-billing edge function together with this: invoiceit_record_payment takes a currency now.

alter table public.invoiceit_businesses
  add column region text not null default 'ng' check (region in ('ng', 'us', 'uk', 'eu', 'intl'));
-- Existing businesses are Nigerian, so the default 'ng' is right for them.

-- Payments now record their currency; amount_kobo holds the smallest unit of that currency (kobo or cents).
alter table public.invoiceit_payments add column currency text not null default 'NGN';

-- The one place prices live. amount is per month in the smallest unit.
create or replace function public.invoiceit_plan(p_region text)
returns jsonb language sql immutable set search_path = '' as $$
  select case when p_region = 'ng'
    then jsonb_build_object('currency', 'NGN', 'amount', 2000000)  -- ₦20,000
    else jsonb_build_object('currency', 'USD', 'amount', 1500)     -- $15
  end;
$$;

-- Default invoice currency for a region.
create or replace function public.invoiceit_region_currency(p_region text)
returns text language sql immutable set search_path = '' as $$
  select case p_region when 'ng' then 'NGN' when 'uk' then 'GBP' when 'eu' then 'EUR' else 'USD' end;
$$;

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
      'price', public.invoiceit_plan(b.region)))
  from public.invoiceit_members m join public.invoiceit_businesses b on b.id = m.business_id
  where m.user_id = auth.uid();
$$;

-- Same as before, plus the region of a new business. Staff joining with a code get the business's region.
drop function public.invoiceit_setup(text, text);
create function public.invoiceit_setup(p_business_name text default null, p_join_code text default null, p_region text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_code public.invoiceit_join_codes%rowtype;
  v_bid uuid;
  v_had_trial boolean;
  v_region text := case when p_region in ('ng', 'us', 'uk', 'eu', 'intl') then p_region else 'ng' end;
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
  insert into public.invoiceit_businesses (name, created_by, trial_ends_at, region)
    values (btrim(p_business_name), v_uid, case when v_had_trial then now() else now() + interval '14 days' end, v_region)
    returning id into v_bid;
  insert into public.invoiceit_members (business_id, user_id, role, email) values (v_bid, v_uid, 'owner', v_email);
  insert into public.invoiceit_trial_history (email) values (v_email) on conflict do nothing;
  return public.invoiceit_me();
end;
$$;

-- Price for a business, for the billing edge function.
create or replace function public.invoiceit_business_plan(p_business_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.invoiceit_plan(region) from public.invoiceit_businesses where id = p_business_id;
$$;

-- Months are worked out from the business's own price, and the currency must match it.
drop function public.invoiceit_record_payment(text, uuid, integer, timestamptz, jsonb);
create function public.invoiceit_record_payment(p_reference text, p_business_id uuid, p_amount integer, p_currency text, p_paid_at timestamptz, p_raw jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_plan jsonb; v_price integer; v_months integer; v_until timestamptz;
begin
  v_plan := public.invoiceit_business_plan(p_business_id);
  if v_plan is null then raise exception 'Business not found.'; end if;
  if p_currency is distinct from v_plan ->> 'currency' then raise exception 'Payment currency does not match this business''s plan.'; end if;
  v_price := (v_plan ->> 'amount')::integer;
  if p_amount < v_price then raise exception 'Amount is less than one month.'; end if;
  v_months := p_amount / v_price;
  insert into public.invoiceit_payments (reference, business_id, amount_kobo, currency, status, paid_at, months, raw)
    values (p_reference, p_business_id, p_amount, p_currency, 'success', p_paid_at, v_months, p_raw)
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

-- Access. region is not in the owner's update grant (name, addr, phone), so owners can't change it.
revoke all on function public.invoiceit_plan(text), public.invoiceit_region_currency(text) from public, anon;
grant execute on function public.invoiceit_plan(text), public.invoiceit_region_currency(text) to authenticated, service_role;
revoke all on function public.invoiceit_setup(text, text, text) from public, anon;
grant execute on function public.invoiceit_setup(text, text, text) to authenticated;
revoke all on function public.invoiceit_business_plan(uuid),
  public.invoiceit_record_payment(text, uuid, integer, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.invoiceit_business_plan(uuid),
  public.invoiceit_record_payment(text, uuid, integer, text, timestamptz, jsonb) to service_role;
