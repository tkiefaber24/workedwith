from datetime import datetime, timezone

from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS

from auth import parse_work_email, get_bearer_token
from supabase_client import get_supabase
import os

load_dotenv()

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app, origins="*")


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/config.js")
def config_js():
    url = os.getenv("SUPABASE_URL", "")
    anon_key = os.getenv("SUPABASE_ANON_KEY", "")
    body = f'window.SUPABASE_URL = {url!r};\nwindow.SUPABASE_ANON_KEY = {anon_key!r};\n'
    return app.response_class(body, mimetype="application/javascript")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def get_current_user(req):
    token = get_bearer_token(req)
    if not token:
        return None
    try:
        return get_supabase().auth.get_user(token).user
    except Exception:
        return None


# ---- Recruiters ----

def recruiter_json(row):
    return {"email": row["email"], "company": row["company"], "verifiedAt": row["verified_at"]}


@app.route("/api/recruiters/finalize", methods=["POST"])
def recruiter_finalize():
    """Called right after the frontend completes Supabase OTP verification.
    Confirms the verified email is a work email and creates/updates the recruiter row."""
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    try:
        email, domain, company = parse_work_email(user.email)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    sb = get_supabase()
    sb.table("recruiters").upsert({
        "user_id": user.id, "email": email, "domain": domain,
        "company": company, "verified_at": now_iso(),
    }, on_conflict="user_id").execute()
    row = sb.table("recruiters").select("*").eq("user_id", user.id).single().execute().data
    return jsonify(recruiter_json(row))


@app.route("/api/recruiters/me", methods=["GET"])
def recruiter_me():
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    result = get_supabase().table("recruiters").select("*").eq("user_id", user.id).execute()
    if not result.data:
        return jsonify({"error": "Not a verified recruiter yet."}), 404
    return jsonify(recruiter_json(result.data[0]))


@app.route("/api/recruiters/matches", methods=["GET"])
def recruiter_matches():
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    sb = get_supabase()
    rec = sb.table("recruiters").select("*").eq("user_id", user.id).execute().data
    if not rec:
        return jsonify({"error": "Not a verified recruiter yet."}), 404
    company = rec[0]["company"]

    clients = sb.table("professional_clients").select("professional_id, company") \
        .ilike("company", company.strip()).execute().data

    match_company_by_id = {}
    ordered_ids = []
    for c in clients:
        pid = c["professional_id"]
        if pid not in match_company_by_id:
            match_company_by_id[pid] = c["company"]
            ordered_ids.append(pid)

    matches = []
    if ordered_ids:
        profs = sb.table("professionals").select("*").in_("id", ordered_ids).execute().data
        by_id = {p["id"]: p for p in profs}
        for pid in ordered_ids:
            p = by_id.get(pid)
            if not p:
                continue
            matches.append({
                "id": p["id"], "name": p["name"], "employer": p["employer"],
                "title": p["title"], "desc": p["description"],
                "matchCompany": match_company_by_id[pid],
            })

    return jsonify({"company": company, "matches": matches})


# ---- Professionals ----

def get_clients(professional_id):
    rows = get_supabase().table("professional_clients").select("id, company") \
        .eq("professional_id", professional_id).order("sort_order").execute().data
    return [{"id": r["id"], "company": r["company"]} for r in rows]


def professional_json(row):
    return {
        "email": row.get("email"), "name": row["name"], "employer": row["employer"],
        "title": row["title"], "desc": row["description"],
        "clients": get_clients(row["id"]),
    }


def get_or_create_professional(user):
    sb = get_supabase()
    existing = sb.table("professionals").select("*").eq("user_id", user.id).execute().data
    if existing:
        return existing[0]
    inserted = sb.table("professionals").insert({
        "user_id": user.id, "email": user.email,
        "name": "", "employer": "", "title": "", "description": "",
    }).execute()
    return inserted.data[0]


@app.route("/api/professionals/me", methods=["GET"])
def professional_me():
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    row = get_or_create_professional(user)
    return jsonify(professional_json(row))


@app.route("/api/professionals/me", methods=["PUT"])
def professional_update():
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    row = get_or_create_professional(user)

    body = request.get_json(silent=True) or {}
    fields = {}
    for key, column in (("name", "name"), ("employer", "employer"), ("title", "title"), ("desc", "description")):
        if key in body:
            fields[column] = str(body[key])[:2000]

    if fields:
        sb = get_supabase()
        sb.table("professionals").update(fields).eq("id", row["id"]).execute()
        row = sb.table("professionals").select("*").eq("id", row["id"]).single().execute().data

    return jsonify(professional_json(row))


@app.route("/api/professionals/me/clients", methods=["POST"])
def professional_add_client():
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    row = get_or_create_professional(user)

    body = request.get_json(silent=True) or {}
    company = (body.get("company") or "").strip()
    if not company:
        return jsonify({"error": "Company name is required."}), 400

    sb = get_supabase()
    existing = sb.table("professional_clients").select("sort_order") \
        .eq("professional_id", row["id"]).order("sort_order", desc=True).limit(1).execute().data
    next_order = (existing[0]["sort_order"] + 1) if existing else 0
    sb.table("professional_clients").insert({
        "professional_id": row["id"], "company": company, "sort_order": next_order,
    }).execute()

    return jsonify(professional_json(row))


@app.route("/api/professionals/me/clients/<int:client_id>", methods=["DELETE"])
def professional_remove_client(client_id):
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    row = get_or_create_professional(user)

    get_supabase().table("professional_clients").delete() \
        .eq("id", client_id).eq("professional_id", row["id"]).execute()

    return jsonify(professional_json(row))


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
