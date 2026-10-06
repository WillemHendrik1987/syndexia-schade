-- Syndexia Schademelding — databaseschema (Supabase-project "Attestenbeheer VME")
-- Alle tabellen hebben prefix sm_ zodat ze niet botsen met Attestenbeheer.
-- RLS staat aan zonder policies: enkel de server (service role) kan lezen/schrijven.

create table if not exists public.sm_gebouwen (
  id uuid primary key default gen_random_uuid(),
  naam text not null,
  adres text,
  qr_token text not null unique default substr(replace(gen_random_uuid()::text,'-',''),1,12),
  toegang_info text,               -- bv. sleutelkluis, conciërge (enkel zichtbaar voor de aannemer)
  bron_gebouw_id uuid,             -- verwijzing naar public.gebouwen (Attestenbeheer)
  actief boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.sm_aannemers (
  id uuid primary key default gen_random_uuid(),
  firma text not null,
  contactpersoon text,
  email text not null,
  telefoon text,
  vakgebied text not null default 'algemeen',
  actief boolean not null default true,
  created_at timestamptz not null default now()
);

-- per gebouw en per categorie: prioriteit 1 = vaste aannemer, 2 = reserve (bij weigering/geen reactie)
create table if not exists public.sm_toewijzingen (
  id uuid primary key default gen_random_uuid(),
  gebouw_id uuid not null references public.sm_gebouwen(id) on delete cascade,
  categorie text not null,
  aannemer_id uuid not null references public.sm_aannemers(id) on delete cascade,
  prioriteit smallint not null default 1 check (prioriteit in (1,2)),
  unique (gebouw_id, categorie, prioriteit)
);

-- concept = AI-analyse vóór het indienen. De server bewaart het resultaat zelf,
-- zodat een bewoner de urgentie niet via de browser kan vervalsen.
create table if not exists public.sm_concepten (
  id uuid primary key default gen_random_uuid(),
  gebouw_id uuid not null references public.sm_gebouwen(id) on delete cascade,
  beschrijving text,
  locatie text,
  fotos text[] not null default '{}',
  ai jsonb,
  ronde smallint not null default 1,
  ip_hash text,
  created_at timestamptz not null default now()
);

create sequence if not exists public.sm_melding_nr;

create table if not exists public.sm_meldingen (
  id uuid primary key default gen_random_uuid(),
  nummer text not null unique default ('SM-' || to_char(now(),'YYYY') || '-' || lpad(nextval('public.sm_melding_nr')::text,4,'0')),
  gebouw_id uuid not null references public.sm_gebouwen(id) on delete restrict,
  status text not null default 'nieuw' check (status in ('nieuw','wacht_goedkeuring','wacht_aanvaarding','aanvaard','ingepland','uitgevoerd','afgesloten','geannuleerd')),
  urgentie text not null check (urgentie in ('dringend','niet_dringend')),
  categorie text not null,
  titel text not null,
  samenvatting text,
  beschrijving text,
  locatie text,
  ai jsonb,
  fotos text[] not null default '{}',
  privatief_vermoeden boolean not null default false,
  melder_naam text,
  melder_appartement text,
  melder_email text,
  melder_tel text,
  melder_contact_aannemer boolean not null default false,
  track_token text not null unique default replace(gen_random_uuid()::text,'-',''),
  aannemer_id uuid references public.sm_aannemers(id) on delete set null,
  aannemer_token text unique,
  verstuurd_op timestamptz,
  aanvaard_op timestamptz,
  gepland_op timestamptz,
  uitgevoerd_op timestamptz,
  afgesloten_op timestamptz,
  herinneringen smallint not null default 0,
  laatste_opvolging timestamptz,
  escalatie boolean not null default false,
  geweigerd_door uuid[] not null default '{}',
  bevestigingen integer not null default 0,
  opgelost_feedback text,
  ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sm_meldingen_gebouw_idx on public.sm_meldingen(gebouw_id, status);
create index if not exists sm_meldingen_status_idx on public.sm_meldingen(status, created_at);

create table if not exists public.sm_events (
  id bigint generated always as identity primary key,
  melding_id uuid not null references public.sm_meldingen(id) on delete cascade,
  actor text not null check (actor in ('bewoner','ai','systeem','aannemer','syndicus')),
  type text not null,
  tekst text,
  data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists sm_events_melding_idx on public.sm_events(melding_id, created_at);

create table if not exists public.sm_instellingen (
  id smallint primary key default 1 check (id = 1),
  syndicus_naam text not null default 'Syndexia',
  syndicus_email text not null default 'beheer@syndexia.be',
  auto_doorsturen_niet_dringend boolean not null default true,
  escalatie_dringend_min integer not null default 120,
  herinnering_normaal_uren integer not null default 48,
  dagrapport boolean not null default true,
  laatste_dagrapport date
);
insert into public.sm_instellingen (id) values (1) on conflict do nothing;

create or replace function public.sm_touch() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create or replace trigger sm_meldingen_touch before update on public.sm_meldingen
  for each row execute function public.sm_touch();

alter table public.sm_gebouwen enable row level security;
alter table public.sm_aannemers enable row level security;
alter table public.sm_toewijzingen enable row level security;
alter table public.sm_concepten enable row level security;
alter table public.sm_meldingen enable row level security;
alter table public.sm_events enable row level security;
alter table public.sm_instellingen enable row level security;

-- private opslag voor foto's (enkel via tijdelijke, ondertekende links te bekijken)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('schademeldingen','schademeldingen', false, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- bestaande Syndexia-gebouwen overnemen uit Attestenbeheer
insert into public.sm_gebouwen (naam, adres, bron_gebouw_id)
select g.naam, g.adres, g.id from public.gebouwen g
where g.actief and not exists (select 1 from public.sm_gebouwen s where s.bron_gebouw_id = g.id);
