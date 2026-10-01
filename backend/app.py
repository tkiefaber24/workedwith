from datetime import datetime, timezone

from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS

from auth import parse_work_email, get_bearer_token
from supabase_client import get_supabase
from storage import ALLOWED_RESUME_MIME, MAX_RESUME_BYTES, upload_resume, signed_resume_url, delete_resume
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

# Demo/test exception: this one specific recruiter account can switch between
# a fixed list of companies instead of being locked to one derived from their
# email. Keyed by the exact email, not the domain, so this can never become a
# general way for a real recruiter to view a company they didn't actually verify.
DEMO_RECRUITER_COMPANIES = {
    "tkster8@sbcglobal.net": ["Stripe", "Apple"],
}


def recruiter_json(row):
    return {
        "email": row["email"], "company": row["company"], "verifiedAt": row["verified_at"],
        "hasPassword": bool(row.get("has_password")),
        "companies": DEMO_RECRUITER_COMPANIES.get(row.get("email")),
    }


def effective_company(rec, requested_company):
    """The company to act as for this request -- normally always the
    recruiter's own verified company, except for a demo account, which may
    request any company from its fixed allowed list."""
    allowed = DEMO_RECRUITER_COMPANIES.get(rec.get("email"))
    if allowed and requested_company in allowed:
        return requested_company
    return rec["company"]


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
    payload = {
        "user_id": user.id, "email": email, "domain": domain,
        "company": company, "verified_at": now_iso(),
    }
    body = request.get_json(silent=True) or {}
    if body.get("justSetPassword"):
        # Only set on the truthy case -- omitting the key on a routine finalize call
        # means the upsert's ON CONFLICT leaves any existing has_password untouched.
        payload["has_password"] = True
    sb.table("recruiters").upsert(payload, on_conflict="user_id").execute()
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


def get_verified_recruiter(user):
    rec = get_supabase().table("recruiters").select("*").eq("user_id", user.id).execute().data
    return rec[0] if rec else None


def professional_matches_company(professional_id, company):
    match = get_supabase().table("professional_clients").select("professional_id") \
        .eq("professional_id", professional_id).ilike("company", company.strip()).execute().data
    return bool(match)


@app.route("/api/recruiters/matches", methods=["GET"])
def recruiter_matches():
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    sb = get_supabase()
    rec = get_verified_recruiter(user)
    if not rec:
        return jsonify({"error": "Not a verified recruiter yet."}), 404
    company = effective_company(rec, request.args.get("company"))

    clients = sb.table("professional_clients").select("professional_id, company") \
        .ilike("company", company.strip()).execute().data

    match_company_by_id = {}
    ordered_ids = []
    for c in clients:
        pid = c["professional_id"]
        if pid not in match_company_by_id:
            match_company_by_id[pid] = c["company"]
            ordered_ids.append(pid)

    contacted_ids = set()
    matches = []
    if ordered_ids:
        profs = sb.table("professionals").select("*").in_("id", ordered_ids) \
            .eq("hidden_from_matching", False).execute().data
        by_id = {p["id"]: p for p in profs}
        msgs = sb.table("messages").select("professional_id").eq("recruiter_id", rec["id"]) \
            .in_("professional_id", ordered_ids).execute().data
        contacted_ids = {m["professional_id"] for m in msgs}
        for pid in ordered_ids:
            p = by_id.get(pid)
            if not p:
                continue
            matches.append({
                "id": p["id"], "name": p["name"], "employer": p["employer"],
                "title": p["title"], "desc": p["description"],
                "matchCompany": match_company_by_id[pid],
                "hasResume": bool(p.get("resume_path")),
                "contacted": pid in contacted_ids,
            })

    return jsonify({"company": company, "matches": matches})


@app.route("/api/recruiters/matches/<int:professional_id>/resume-url", methods=["GET"])
def recruiter_match_resume_url(professional_id):
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    sb = get_supabase()
    rec = get_verified_recruiter(user)
    if not rec:
        return jsonify({"error": "Not a verified recruiter yet."}), 404

    # Only allow this if the professional actually lists the recruiter's company --
    # same privacy rule as /matches, enforced again here since this is a separate route.
    if not professional_matches_company(professional_id, effective_company(rec, request.args.get("company"))):
        return jsonify({"error": "Not authorized to view this resume."}), 403

    prof = sb.table("professionals").select("resume_path, resume_content_type") \
        .eq("id", professional_id).execute().data
    if not prof or not prof[0].get("resume_path"):
        return jsonify({"error": "No resume uploaded."}), 404

    return jsonify({
        "url": signed_resume_url(prof[0]["resume_path"]),
        "contentType": prof[0].get("resume_content_type"),
    })


