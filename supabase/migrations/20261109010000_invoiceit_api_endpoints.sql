-- Invoiceit public API, phase 3: what the invoiceit-api edge function calls (service role only).
--   invoiceit_num / invoiceit_calc   the web app's calc() in SQL (status filter, payment checks, validation)
--   invoiceit_api_begin              key lookup + revoked check + last_used_at + rate limit + allowance, one round trip
--   invoiceit_api_create_invoice     idempotency + token + insert in ONE transaction (a failed insert takes nothing)
--   invoiceit_api_add_payment        locks the invoice row, re-reads the balance, refuses overpayment
--   invoiceit_api_list_invoices      cursor pagination with status/date filters
-- Also the (business_id, created_at) index on invoices.

-- ---------- the web app's maths, in SQL ----------

-- parseFloat(String(v).replace(/,/g, '')), 0 when it isn't a number. Same as num() in js/store.js.
create or replace function public.invoiceit_num(v text)
returns numeric language sql immutable set search_path = '' as $$
  select coalesce(
    (substring(replace(coalesce(v, ''), ',', '') from '^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)'))::numeric, 0);
$$;

-- Same as calc() in js/store.js (exact decimals here, floats there; they agree to the cent).
create or replace function public.invoiceit_calc(d jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_sub numeric := 0; v_paid numeric := 0; v_disc numeric; v_del numeric; v_tax numeric; v_total numeric;
        v_bal numeric; v_change numeric; it jsonb;
begin
  for it in select * from jsonb_array_elements(case when jsonb_typeof(d -> 'items') = 'array' then d -> 'items' else '[]'::jsonb end) loop
    v_sub := v_sub + (case when btrim(coalesce(it ->> 'qty', '')) = '' then 1 else public.invoiceit_num(it ->> 'qty') end)
                     * public.invoiceit_num(it ->> 'price');
  end loop;
  select coalesce(sum(public.invoiceit_num(p ->> 'amount')), 0) into v_paid
    from jsonb_array_elements(case when jsonb_typeof(d -> 'payments') = 'array' then d -> 'payments' else '[]'::jsonb end) p;
  v_disc := least(public.invoiceit_num(d ->> 'discount'), v_sub);
  v_del := public.invoiceit_num(d ->> 'delivery');
  v_tax := (v_sub - v_disc) * public.invoiceit_num(d ->> 'tax') / 100;
  v_total := round(v_sub - v_disc + v_del + v_tax, 2);
  v_paid := round(v_paid, 2);
  v_bal := greatest(round(v_total - v_paid, 2), 0);
  v_change := greatest(round(v_paid - v_total, 2), 0);
  return jsonb_build_object('sub', v_sub, 'disc', v_disc, 'del', v_del, 'tax', v_tax, 'total', v_total,
    'paid', v_paid, 'balance', v_bal, 'change', v_change,
    'status', case when v_bal = 0 and v_total > 0 then 'PAID' when v_paid <= 0 then 'UNPAID' else 'PART-PAID' end);
end;
$$;

-- ---------- rate limit: fixed one-minute windows per key ----------
create table public.invoiceit_api_rate (
  api_key_id uuid not null references public.invoiceit_api_keys(id) on delete cascade,
  window_start timestamptz not null,
  hits integer not null default 1,
  primary key (api_key_id, window_start)
);
alter table public.invoiceit_api_rate enable row level security;
revoke all on public.invoiceit_api_rate from anon, authenticated;

-- ---------- one call at the start of every request ----------
-- p_key_hash: SHA-256 hex of the full key (the edge function hashes it; the raw key never reaches the database).
-- Returns { ok, reason?, retry_after?, key_id, key_prefix, business{...}, active, quota{...} }
--   reason: invalid_key | revoked | rate_limited
create or replace function public.invoiceit_api_begin(p_key_hash text, p_rate_limit integer default 60)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.invoiceit_api_keys%rowtype; b public.invoiceit_businesses%rowtype;
        v_win timestamptz := date_trunc('minute', now()); v_hits integer;
begin
  select * into k from public.invoiceit_api_keys where key_hash = p_key_hash;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid_key'); end if;
  if k.revoked_at is not null then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;

  insert into public.invoiceit_api_rate (api_key_id, window_start) values (k.id, v_win)
    on conflict (api_key_id, window_start) do update set hits = public.invoiceit_api_rate.hits + 1
    returning hits into v_hits;
  delete from public.invoiceit_api_rate where api_key_id = k.id and window_start < v_win - interval '2 minutes';
  if v_hits > p_rate_limit then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited', 'key_id', k.id, 'business_id', k.business_id,
      'retry_after', greatest(1, ceil(extract(epoch from (v_win + interval '1 minute' - now()))))::integer);
  end if;

  update public.invoiceit_api_keys set last_used_at = now() where id = k.id;
  select * into b from public.invoiceit_businesses where id = k.business_id;
  return jsonb_build_object('ok', true, 'key_id', k.id, 'key_prefix', k.key_prefix,
    'business', jsonb_build_object('id', b.id, 'name', b.name, 'addr', b.addr, 'phone', b.phone, 'region', b.region),
    'active', b.free_forever or greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) > now(),
    'quota', public.invoiceit_api_quota(b.id));
