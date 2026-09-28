import os
import re
import secrets

from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

DOMAINS = {
    "stripe.com": "Stripe",
    "shopify.com": "Shopify",
    "delta.com": "Delta",
    "nike.com": "Nike",
}
PERSONAL_DOMAIN_RE = re.compile(r"gmail|yahoo|outlook|hotmail|icloud", re.IGNORECASE)
TOKEN_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


def _recruiter_serializer():
    secret = os.getenv("SECRET_KEY", "dev-secret-change-me")
    return URLSafeTimedSerializer(secret, salt="recruiter-session")


def _professional_serializer():
    secret = os.getenv("SECRET_KEY", "dev-secret-change-me")
    return URLSafeTimedSerializer(secret, salt="professional-session")


def parse_work_email(raw_email):
    """Returns (email, domain, company) or raises ValueError with a user-facing message."""
    email = (raw_email or "").strip().lower()
    if "@" not in email:
        raise ValueError("Enter a valid work email.")
    domain = email.split("@")[1]
    if not domain:
        raise ValueError("Enter a valid work email.")
    if PERSONAL_DOMAIN_RE.search(domain):
        raise ValueError("Personal email addresses can’t be verified. Use your company email.")
    company = DOMAINS.get(domain) or domain.split(".")[0].capitalize()
    return email, domain, company


def parse_any_email(raw_email):
    """Returns a normalized email or raises ValueError. No domain restriction."""
    email = (raw_email or "").strip().lower()
    domain = email.split("@")[1] if "@" in email else ""
    if "@" not in email or not domain:
        raise ValueError("Enter a valid email address.")
    return email


def generate_code():
    return "".join(secrets.choice("0123456789") for _ in range(6))


def issue_token(email):
    return _recruiter_serializer().dumps({"email": email})


def verify_token(token):
    try:
        data = _recruiter_serializer().loads(token, max_age=TOKEN_MAX_AGE)
        return data.get("email")
    except (BadSignature, SignatureExpired):
        return None


def issue_professional_token(email):
    return _professional_serializer().dumps({"email": email})


def verify_professional_token(token):
    try:
        data = _professional_serializer().loads(token, max_age=TOKEN_MAX_AGE)
        return data.get("email")
    except (BadSignature, SignatureExpired):
        return None


def get_bearer_token(request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    return auth[7:]