def messages_json(rows):
    return [{"id": r["id"], "sender": r["sender"], "body": r["body"], "createdAt": r["created_at"]} for r in rows]


@app.route("/api/recruiters/matches/<int:professional_id>/messages", methods=["GET"])
def recruiter_thread_messages(professional_id):
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    rec = get_verified_recruiter(user)
    if not rec:
        return jsonify({"error": "Not a verified recruiter yet."}), 404
    if not professional_matches_company(professional_id, effective_company(rec, request.args.get("company"))):
        return jsonify({"error": "Not authorized to message this person."}), 403

    rows = get_supabase().table("messages").select("*") \
        .eq("professional_id", professional_id).eq("recruiter_id", rec["id"]) \
        .order("created_at").execute().data
    return jsonify({"messages": messages_json(rows)})


@app.route("/api/recruiters/matches/<int:professional_id>/messages", methods=["POST"])
def recruiter_send_message(professional_id):
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    rec = get_verified_recruiter(user)
    if not rec:
        return jsonify({"error": "Not a verified recruiter yet."}), 404
    body = request.get_json(silent=True) or {}
    if not professional_matches_company(professional_id, effective_company(rec, body.get("company"))):
        return jsonify({"error": "Not authorized to message this person."}), 403

    text = (body.get("body") or "").strip()[:4000]
    if not text:
        return jsonify({"error": "Message can't be empty."}), 400

    sb = get_supabase()
    sb.table("messages").insert({
        "professional_id": professional_id, "recruiter_id": rec["id"],
        "sender": "recruiter", "body": text,
    }).execute()
    rows = sb.table("messages").select("*") \
        .eq("professional_id", professional_id).eq("recruiter_id", rec["id"]) \
        .order("created_at").execute().data
    return jsonify({"messages": messages_json(rows)})


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
        "hasResume": bool(row.get("resume_path")),
        "resumeFilename": row.get("resume_filename"),
        "hasPassword": bool(row.get("has_password")),
        "hidden": bool(row.get("hidden_from_matching")),
    }


def get_or_create_professional(user, has_password=False):
    sb = get_supabase()
    existing = sb.table("professionals").select("*").eq("user_id", user.id).execute().data
    if existing:
        return existing[0]
    inserted = sb.table("professionals").insert({
        "user_id": user.id, "email": user.email,
        "name": "", "employer": "", "title": "", "description": "",
        "has_password": bool(has_password),
    }).execute()
    return inserted.data[0]


@app.route("/api/professionals/me", methods=["GET"])
def professional_me():
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    # justSetPassword: the frontend sets this right after a signup-with-password flow,
    # so the row is created with has_password already true instead of a separate
    # follow-up call racing against a row that doesn't exist yet.
    row = get_or_create_professional(user, has_password=request.args.get("justSetPassword") == "1")
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
    if "hidden" in body:
        fields["hidden_from_matching"] = bool(body["hidden"])

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


@app.route("/api/professionals/me/resume", methods=["POST"])
def professional_upload_resume():
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    row = get_or_create_professional(user)

    if "resume" not in request.files:
        return jsonify({"error": "No resume file provided."}), 400
    file = request.files["resume"]
    content_type = file.mimetype
    if content_type not in ALLOWED_RESUME_MIME:
        return jsonify({"error": "Resume must be a PDF or Word (.docx) document."}), 400

    file_bytes = file.read()
    if len(file_bytes) > MAX_RESUME_BYTES:
        return jsonify({"error": "Resume must be smaller than 10MB."}), 400

    extension = ALLOWED_RESUME_MIME[content_type]
    path = upload_resume(row["id"], file_bytes, content_type, extension)

    sb = get_supabase()
    sb.table("professionals").update({
        "resume_path": path,
        "resume_filename": file.filename or f"resume.{extension}",
        "resume_content_type": content_type,
    }).eq("id", row["id"]).execute()
    row = sb.table("professionals").select("*").eq("id", row["id"]).single().execute().data

    return jsonify(professional_json(row))


