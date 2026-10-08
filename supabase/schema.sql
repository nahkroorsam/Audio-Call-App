-- ============================================================
-- AudioCall – Supabase Schema
-- Run this in Supabase Dashboard → SQL Editor
-- ============================================================

-- Enable UUID extension (usually already on)
create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------
-- Profiles (optional, mirrors auth.users)
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Public profiles are viewable by everyone"
  on public.profiles for select
  using (true);

create policy "Users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    split_part(new.email, '@', 1)
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ------------------------------------------------------------
-- Rooms (optional – used for listing / ownership / expiry)
-- You can also work purely with Realtime channels + room codes
-- ------------------------------------------------------------
create table if not exists public.rooms (
  id uuid primary key default uuid_generate_v4(),
  code text unique not null,               -- short shareable code
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '24 hours'),
  max_participants int default 10
);

create index if not exists rooms_code_idx on public.rooms (code);

alter table public.rooms enable row level security;

-- Anyone authenticated can create a room
create policy "Authenticated users can create rooms"
  on public.rooms for insert
  with check (auth.role() = 'authenticated');

-- Anyone authenticated can read rooms (needed to join by code)
create policy "Authenticated users can read rooms"
  on public.rooms for select
  using (auth.role() = 'authenticated');

-- Only creator can delete
create policy "Creators can delete their rooms"
  on public.rooms for delete
  using (auth.uid() = created_by);

-- ------------------------------------------------------------
-- Realtime is enabled by default for public schema in newer projects.
-- If you need to enable it manually:
--   Dashboard → Database → Replication → add tables if required.
-- We mainly use Realtime Broadcast + Presence channels,
-- which do not require table replication.
-- ============================================================
