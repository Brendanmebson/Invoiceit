-- Invoice branding: a logo, a line under the business name (e.g. "Dealers in all kinds of phones"),
-- and the font and style of the business name at the top of the invoice. Owners set these on the Business page.
-- Each invoice keeps a copy (in data.store) of how the business looked when it was written, like name/addr/phone.

alter table public.invoiceit_businesses
  add column tagline text not null default '' check (char_length(tagline) <= 200),
  add column logo_url text check (logo_url is null or (logo_url ~ '^https://' and char_length(logo_url) <= 500)),
  add column title_style jsonb not null default '{}'::jsonb
    check (jsonb_typeof(title_style) = 'object' and pg_column_size(title_style) <= 1000);

-- Owners may edit these too (billing columns stay server-only).
grant update (name, addr, phone, tagline, logo_url, title_style) on public.invoiceit_businesses to authenticated;

-- Same as before, plus the branding fields.
create or replace function public.invoiceit_me()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'role', m.role,
    'business', jsonb_build_object('id', b.id, 'name', b.name, 'addr', b.addr, 'phone', b.phone,
      'tagline', b.tagline, 'logo_url', b.logo_url, 'title_style', b.title_style,
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

-- Same as before, plus the branding fields so API invoices print like the app's.
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
    'business', jsonb_build_object('id', b.id, 'name', b.name, 'addr', b.addr, 'phone', b.phone, 'region', b.region,
      'tagline', b.tagline, 'logo_url', b.logo_url, 'title_style', b.title_style),
    'active', b.free_forever or greatest(b.trial_ends_at, coalesce(b.paid_until, b.trial_ends_at)) > now(),
    'quota', public.invoiceit_api_quota(b.id));
end;
$$;

-- ---------- logos ----------
-- Public bucket: logos print on invoices that anyone with the link (or a printout) sees anyway.
-- Files live under <business id>/; only that business's owners can add or remove them.
-- Each upload gets a new file name, so invoices made with an older logo keep showing it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoiceit-logos', 'invoiceit-logos', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "invoiceit logos: owner uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'invoiceit-logos'
    and (storage.foldername(name))[1] = (select public.invoiceit_my_business())::text
    and (select public.invoiceit_is_owner()));
create policy "invoiceit logos: owner deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'invoiceit-logos'
    and (storage.foldername(name))[1] = (select public.invoiceit_my_business())::text
    and (select public.invoiceit_is_owner()));