@app.route("/api/professionals/me/resume-url", methods=["GET"])
def professional_resume_url():
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    row = get_or_create_professional(user)
    if not row.get("resume_path"):
        return jsonify({"error": "No resume uploaded yet."}), 404
    return jsonify({
        "url": signed_resume_url(row["resume_path"]),
        "contentType": row.get("resume_content_type"),
    })


@app.route("/api/professionals/me/conversations", methods=["GET"])
def professional_conversations():
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    row = get_or_create_professional(user)
    sb = get_supabase()

    msgs = sb.table("messages").select("recruiter_id, sender, body, created_at") \
        .eq("professional_id", row["id"]).order("created_at").execute().data
    last_by_recruiter = {}
    for m in msgs:
        last_by_recruiter[m["recruiter_id"]] = m  # ascending order -> last write wins

    if not last_by_recruiter:
        return jsonify({"conversations": []})

    recruiters = sb.table("recruiters").select("id, company").in_("id", list(last_by_recruiter.keys())).execute().data
    company_by_id = {r["id"]: r["company"] for r in recruiters}

    conversations = []
    for rid, last in last_by_recruiter.items():
        company = company_by_id.get(rid)
        if not company:
            continue
        conversations.append({
            "recruiterId": rid, "company": company,
            "lastMessage": last["body"], "lastSender": last["sender"], "lastAt": last["created_at"],
        })
    conversations.sort(key=lambda c: c["lastAt"], reverse=True)
    return jsonify({"conversations": conversations})


@app.route("/api/professionals/me/conversations/<int:recruiter_id>/messages", methods=["GET"])
def professional_thread_messages(recruiter_id):
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    row = get_or_create_professional(user)

    rows = get_supabase().table("messages").select("*") \
        .eq("professional_id", row["id"]).eq("recruiter_id", recruiter_id) \
        .order("created_at").execute().data
    if not rows:
        return jsonify({"error": "No conversation found."}), 404
    return jsonify({"messages": messages_json(rows)})


@app.route("/api/professionals/me/conversations/<int:recruiter_id>/messages", methods=["POST"])
def professional_send_message(recruiter_id):
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    row = get_or_create_professional(user)
    sb = get_supabase()

    # A professional can only reply to a recruiter who has already reached out --
    # they can't use this to start a conversation with an arbitrary recruiter_id.
    existing = sb.table("messages").select("id") \
        .eq("professional_id", row["id"]).eq("recruiter_id", recruiter_id).limit(1).execute().data
    if not existing:
        return jsonify({"error": "This recruiter hasn't reached out yet."}), 403

    body = request.get_json(silent=True) or {}
    text = (body.get("body") or "").strip()[:4000]
    if not text:
        return jsonify({"error": "Message can't be empty."}), 400

    sb.table("messages").insert({
        "professional_id": row["id"], "recruiter_id": recruiter_id,
        "sender": "professional", "body": text,
    }).execute()
    rows = sb.table("messages").select("*") \
        .eq("professional_id", row["id"]).eq("recruiter_id", recruiter_id) \
        .order("created_at").execute().data
    return jsonify({"messages": messages_json(rows)})


@app.route("/api/account/password-set", methods=["POST"])
def account_password_set():
    """Called after the frontend successfully sets a password via Supabase's own
    auth.updateUser -- this just flags it on our side so we stop nudging the user
    to set one. The password itself never passes through this backend."""
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    sb = get_supabase()
    sb.table("professionals").update({"has_password": True}).eq("user_id", user.id).execute()
    sb.table("recruiters").update({"has_password": True}).eq("user_id", user.id).execute()
    return jsonify({"ok": True})


@app.route("/api/account", methods=["DELETE"])
def delete_account():
    """Permanently deletes the signed-in user's auth account. Postgres foreign
    keys (professionals/recruiters -> auth.users, and professional_clients/
    messages -> those) are all `on delete cascade`, so deleting the auth user
    alone removes every row tied to them. Only the resume file in storage
    needs cleaning up by hand, since storage isn't part of that FK chain."""
    user = get_current_user(request)
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    sb = get_supabase()
    prof = sb.table("professionals").select("resume_path").eq("user_id", user.id).execute().data
    if prof and prof[0].get("resume_path"):
        delete_resume(prof[0]["resume_path"])
    sb.auth.admin.delete_user(user.id)
    return jsonify({"ok": True})


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
