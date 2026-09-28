from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS

from auth import (
    parse_work_email, parse_any_email, generate_code,
    issue_token, verify_token,
    issue_professional_token, verify_professional_token,
    get_bearer_token,
)
from db import get_db, init_db, seed_professionals_if_empty
import os

load_dotenv()
init_db()
seed_professionals_if_empty()

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app, origins="*")


@app.route("/")
def index():
    return app.send_static_file("index.html")

STUB_EMAIL = os.getenv("STUB_EMAIL", "true").lower() == "true"
CODE_TTL_MINUTES = 10


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def send_verification_email(email, code):
    if STUB_EMAIL:
        print(f"[dev] verification code for {email}: {code}")
        return
    raise NotImplementedError("Real email delivery isn't configured yet.")


def issue_code_for(conn, email):
    code = generate_code()
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=CODE_TTL_MINUTES)).isoformat()
    conn.execute("DELETE FROM verification_codes WHERE email = ? AND consumed_at IS NULL", (email,))
    conn.execute(
        "INSERT INTO verification_codes (email, code, expires_at) VALUES (?, ?, ?)",
        (email, code, expires_at),
    )
    conn.commit()
    send_verification_email(email, code)
    return code


def consume_code(conn, email, code):
    """Returns True if a matching, unexpired code was found and marked consumed."""
    row = conn.execute(
        "SELECT * FROM verification_codes WHERE email = ? AND code = ? AND consumed_at IS NULL "
        "ORDER BY id DESC LIMIT 1",
        (email, code),
    ).fetchone()
    if not row or row["expires_at"] < now_iso():
        return False
    conn.execute("UPDATE verification_codes SET consumed_at = ? WHERE id = ?", (now_iso(), row["id"]))
    conn.commit()
    return True


# ---- Recruiters ----

def get_current_recruiter(req):
    token = get_bearer_token(req)
    if not token:
        return None
    email = verify_token(token)
    if not email:
        return None
    conn = get_db()
    row = conn.execute("SELECT * FROM recruiters WHERE email = ?", (email,)).fetchone()
    conn.close()
    return row


def recruiter_json(row):
    return {"email": row["email"], "company": row["company"], "verifiedAt": row["verified_at"]}


