-- JB Enterprise invoice app.
-- Only CREATES new jb_* objects. Does not alter, drop or read anything belonging to other apps.

-- Who may use the app. Auth users are shared across apps in this project, so being signed in is not enough.
create table public.jb_staff (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);
alter table public.jb_staff enable row level security;
revoke all on public.jb_staff from anon, authenticated;

create or replace function public.jb_is_staff()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.jb_staff s
    where s.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.jb_is_staff() from public, anon;
grant execute on function public.jb_is_staff() to authenticated;

-- Invoices. The full invoice (items, payments, customer...) lives in data; no is assigned on insert.
create table public.jb_invoices (
  id text primary key default gen_random_uuid()::text,
  no text not null unique,
  data jsonb not null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jb_invoices_created_at_idx on public.jb_invoices (created_at desc);
create index jb_invoices_created_by_idx on public.jb_invoices (created_by);

create or replace function public.jb_invoices_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and (new.no is null or new.no = '') then
    perform pg_advisory_xact_lock(hashtext('jb_invoices_no'));
    select lpad((coalesce(max(nullif(regexp_replace(no, '\D', '', 'g'), '')::int), 0) + 1)::text, 5, '0')
      into new.no from public.jb_invoices;
  end if;
  if tg_op = 'UPDATE' then
    new.no := old.no;            -- invoice numbers never change
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger jb_invoices_before_write
  before insert or update on public.jb_invoices
  for each row execute function public.jb_invoices_before_write();

alter table public.jb_invoices enable row level security;
revoke all on public.jb_invoices from anon, authenticated;
grant select, insert, update on public.jb_invoices to authenticated;
create policy "jb staff read invoices" on public.jb_invoices for select to authenticated using ((select public.jb_is_staff()));
create policy "jb staff add invoices" on public.jb_invoices for insert to authenticated with check ((select public.jb_is_staff()));
create policy "jb staff edit invoices" on public.jb_invoices for update to authenticated using ((select public.jb_is_staff())) with check ((select public.jb_is_staff()));

-- Shop details shared by every device (address, phone numbers). Single row.
create table public.jb_settings (
  id int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.jb_settings (id) values (1);
alter table public.jb_settings enable row level security;
revoke all on public.jb_settings from anon, authenticated;
grant select, update on public.jb_settings to authenticated;
create policy "jb staff read settings" on public.jb_settings for select to authenticated using ((select public.jb_is_staff()));
create policy "jb staff edit settings" on public.jb_settings for update to authenticated using ((select public.jb_is_staff())) with check ((select public.jb_is_staff()));

-- Trigger function must not be callable over the API (the trigger itself still runs).
revoke all on function public.jb_invoices_before_write() from public, anon, authenticated;
