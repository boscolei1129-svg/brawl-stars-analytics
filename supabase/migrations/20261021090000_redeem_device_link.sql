-- Apply before deploying the updated brawl function. All ownership changes and
-- code consumption commit together; an error leaves the code and data intact.
create or replace function public.redeem_device_link(p_code_hash text, p_key_hash text)
-- The server's service_role already has table access; no elevated definer is needed.
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  target_owner uuid;
  source_owner uuid;
  moved integer := 0;
begin
  -- Serialize merges, including two different codes redeemed by the same device.
  -- Linking is infrequent; one lock also avoids opposite-direction merge deadlocks.
  perform pg_advisory_xact_lock(hashtext('brawl:redeem_device_link'));
  select owner into target_owner from public.device_links
    where code_hash = p_code_hash and expires_at > clock_timestamp() for update;
  if target_owner is null then
    return jsonb_build_object('status', 'bad_link');
  end if;
  select owner into source_owner from public.device_keys where key_hash = p_key_hash;
  if source_owner = target_owner then
    return jsonb_build_object('status', 'same_device');
  end if;

  delete from public.device_links where code_hash = p_code_hash;
  if source_owner is null then
    insert into public.device_keys (key_hash, owner) values (p_key_hash, target_owner);
  else
    update public.goals set owner = target_owner where owner = source_owner;
    get diagnostics moved = row_count;
    update public.push_subs set owner = target_owner where owner = source_owner;
    insert into public.profile_adders (owner, tag, created_at)
      select target_owner, tag, created_at from public.profile_adders where owner = source_owner
      on conflict (owner, tag) do nothing;
    delete from public.profile_adders where owner = source_owner;
    update public.device_keys set owner = target_owner where owner = source_owner;
    -- Codes issued by the former owner must not recreate an orphaned owner.
    delete from public.device_links where owner = source_owner;
  end if;
  return jsonb_build_object('status', 'ok', 'moved', moved);
end $$;
revoke execute on function public.redeem_device_link(text, text) from public, anon, authenticated;
grant execute on function public.redeem_device_link(text, text) to service_role;

-- Issuing a code shares the merge lock so it cannot capture a former owner.
-- Replacing the previous code and inserting the new one also commit together.
create or replace function public.create_device_link(p_code_hash text, p_key_hash text, p_expires_at timestamptz)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  current_owner uuid;
begin
  perform pg_advisory_xact_lock(hashtext('brawl:redeem_device_link'));
  select owner into current_owner from public.device_keys where key_hash = p_key_hash;
  if current_owner is null then
    return jsonb_build_object('status', 'no_device');
  end if;
  delete from public.device_links where owner = current_owner;
  insert into public.device_links (code_hash, owner, expires_at)
    values (p_code_hash, current_owner, p_expires_at);
  return jsonb_build_object('status', 'ok');
end $$;
revoke execute on function public.create_device_link(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_device_link(text, text, timestamptz) to service_role;
