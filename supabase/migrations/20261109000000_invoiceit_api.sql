-- Invoiceit public API, phase 1: database.
--   * API keys (only a SHA-256 hash of each key is stored; the full key is shown once, at creation)
--   * API plans with a monthly token allowance (1 token = 1 invoice created through the API)
--   * per-business token counters, a usage log, and idempotency records
--   * owner-only RPCs for the dashboard; service-role-only RPCs for the invoiceit-api edge function
-- No cron job: a business's month rolls over by itself the next time its allowance is read or charged
-- (api_quota_resets_at in the past means a fresh month), and old idempotency rows are cleared as new ones are written.
-- Nothing here changes an existing column. invoiceit_record_payment is re-created with the same
-- signature and behaviour, plus one line that resets the API allowance when a payment is recorded.

create extension if not exists pgcrypto with schema extensions;

-- ---------- plans (editable rows, not hardcoded) ----------
create table public.invoiceit_api_plans (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null,
  monthly_tokens integer not null check (monthly_tokens >= 0),
  price_ngn_kobo integer not null default 0 check (price_ngn_kobo >= 0),
  price_usd_cents integer not null default 0 check (price_usd_cents >= 0),
  created_at timestamptz not null default now()
);
-- PLACEHOLDER prices: change them with an UPDATE before selling the paid plans.
insert into public.invoiceit_api_plans (code, name, monthly_tokens, price_ngn_kobo, price_usd_cents) values
  ('free',     'Free',     20,         0,    0),
  ('starter',  'Starter',  200,   500000,  500),   -- ₦5,000 / $5
  ('business', 'Business', 1000, 1500000, 1500);   -- ₦15,000 / $15

-- ---------- per-business allowance ----------
alter table public.invoiceit_businesses
  add column api_plan text not null default 'free' references public.invoiceit_api_plans(code),
  add column api_tokens_used integer not null default 0 check (api_tokens_used >= 0),
  add column api_quota_resets_at timestamptz not null default now() + interval '1 month';
-- Owners can still only update name, addr and phone (granted in the trial-billing migration), so
-- these three columns are server-only.

