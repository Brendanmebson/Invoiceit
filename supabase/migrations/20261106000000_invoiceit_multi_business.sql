-- Invoiceit: many businesses, each sees only its own invoices.
-- Everything is prefixed invoiceit_ because this Supabase project is shared with other apps.
-- The old jb_* tables are left untouched (JB Enterprise's data is copied, not moved).

create table public.invoiceit_businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  addr text not null default '',
  phone text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index invoiceit_businesses_created_by_idx on public.invoiceit_businesses (created_by);

-- One business per user keeps "sign in and see your business" simple.
create table public.invoiceit_members (
  business_id uuid not null references public.invoiceit_businesses(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner', 'staff')),
  email text not null default '',
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

-- Join codes an owner gives to staff. A code is needed because emails are not confirmed.
create table public.invoiceit_join_codes (
  code text primary key,
  business_id uuid not null references public.invoiceit_businesses(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);
create index invoiceit_join_codes_business_idx on public.invoiceit_join_codes (business_id);

create table public.invoiceit_invoices (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references public.invoiceit_businesses(id) on delete cascade,
  no text not null,
  data jsonb not null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, no)
);
create index invoiceit_invoices_created_by_idx on public.invoiceit_invoices (created_by);

-- ---------- helpers ----------
create or replace function public.invoiceit_my_business()
returns uuid language sql stable security definer set search_path = '' as $$
  select business_id from public.invoiceit_members where user_id = auth.uid();
$$;
create or replace function public.invoiceit_is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invoiceit_members where user_id = auth.uid() and role = 'owner');
$$;

-- Who am I and which business? null when the user has no business yet.
create or replace function public.invoiceit_me()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'role', m.role,
    'business', jsonb_build_object('id', b.id, 'name', b.name, 'addr', b.addr, 'phone', b.phone))
  from public.invoiceit_members m join public.invoiceit_businesses b on b.id = m.business_id
  where m.user_id = auth.uid();
$$;

-- Create a business (owner) or join one with a code (staff). Safe to call again.
create or replace function public.invoiceit_setup(p_business_name text default null, p_join_code text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_code public.invoiceit_join_codes%rowtype;
  v_bid uuid;
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
  insert into public.invoiceit_businesses (name, created_by) values (btrim(p_business_name), v_uid) returning id into v_bid;
  insert into public.invoiceit_members (business_id, user_id, role, email) values (v_bid, v_uid, 'owner', v_email);
  return public.invoiceit_me();
end;
$$;

-- Owner makes a one-time join code for a new staff member.
create or replace function public.invoiceit_new_join_code(p_role text default 'staff')
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if not public.invoiceit_is_owner() then raise exception 'Only the business owner can add people.'; end if;
  if p_role not in ('owner', 'staff') then raise exception 'Unknown role'; end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.invoiceit_join_codes (code, business_id, role) values (v_code, public.invoiceit_my_business(), p_role);
  return v_code;
end;
$$;

-- Invoice numbers are per business and never change.
create or replace function public.invoiceit_invoices_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.business_id is null then new.business_id := public.invoiceit_my_business(); end if;
    if new.no is null or new.no = '' then
      perform pg_advisory_xact_lock(hashtext('invoiceit_no_' || new.business_id::text));
      select lpad((coalesce(max(nullif(regexp_replace(no, '\D', '', 'g'), '')::int), 0) + 1)::text, 5, '0')
        into new.no from public.invoiceit_invoices where business_id = new.business_id;
    end if;
  else
    new.no := old.no;
    new.business_id := old.business_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger invoiceit_invoices_before_write
  before insert or update on public.invoiceit_invoices
  for each row execute function public.invoiceit_invoices_before_write();

-- ---------- access ----------
revoke all on public.invoiceit_businesses, public.invoiceit_members, public.invoiceit_join_codes, public.invoiceit_invoices from anon, authenticated;
grant select, update on public.invoiceit_businesses to authenticated;
grant select, delete on public.invoiceit_members to authenticated;
grant select, delete on public.invoiceit_join_codes to authenticated;
grant select, insert, update on public.invoiceit_invoices to authenticated;

alter table public.invoiceit_businesses enable row level security;
alter table public.invoiceit_members enable row level security;
alter table public.invoiceit_join_codes enable row level security;
alter table public.invoiceit_invoices enable row level security;

create policy "own business: read" on public.invoiceit_businesses for select to authenticated
  using (id = (select public.invoiceit_my_business()));
create policy "own business: owner edits" on public.invoiceit_businesses for update to authenticated
  using (id = (select public.invoiceit_my_business()) and (select public.invoiceit_is_owner()))
  with check (id = (select public.invoiceit_my_business()));

create policy "team: read" on public.invoiceit_members for select to authenticated
  using (business_id = (select public.invoiceit_my_business()));
create policy "team: owner removes others" on public.invoiceit_members for delete to authenticated
  using (business_id = (select public.invoiceit_my_business()) and (select public.invoiceit_is_owner()) and user_id <> (select auth.uid()));

create policy "codes: owner reads" on public.invoiceit_join_codes for select to authenticated
  using (business_id = (select public.invoiceit_my_business()) and (select public.invoiceit_is_owner()));
create policy "codes: owner deletes" on public.invoiceit_join_codes for delete to authenticated
  using (business_id = (select public.invoiceit_my_business()) and (select public.invoiceit_is_owner()));

create policy "invoices: read own business" on public.invoiceit_invoices for select to authenticated
  using (business_id = (select public.invoiceit_my_business()));
create policy "invoices: add to own business" on public.invoiceit_invoices for insert to authenticated
  with check (business_id = (select public.invoiceit_my_business()));
create policy "invoices: edit own business" on public.invoiceit_invoices for update to authenticated
  using (business_id = (select public.invoiceit_my_business()))
  with check (business_id = (select public.invoiceit_my_business()));

revoke all on function public.invoiceit_my_business(), public.invoiceit_is_owner(), public.invoiceit_me(),
  public.invoiceit_setup(text, text), public.invoiceit_new_join_code(text), public.invoiceit_invoices_before_write() from public, anon;
grant execute on function public.invoiceit_my_business(), public.invoiceit_is_owner(), public.invoiceit_me(),
  public.invoiceit_setup(text, text), public.invoiceit_new_join_code(text) to authenticated;
revoke all on function public.invoiceit_invoices_before_write() from authenticated;

-- ---------- copy JB Enterprise in as the first business ----------
do $$
declare v_bid uuid;
begin
  insert into public.invoiceit_businesses (name, addr, phone, created_by)
  select 'JB Enterprise', coalesce(data ->> 'addr', ''), coalesce(data ->> 'phone', ''), (select id from auth.users where email = 'jb@gmail.com')
  from public.jb_settings where id = 1
  returning id into v_bid;

  insert into public.invoiceit_members (business_id, user_id, role, email)
  select v_bid, u.id, 'owner', u.email
  from auth.users u join public.jb_staff s on s.email = lower(u.email);

  insert into public.invoiceit_invoices (id, business_id, no, data, created_by, created_at, updated_at)
  select id, v_bid, no, jsonb_set(data, '{store,name}', '"JB Enterprise"', true), created_by, created_at, updated_at
  from public.jb_invoices;
end $$;
