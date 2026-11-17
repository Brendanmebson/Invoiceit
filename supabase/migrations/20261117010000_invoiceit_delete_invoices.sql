-- Owners can delete invoices (one at a time, or old ones in bulk from the Invoices page). Staff can't.
-- The audit trigger (20261109030000_invoiceit_hardening.sql) keeps a full copy of every deleted invoice.

grant delete on public.invoiceit_invoices to authenticated;
create policy "invoices: owner deletes" on public.invoiceit_invoices for delete to authenticated
  using (business_id = (select public.invoiceit_my_business()) and (select public.invoiceit_is_owner()));

-- Numbers of deleted invoices are never handed out again: the next number is one above the highest
-- number the business has ever used, counting deleted invoices from the audit log.
create or replace function public.invoiceit_invoices_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.business_id is null then new.business_id := public.invoiceit_my_business(); end if;
    if new.no is null or new.no = '' then
      perform pg_advisory_xact_lock(hashtext('invoiceit_no_' || new.business_id::text));
      select lpad((coalesce(max(nullif(regexp_replace(n, '\D', '', 'g'), '')::int), 0) + 1)::text, 5, '0')
        into new.no
        from (select no as n from public.invoiceit_invoices where business_id = new.business_id
              union all
              select invoice_no from public.invoiceit_invoice_audit where business_id = new.business_id and action = 'delete') used;
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

create index if not exists invoiceit_invoice_audit_deleted_idx on public.invoiceit_invoice_audit (business_id) where action = 'delete';