-- ---------- keys ----------
-- Full key: 'inv_live_' + 32 hex characters (128 random bits).
-- key_prefix is the first 8 characters of the random part, shown as "inv_live_<prefix>…".
-- (The first 8 characters of the whole key would be "inv_live" for every key, which can't tell keys apart.)
create table public.invoiceit_api_keys (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.invoiceit_businesses(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  key_prefix text not null check (key_prefix ~ '^[0-9a-f]{8}$'),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index invoiceit_api_keys_business_idx on public.invoiceit_api_keys (business_id);

-- ---------- usage log ----------
create table public.invoiceit_api_usage (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.invoiceit_businesses(id) on delete cascade,
  api_key_id uuid references public.invoiceit_api_keys(id) on delete set null,
  endpoint text not null,
  status_code integer not null,
  invoice_id text,
  tokens_charged integer not null default 0 check (tokens_charged >= 0),
  created_at timestamptz not null default now()
);
create index invoiceit_api_usage_business_created_idx on public.invoiceit_api_usage (business_id, created_at desc);

-- ---------- idempotency ----------
-- One row per (business, Idempotency-Key). request_hash lets the API refuse a reused key with a different body.
-- A business's rows older than 24 hours are removed whenever it starts a new idempotent request.
create table public.invoiceit_api_idempotency_keys (
  business_id uuid not null references public.invoiceit_businesses(id) on delete cascade,
  key text not null check (char_length(key) between 1 and 255),
  request_hash text not null,
  invoice_id text,
  status_code integer,
  response jsonb,
  created_at timestamptz not null default now()
);
create unique index invoiceit_api_idempotency_business_key_idx on public.invoiceit_api_idempotency_keys (business_id, key);
create index invoiceit_api_idempotency_created_idx on public.invoiceit_api_idempotency_keys (created_at);

-- ---------- tokens (service role only) ----------

-- Takes one token, atomically. A single UPDATE checks access, the allowance and the reset date together,
-- so concurrent requests can't overspend: each waits for the row lock and re-checks the WHERE clause.
-- A business whose reset date has passed starts a fresh month here (used = 1 after this charge).
-- Returns { ok, reason?, plan, limit, used, remaining, resets_at }. reason: not_found | no_access | no_tokens
create or replace function public.invoiceit_consume_token(p_business_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_used integer; v_limit integer; v_plan text; v_resets timestamptz; v_active boolean;
begin
  update public.invoiceit_businesses b
    set api_tokens_used = case when b.api_quota_resets_at <= now() then 1 else b.api_tokens_used + 1 end,
        api_quota_resets_at = case when b.api_quota_resets_at <= now() then now() + interval '1 month' else b.api_quota_resets_at end
    from public.invoiceit_api_plans p
    where b.id = p_business_id
      and p.code = b.api_plan
      and (b.free_forever or greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) > now())
      and p.monthly_tokens > 0
      and (b.api_quota_resets_at <= now() or b.api_tokens_used < p.monthly_tokens)
    returning b.api_tokens_used, p.monthly_tokens, b.api_plan, b.api_quota_resets_at
    into v_used, v_limit, v_plan, v_resets;

  if found then
    return jsonb_build_object('ok', true, 'plan', v_plan, 'limit', v_limit, 'used', v_used,
      'remaining', greatest(v_limit - v_used, 0), 'resets_at', v_resets);
  end if;

  -- Not charged: say why (read only, for the error message).
  select b.api_plan, p.monthly_tokens, b.api_tokens_used, b.api_quota_resets_at,
         b.free_forever or greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) > now()
    into v_plan, v_limit, v_used, v_resets, v_active
    from public.invoiceit_businesses b join public.invoiceit_api_plans p on p.code = b.api_plan
    where b.id = p_business_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', false, 'reason', case when not v_active then 'no_access' else 'no_tokens' end,
    'plan', v_plan, 'limit', v_limit, 'used', v_used, 'remaining', greatest(v_limit - v_used, 0), 'resets_at', v_resets);
end;
$$;

-- Gives a token back when the invoice insert fails after the token was taken.
create or replace function public.invoiceit_refund_token(p_business_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.invoiceit_businesses set api_tokens_used = greatest(api_tokens_used - 1, 0) where id = p_business_id;
$$;

-- Starts a fresh month for one business: used = 0, next reset in one month.
create or replace function public.invoiceit_reset_api_quota(p_business_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.invoiceit_businesses
    set api_tokens_used = 0, api_quota_resets_at = now() + interval '1 month'
    where id = p_business_id;
$$;

-- Current allowance without charging, for GET /v1/usage and the dashboard. A month that is up reads as fresh.
create or replace function public.invoiceit_api_quota(p_business_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'plan', b.api_plan, 'plan_name', p.name, 'limit', p.monthly_tokens,
    'used', case when b.api_quota_resets_at <= now() then 0 else b.api_tokens_used end,
    'remaining', greatest(p.monthly_tokens - case when b.api_quota_resets_at <= now() then 0 else b.api_tokens_used end, 0),
    'resets_at', case when b.api_quota_resets_at <= now() then now() + interval '1 month' else b.api_quota_resets_at end,
    'active', b.free_forever or greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) > now())
  from public.invoiceit_businesses b join public.invoiceit_api_plans p on p.code = b.api_plan
  where b.id = p_business_id;
$$;

-- Same as the regions migration, plus: a recorded payment (a renewal) resets the API allowance.
create or replace function public.invoiceit_record_payment(p_reference text, p_business_id uuid, p_amount integer, p_currency text, p_paid_at timestamptz, p_raw jsonb)
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
  perform public.invoiceit_reset_api_quota(p_business_id);
  return v_until;
end;
$$;

-- ---------- owner RPCs for the dashboard ----------

-- The caller's business if they are its owner (whether or not it currently has access).
create or replace function public.invoiceit_owner_business()
returns uuid language sql stable security definer set search_path = '' as $$
  select business_id from public.invoiceit_members where user_id = auth.uid() and role = 'owner';
$$;

-- Creates a key and returns it in full. This is the only time the full key exists outside the caller.
create or replace function public.invoiceit_create_api_key(p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_bid uuid := public.invoiceit_owner_business();
  v_random text; v_key text; v_row public.invoiceit_api_keys%rowtype;
begin
  if v_bid is null then raise exception 'Only the business owner can create API keys.'; end if;
  if public.invoiceit_my_business() is null then raise exception 'Your subscription has ended. Pay to keep using Invoiceit and its API.'; end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'Give the key a name, e.g. "Online store".'; end if;
  if (select count(*) from public.invoiceit_api_keys where business_id = v_bid and revoked_at is null) >= 10 then
    raise exception 'You already have 10 active keys. Revoke one first.';
  end if;
  v_random := encode(extensions.gen_random_bytes(16), 'hex');
  v_key := 'inv_live_' || v_random;
  insert into public.invoiceit_api_keys (business_id, name, key_prefix, key_hash, created_by)
    values (v_bid, left(btrim(p_name), 60), left(v_random, 8), encode(extensions.digest(v_key, 'sha256'), 'hex'), auth.uid())
    returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'key', v_key,
    'key_prefix', v_row.key_prefix, 'created_at', v_row.created_at);
end;
$$;

-- Keys for the caller's business, newest first. Never includes the hash.
create or replace function public.invoiceit_list_api_keys()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_bid uuid := public.invoiceit_owner_business();
begin
  if v_bid is null then raise exception 'Only the business owner can see API keys.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'key_prefix', key_prefix, 'created_at', created_at,
      'last_used_at', last_used_at, 'revoked_at', revoked_at) order by created_at desc)
    from public.invoiceit_api_keys where business_id = v_bid), '[]'::jsonb);