end;
$$;

-- ---------- create ----------
-- All in one transaction: if the insert fails, the token and the idempotency row go with it.
-- Returns { ok: true, invoice, quota } | { ok: true, replay: true, status_code, response, invoice_id }
--       | { ok: false, reason: no_access|no_tokens|not_found|idempotency_mismatch|idempotency_in_progress, quota? }
create or replace function public.invoiceit_api_create_invoice(p_business_id uuid, p_data jsonb, p_idempotency_key text,
  p_request_hash text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_idem public.invoiceit_api_idempotency_keys%rowtype; v_q jsonb; v_row public.invoiceit_invoices%rowtype;
begin
  if p_idempotency_key is not null then
    delete from public.invoiceit_api_idempotency_keys where business_id = p_business_id and created_at < now() - interval '24 hours';
    insert into public.invoiceit_api_idempotency_keys (business_id, key, request_hash)
      values (p_business_id, p_idempotency_key, p_request_hash)
      on conflict (business_id, key) do nothing;
    if not found then
      select * into v_idem from public.invoiceit_api_idempotency_keys where business_id = p_business_id and key = p_idempotency_key;
      if v_idem.request_hash <> p_request_hash then return jsonb_build_object('ok', false, 'reason', 'idempotency_mismatch'); end if;
      if v_idem.invoice_id is null then return jsonb_build_object('ok', false, 'reason', 'idempotency_in_progress'); end if;
      return jsonb_build_object('ok', true, 'replay', true, 'status_code', v_idem.status_code, 'response', v_idem.response,
        'invoice_id', v_idem.invoice_id);
    end if;
  end if;

  v_q := public.invoiceit_consume_token(p_business_id);
  if not (v_q ->> 'ok')::boolean then
    if p_idempotency_key is not null then
      delete from public.invoiceit_api_idempotency_keys where business_id = p_business_id and key = p_idempotency_key;
    end if;
    return jsonb_build_object('ok', false, 'reason', v_q ->> 'reason', 'quota', v_q);
  end if;

  perform set_config('invoiceit.actor', coalesce(p_actor, 'api'), true);
  insert into public.invoiceit_invoices (business_id, data) values (p_business_id, p_data) returning * into v_row;
  if p_idempotency_key is not null then
    update public.invoiceit_api_idempotency_keys set invoice_id = v_row.id where business_id = p_business_id and key = p_idempotency_key;
  end if;
  return jsonb_build_object('ok', true, 'quota', v_q, 'invoice', jsonb_build_object('id', v_row.id, 'no', v_row.no,
    'data', v_row.data, 'created_at', v_row.created_at, 'updated_at', v_row.updated_at));
end;
$$;

-- Saves the response sent for an idempotent create, so a retry gets the same body.
create or replace function public.invoiceit_api_save_idempotent(p_business_id uuid, p_key text, p_status integer, p_response jsonb)
returns void language sql security definer set search_path = '' as $$
  update public.invoiceit_api_idempotency_keys set status_code = p_status, response = p_response
    where business_id = p_business_id and key = p_key;
$$;

-- ---------- payments ----------
-- Locks the row, re-reads the balance from the stored invoice, refuses overpayment, appends the payment.
-- Returns { ok: true, invoice } | { ok: false, reason: not_found|fully_paid|overpayment, balance? }
create or replace function public.invoiceit_api_add_payment(p_business_id uuid, p_invoice_id text, p_payment jsonb, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.invoiceit_invoices%rowtype; v_c jsonb; v_amt numeric;
begin
  select * into v_row from public.invoiceit_invoices where id = p_invoice_id and business_id = p_business_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  v_c := public.invoiceit_calc(v_row.data);
  v_amt := public.invoiceit_num(p_payment ->> 'amount');
  if (v_c ->> 'balance')::numeric <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'fully_paid', 'balance', 0);
  end if;
  if v_amt > (v_c ->> 'balance')::numeric then
    return jsonb_build_object('ok', false, 'reason', 'overpayment', 'balance', (v_c ->> 'balance')::numeric);
  end if;
  perform set_config('invoiceit.actor', coalesce(p_actor, 'api'), true);
  update public.invoiceit_invoices
    set data = jsonb_set(data, '{payments}', coalesce(data -> 'payments', '[]'::jsonb) || jsonb_build_array(p_payment))
    where id = v_row.id
    returning * into v_row;
  return jsonb_build_object('ok', true, 'invoice', jsonb_build_object('id', v_row.id, 'no', v_row.no,
    'data', v_row.data, 'created_at', v_row.created_at, 'updated_at', v_row.updated_at));
end;
$$;

-- ---------- list ----------
-- Newest first. Cursor = the (created_at, id) of the last row of the previous page.
create or replace function public.invoiceit_api_list_invoices(p_business_id uuid, p_limit integer,
  p_after_created timestamptz default null, p_after_id text default null, p_status text default null,
  p_from timestamptz default null, p_to timestamptz default null)
returns table (id text, no text, data jsonb, created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.no, i.data, i.created_at, i.updated_at
  from public.invoiceit_invoices i
  where i.business_id = p_business_id
    and (p_after_created is null or (i.created_at, i.id) < (p_after_created, p_after_id))
    and (p_from is null or i.created_at >= p_from)
    and (p_to is null or i.created_at < p_to)
    and (p_status is null or public.invoiceit_calc(i.data) ->> 'status' = p_status)
  order by i.created_at desc, i.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

create index if not exists invoiceit_invoices_business_created_idx on public.invoiceit_invoices (business_id, created_at desc, id desc);
create index if not exists invoiceit_api_usage_key_idx on public.invoiceit_api_usage (api_key_id);

-- ---------- access: service role only (num/calc are harmless helpers, open to signed-in users too) ----------
revoke all on function public.invoiceit_api_begin(text, integer),
  public.invoiceit_api_create_invoice(uuid, jsonb, text, text, text),
  public.invoiceit_api_save_idempotent(uuid, text, integer, jsonb),
  public.invoiceit_api_add_payment(uuid, text, jsonb, text),
  public.invoiceit_api_list_invoices(uuid, integer, timestamptz, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.invoiceit_api_begin(text, integer),
  public.invoiceit_api_create_invoice(uuid, jsonb, text, text, text),
  public.invoiceit_api_save_idempotent(uuid, text, integer, jsonb),
  public.invoiceit_api_add_payment(uuid, text, jsonb, text),
  public.invoiceit_api_list_invoices(uuid, integer, timestamptz, text, text, timestamptz, timestamptz)
  to service_role;
revoke all on function public.invoiceit_num(text), public.invoiceit_calc(jsonb) from public, anon;
grant execute on function public.invoiceit_num(text), public.invoiceit_calc(jsonb) to authenticated, service_role;
