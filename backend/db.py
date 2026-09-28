import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), "workedwith.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS recruiters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    domain TEXT NOT NULL,
    company TEXT NOT NULL,
    verified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS professionals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    employer TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    desc TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS professional_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
    company TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
"""

# Sample professionals so recruiter search has results before anyone signs up.
# email is left NULL (unclaimed) -- these aren't real accounts.
SEED_PROFESSIONALS = [
    {"name": "Daniel Reyes", "employer": "Deloitte", "title": "Senior Consultant",
     "desc": "Leads operational due diligence and process redesign for retail and apparel clients.",
     "clients": ["Nike", "Shopify"]},
    {"name": "Priya Natarajan", "employer": "Snowflake", "title": "Solutions Architect",
     "desc": "Designs data warehouse migrations and reporting pipelines for enterprise customers.",
     "clients": ["Stripe", "Delta", "Nike"]},
    {"name": "Sam Whitfield", "employer": "Gartner", "title": "Research Analyst, Payments",
     "desc": "Publishes market research on digital payments and advises product teams on competitive positioning.",
     "clients": ["Stripe"]},
    {"name": "Lena Brooks", "employer": "Accenture", "title": "UX Research Lead",
     "desc": "Runs customer research programs for travel and hospitality brands.",
     "clients": ["Delta", "Shopify"]},
]


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def seed_professionals_if_empty():
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) AS c FROM professionals").fetchone()["c"]
    if count == 0:
        created_at = datetime.now(timezone.utc).isoformat()
        for p in SEED_PROFESSIONALS:
            cur = conn.execute(
                "INSERT INTO professionals (email, name, employer, title, desc, created_at) "
                "VALUES (NULL, ?, ?, ?, ?, ?)",
                (p["name"], p["employer"], p["title"], p["desc"], created_at),
            )
            professional_id = cur.lastrowid
            for i, company in enumerate(p["clients"]):
                conn.execute(
                    "INSERT INTO professional_clients (professional_id, company, sort_order) VALUES (?, ?, ?)",
                    (professional_id, company, i),
                )
        conn.commit()
    conn.close()