end;
$$;

-- Revokes one key of the caller's business. Revoking twice is harmless.
create or replace function public.invoiceit_revoke_api_key(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_bid uuid := public.invoiceit_owner_business(); v_row public.invoiceit_api_keys%rowtype;
begin
  if v_bid is null then raise exception 'Only the business owner can revoke API keys.'; end if;
  update public.invoiceit_api_keys set revoked_at = coalesce(revoked_at, now())
    where id = p_id and business_id = v_bid
    returning * into v_row;
  if not found then raise exception 'Key not found.'; end if;
  return jsonb_build_object('id', v_row.id, 'revoked_at', v_row.revoked_at);
end;
$$;

-- ---------- access ----------
alter table public.invoiceit_api_plans enable row level security;
alter table public.invoiceit_api_keys enable row level security;
alter table public.invoiceit_api_usage enable row level security;
alter table public.invoiceit_api_idempotency_keys enable row level security;
-- No policies: anon and authenticated reach these tables only through the RPCs above.
revoke all on public.invoiceit_api_plans, public.invoiceit_api_keys, public.invoiceit_api_usage,
  public.invoiceit_api_idempotency_keys from anon, authenticated;

revoke all on function public.invoiceit_consume_token(uuid), public.invoiceit_refund_token(uuid),
  public.invoiceit_reset_api_quota(uuid), public.invoiceit_api_quota(uuid),
  public.invoiceit_owner_business(), public.invoiceit_create_api_key(text), public.invoiceit_list_api_keys(),
  public.invoiceit_revoke_api_key(uuid) from public, anon, authenticated;
grant execute on function public.invoiceit_consume_token(uuid), public.invoiceit_refund_token(uuid),
  public.invoiceit_reset_api_quota(uuid), public.invoiceit_api_quota(uuid) to service_role;
grant execute on function public.invoiceit_owner_business(), public.invoiceit_create_api_key(text),
  public.invoiceit_list_api_keys(), public.invoiceit_revoke_api_key(uuid) to authenticated;
-- create or replace keeps invoiceit_record_payment's existing grants (service_role only).