@app.route("/api/recruiters/request-code", methods=["POST"])
def recruiter_request_code():
    body = request.get_json(silent=True) or {}
    try:
        email, domain, company = parse_work_email(body.get("email"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    conn = get_db()
    code = issue_code_for(conn, email)
    conn.close()

    response = {"email": email, "company": company}
    if STUB_EMAIL:
        response["devCode"] = code
    return jsonify(response)


@app.route("/api/recruiters/verify-code", methods=["POST"])
def recruiter_verify_code():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    code = (body.get("code") or "").strip()
    if not email or not code:
        return jsonify({"error": "Enter the code we sent you."}), 400

    conn = get_db()
    if not consume_code(conn, email, code):
        conn.close()
        return jsonify({"error": "That code is incorrect or has expired."}), 400

    try:
        _, domain, company = parse_work_email(email)
    except ValueError as e:
        conn.close()
        return jsonify({"error": str(e)}), 400

    verified_at = now_iso()
    conn.execute(
        "INSERT INTO recruiters (email, domain, company, verified_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(email) DO UPDATE SET domain = excluded.domain, company = excluded.company, "
        "verified_at = excluded.verified_at",
        (email, domain, company, verified_at),
    )
    conn.commit()
    recruiter = conn.execute("SELECT * FROM recruiters WHERE email = ?", (email,)).fetchone()
    conn.close()

    token = issue_token(email)
    return jsonify({"token": token, **recruiter_json(recruiter)})


@app.route("/api/recruiters/me", methods=["GET"])
def recruiter_me():
    recruiter = get_current_recruiter(request)
    if not recruiter:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify(recruiter_json(recruiter))


@app.route("/api/recruiters/matches", methods=["GET"])
def recruiter_matches():
    recruiter = get_current_recruiter(request)
    if not recruiter:
        return jsonify({"error": "Unauthorized"}), 401
    company = recruiter["company"]

    conn = get_db()
    rows = conn.execute(
        "SELECT p.id AS id, p.name AS name, p.employer AS employer, p.title AS title, p.desc AS desc, "
        "pc.company AS match_company "
        "FROM professionals p JOIN professional_clients pc ON pc.professional_id = p.id "
        "WHERE LOWER(TRIM(pc.company)) = LOWER(TRIM(?)) "
        "ORDER BY p.id",
        (company,),
    ).fetchall()
    conn.close()

    matches = []
    seen_ids = set()
    for r in rows:
        if r["id"] in seen_ids:
            continue
        seen_ids.add(r["id"])
        matches.append({
            "id": r["id"], "name": r["name"], "employer": r["employer"],
            "title": r["title"], "desc": r["desc"], "matchCompany": r["match_company"],
        })
    return jsonify({"company": company, "matches": matches})


# ---- Professionals ----

def get_current_professional(req):
    token = get_bearer_token(req)
    if not token:
        return None
    email = verify_professional_token(token)
    if not email:
        return None
    conn = get_db()
    row = conn.execute("SELECT * FROM professionals WHERE email = ?", (email,)).fetchone()
    conn.close()
    return row


def get_clients(conn, professional_id):
    rows = conn.execute(
        "SELECT id, company FROM professional_clients WHERE professional_id = ? ORDER BY sort_order, id",
        (professional_id,),
    ).fetchall()
    return [{"id": r["id"], "company": r["company"]} for r in rows]


def professional_json(conn, row):
    return {
        "email": row["email"], "name": row["name"], "employer": row["employer"],
        "title": row["title"], "desc": row["desc"],
        "clients": get_clients(conn, row["id"]),
    }


@app.route("/api/professionals/request-code", methods=["POST"])
def professional_request_code():
    body = request.get_json(silent=True) or {}
    try:
        email = parse_any_email(body.get("email"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    conn = get_db()
    code = issue_code_for(conn, email)
    conn.close()

    response = {"email": email}
    if STUB_EMAIL:
        response["devCode"] = code
    return jsonify(response)


@app.route("/api/professionals/verify-code", methods=["POST"])
def professional_verify_code():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    code = (body.get("code") or "").strip()
    if not email or not code:
        return jsonify({"error": "Enter the code we sent you."}), 400

    conn = get_db()
    if not consume_code(conn, email, code):
        conn.close()
        return jsonify({"error": "That code is incorrect or has expired."}), 400

    row = conn.execute("SELECT * FROM professionals WHERE email = ?", (email,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO professionals (email, name, employer, title, desc, created_at) "
            "VALUES (?, '', '', '', '', ?)",
            (email, now_iso()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM professionals WHERE email = ?", (email,)).fetchone()

    profile = professional_json(conn, row)
    conn.close()

    token = issue_professional_token(email)
    return jsonify({"token": token, "profile": profile})


@app.route("/api/professionals/me", methods=["GET"])
def professional_me():
    professional = get_current_professional(request)
    if not professional:
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_db()
    profile = professional_json(conn, professional)
    conn.close()
    return jsonify(profile)


@app.route("/api/professionals/me", methods=["PUT"])
def professional_update():
    professional = get_current_professional(request)
    if not professional:
        return jsonify({"error": "Unauthorized"}), 401
    body = request.get_json(silent=True) or {}

    fields = {}
    for key in ("name", "employer", "title", "desc"):
        if key in body:
            fields[key] = str(body[key])[:2000]
    if not fields:
        conn = get_db()
        profile = professional_json(conn, professional)
        conn.close()
        return jsonify(profile)

    conn = get_db()
    conn.execute(
        "UPDATE professionals SET " + ", ".join(f"{k} = ?" for k in fields) + " WHERE id = ?",
        (*fields.values(), professional["id"]),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM professionals WHERE id = ?", (professional["id"],)).fetchone()
    profile = professional_json(conn, row)
    conn.close()
    return jsonify(profile)


@app.route("/api/professionals/me/clients", methods=["POST"])
def professional_add_client():
    professional = get_current_professional(request)
    if not professional:
        return jsonify({"error": "Unauthorized"}), 401
    body = request.get_json(silent=True) or {}
    company = (body.get("company") or "").strip()
    if not company:
        return jsonify({"error": "Company name is required."}), 400

    conn = get_db()
    next_order = conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM professional_clients WHERE professional_id = ?",
        (professional["id"],),
    ).fetchone()["n"]
    conn.execute(
        "INSERT INTO professional_clients (professional_id, company, sort_order) VALUES (?, ?, ?)",
        (professional["id"], company, next_order),
    )
    conn.commit()
    profile = professional_json(conn, professional)
    conn.close()
    return jsonify(profile)


@app.route("/api/professionals/me/clients/<int:client_id>", methods=["DELETE"])
def professional_remove_client(client_id):
    professional = get_current_professional(request)
    if not professional:
        return jsonify({"error": "Unauthorized"}), 401

    conn = get_db()
    conn.execute(
        "DELETE FROM professional_clients WHERE id = ? AND professional_id = ?",
        (client_id, professional["id"]),
    )
    conn.commit()
    profile = professional_json(conn, professional)
    conn.close()
    return jsonify(profile)


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
