-- Run this once in your Supabase project's SQL editor (Database > SQL Editor > New query).

create table if not exists public.recruiters (
    id bigserial primary key,
    user_id uuid not null unique references auth.users(id) on delete cascade,
    email text not null,
    domain text not null,
    company text not null,
    verified_at timestamptz not null default now()
);

create table if not exists public.professionals (
    id bigserial primary key,
    user_id uuid unique references auth.users(id) on delete cascade,
    email text,
    name text not null default '',
    employer text not null default '',
    title text not null default '',
    description text not null default '',
    created_at timestamptz not null default now()
);

create table if not exists public.professional_clients (
    id bigserial primary key,
    professional_id bigint not null references public.professionals(id) on delete cascade,
    company text not null,
    sort_order integer not null default 0
);

-- Deny-by-default: no policies means the public anon/authenticated keys can't
-- read or write these tables directly. The Flask backend uses the service-role
-- key, which bypasses RLS entirely, so this only blocks the browser from
-- querying these tables straight from the anon key.
alter table public.recruiters enable row level security;
alter table public.professionals enable row level security;
alter table public.professional_clients enable row level security;

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
