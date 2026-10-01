-- Run this once in your Supabase project's SQL editor (Database > SQL Editor > New query).

create table if not exists public.recruiters (
    id bigserial primary key,
    user_id uuid not null unique references auth.users(id) on delete cascade,
    email text not null,
    domain text not null,
    company text not null,
    has_password boolean not null default false,
    verified_at timestamptz not null default now()
);
alter table public.recruiters add column if not exists has_password boolean not null default false;

create table if not exists public.professionals (
    id bigserial primary key,
    user_id uuid unique references auth.users(id) on delete cascade,
    email text,
    name text not null default '',
    employer text not null default '',
    title text not null default '',
    description text not null default '',
    resume_path text,
    resume_filename text,
    resume_content_type text,
    has_password boolean not null default false,
    created_at timestamptz not null default now()
);

alter table public.professionals add column if not exists resume_path text;
alter table public.professionals add column if not exists resume_filename text;
alter table public.professionals add column if not exists resume_content_type text;
alter table public.professionals add column if not exists has_password boolean not null default false;
alter table public.professionals add column if not exists hidden_from_matching boolean not null default false;

create table if not exists public.professional_clients (
    id bigserial primary key,
    professional_id bigint not null references public.professionals(id) on delete cascade,
    company text not null,
    sort_order integer not null default 0
);

create table if not exists public.messages (
    id bigserial primary key,
    professional_id bigint not null references public.professionals(id) on delete cascade,
    recruiter_id bigint not null references public.recruiters(id) on delete cascade,
    sender text not null check (sender in ('recruiter', 'professional')),
    body text not null,
    created_at timestamptz not null default now()
);
create index if not exists messages_thread_idx on public.messages (professional_id, recruiter_id, created_at);

-- Deny-by-default: no policies means the public anon/authenticated keys can't
-- read or write these tables directly. The Flask backend uses the service-role
-- key, which bypasses RLS policies, but table-level GRANTs are a separate gate
-- from RLS -- without these, service_role can't touch the tables at all (this
-- project has "automatically expose new tables" off, so nothing is granted by
-- default). anon/authenticated are deliberately left with no grants at all.
alter table public.recruiters enable row level security;
alter table public.professionals enable row level security;
alter table public.professional_clients enable row level security;
alter table public.messages enable row level security;

grant select, insert, update, delete on public.recruiters to service_role;
grant select, insert, update, delete on public.professionals to service_role;
grant select, insert, update, delete on public.professional_clients to service_role;
grant select, insert, update, delete on public.messages to service_role;
grant usage, select on sequence public.recruiters_id_seq to service_role;
grant usage, select on sequence public.professionals_id_seq to service_role;
grant usage, select on sequence public.professional_clients_id_seq to service_role;
grant usage, select on sequence public.messages_id_seq to service_role;

-- Sample professionals so recruiter search has results before anyone signs up.
-- user_id/email are left NULL -- these aren't real accounts, just seed data.
-- Safe to re-run: skips seeding if it's already been done once.
do $$
begin
    if not exists (select 1 from public.professionals where user_id is null) then
        insert into public.professionals (email, name, employer, title, description)
        values
            (null, 'Daniel Reyes', 'Deloitte', 'Senior Consultant',
             'Leads operational due diligence and process redesign for retail and apparel clients.'),
            (null, 'Priya Natarajan', 'Snowflake', 'Solutions Architect',
             'Designs data warehouse migrations and reporting pipelines for enterprise customers.'),
            (null, 'Sam Whitfield', 'Gartner', 'Research Analyst, Payments',
             'Publishes market research on digital payments and advises product teams on competitive positioning.'),
            (null, 'Lena Brooks', 'Accenture', 'UX Research Lead',
             'Runs customer research programs for travel and hospitality brands.');

        insert into public.professional_clients (professional_id, company, sort_order)
        select p.id, c.company, c.sort_order
        from public.professionals p
        join (values
            ('Daniel Reyes', 'Nike', 0),
            ('Daniel Reyes', 'Shopify', 1),
            ('Priya Natarajan', 'Stripe', 0),
            ('Priya Natarajan', 'Delta', 1),
            ('Priya Natarajan', 'Nike', 2),
            ('Sam Whitfield', 'Stripe', 0),
            ('Lena Brooks', 'Delta', 0),
            ('Lena Brooks', 'Shopify', 1)
        ) as c(name, company, sort_order) on c.name = p.name
        where p.user_id is null;
    end if;
end $$;
