-- Invoiceit public API, phases 5 and 6: paid API plans and the owner's API dashboard.
--   * A paid API plan (starter, business) lasts 30 days from payment and is renewed by paying again.
--     When it lapses the business falls back to the free plan's allowance; nothing is deleted.
--   * Paying for an API plan sets the plan, starts a fresh month of tokens and is recorded in invoiceit_payments
--     (kind = 'api_plan', api_plan = the plan code).
--   * The ₦20,000 / $15 subscription is unchanged.

alter table public.invoiceit_businesses add column api_plan_until timestamptz;  -- null = no end (free plan, or set by hand)
alter table public.invoiceit_payments
  add column kind text not null default 'subscription' check (kind in ('subscription', 'api_plan')),
  add column api_plan text references public.invoiceit_api_plans(code);

-- The plan whose allowance applies right now.
create or replace function public.invoiceit_effective_api_plan(p_plan text, p_until timestamptz)
returns text language sql stable set search_path = '' as $$
  select case when p_plan <> 'free' and p_until is not null and p_until <= now() then 'free' else p_plan end;
$$;

-- Same as phase 1, but a lapsed paid plan counts as free.
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
      and p.code = public.invoiceit_effective_api_plan(b.api_plan, b.api_plan_until)
      and (b.free_forever or greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) > now())
      and p.monthly_tokens > 0
      and (b.api_quota_resets_at <= now() or b.api_tokens_used < p.monthly_tokens)
    returning b.api_tokens_used, p.monthly_tokens, p.code, b.api_quota_resets_at
    into v_used, v_limit, v_plan, v_resets;

  if found then
    return jsonb_build_object('ok', true, 'plan', v_plan, 'limit', v_limit, 'used', v_used,
      'remaining', greatest(v_limit - v_used, 0), 'resets_at', v_resets);
  end if;

  select p.code, p.monthly_tokens, b.api_tokens_used, b.api_quota_resets_at,
         b.free_forever or greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) > now()
    into v_plan, v_limit, v_used, v_resets, v_active
    from public.invoiceit_businesses b
    join public.invoiceit_api_plans p on p.code = public.invoiceit_effective_api_plan(b.api_plan, b.api_plan_until)
    where b.id = p_business_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', false, 'reason', case when not v_active then 'no_access' else 'no_tokens' end,
    'plan', v_plan, 'limit', v_limit, 'used', v_used, 'remaining', greatest(v_limit - v_used, 0), 'resets_at', v_resets);
end;
$$;

create or replace function public.invoiceit_api_quota(p_business_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'plan', p.code, 'plan_name', p.name, 'limit', p.monthly_tokens,
    'used', case when b.api_quota_resets_at <= now() then 0 else b.api_tokens_used end,
    'remaining', greatest(p.monthly_tokens - case when b.api_quota_resets_at <= now() then 0 else b.api_tokens_used end, 0),
    'resets_at', case when b.api_quota_resets_at <= now() then now() + interval '1 month' else b.api_quota_resets_at end,
    'plan_until', case when p.code = 'free' then null else b.api_plan_until end,
    'active', b.free_forever or greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) > now())
  from public.invoiceit_businesses b
  join public.invoiceit_api_plans p on p.code = public.invoiceit_effective_api_plan(b.api_plan, b.api_plan_until)
  where b.id = p_business_id;
$$;

-- Price of an API plan for a business, in the currency it pays its subscription in (NGN or USD).
create or replace function public.invoiceit_api_plan_price(p_business_id uuid, p_plan text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('plan', p.code, 'name', p.name, 'monthly_tokens', p.monthly_tokens,
    'currency', public.invoiceit_business_plan(p_business_id) ->> 'currency',
    'amount', case when public.invoiceit_business_plan(p_business_id) ->> 'currency' = 'NGN' then p.price_ngn_kobo else p.price_usd_cents end)
  from public.invoiceit_api_plans p where p.code = p_plan;
$$;

-- Called only by the billing edge function after Paystack confirms an API plan payment. Idempotent per reference.
create or replace function public.invoiceit_record_api_plan_payment(p_reference text, p_business_id uuid, p_plan text,
  p_amount integer, p_currency text, p_paid_at timestamptz, p_raw jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_price jsonb; v_until timestamptz;
begin
  v_price := public.invoiceit_api_plan_price(p_business_id, p_plan);
  if v_price is null or (v_price ->> 'amount')::integer <= 0 then raise exception 'Unknown or free API plan: %', p_plan; end if;
  if p_currency is distinct from v_price ->> 'currency' then raise exception 'Payment currency does not match this business''s price.'; end if;
  if p_amount <> (v_price ->> 'amount')::integer then raise exception 'Amount does not match the % plan price.', p_plan; end if;

  insert into public.invoiceit_payments (reference, business_id, amount_kobo, currency, status, paid_at, months, raw, kind, api_plan)
    values (p_reference, p_business_id, p_amount, p_currency, 'success', p_paid_at, 1, p_raw, 'api_plan', p_plan)
    on conflict (reference) do nothing;
  if not found then
    select api_plan_until into v_until from public.invoiceit_businesses where id = p_business_id;
    return jsonb_build_object('plan', p_plan, 'plan_until', v_until, 'already_recorded', true);
  end if;

  -- Renewing the same plan adds 30 days to what's left; switching plans starts 30 days from now.
  update public.invoiceit_businesses
    set api_plan_until = case when api_plan = p_plan and api_plan_until > now() then api_plan_until else now() end + interval '30 days',
        api_plan = p_plan,
        api_tokens_used = 0,
        api_quota_resets_at = now() + interval '1 month'
    where id = p_business_id
    returning api_plan_until into v_until;
  return jsonb_build_object('plan', p_plan, 'plan_until', v_until);
end;
$$;

-- Owner's API page: allowance, plans with prices, and the last 25 calls.
create or replace function public.invoiceit_api_dashboard()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_bid uuid := public.invoiceit_owner_business(); v_cur text;
begin
  if v_bid is null then raise exception 'Only the business owner can see the API page.'; end if;
  v_cur := public.invoiceit_business_plan(v_bid) ->> 'currency';
  return jsonb_build_object(
    'quota', public.invoiceit_api_quota(v_bid),
    'plans', (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'monthly_tokens', monthly_tokens,
                'currency', v_cur, 'amount', case when v_cur = 'NGN' then price_ngn_kobo else price_usd_cents end) order by monthly_tokens)
              from public.invoiceit_api_plans),
    'usage', coalesce((select jsonb_agg(u order by u.created_at desc) from (
                select x.created_at, x.endpoint, x.status_code, x.tokens_charged, x.invoice_id, k.key_prefix, k.name as key_name
                from public.invoiceit_api_usage x left join public.invoiceit_api_keys k on k.id = x.api_key_id
                where x.business_id = v_bid order by x.created_at desc limit 25) u), '[]'::jsonb),
    'calls_30d', (select count(*) from public.invoiceit_api_usage where business_id = v_bid and created_at > now() - interval '30 days'));
end;
$$;

revoke all on function public.invoiceit_effective_api_plan(text, timestamptz), public.invoiceit_api_plan_price(uuid, text),
  public.invoiceit_record_api_plan_payment(text, uuid, text, integer, text, timestamptz, jsonb),
  public.invoiceit_api_dashboard() from public, anon, authenticated;
grant execute on function public.invoiceit_effective_api_plan(text, timestamptz), public.invoiceit_api_plan_price(uuid, text),
  public.invoiceit_record_api_plan_payment(text, uuid, text, integer, text, timestamptz, jsonb) to service_role;
grant execute on function public.invoiceit_api_dashboard() to authenticated;
