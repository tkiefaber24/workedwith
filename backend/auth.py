import re

DOMAINS = {
    "stripe.com": "Stripe",
    "shopify.com": "Shopify",
    "delta.com": "Delta",
    "nike.com": "Nike",
}
PERSONAL_DOMAIN_RE = re.compile(r"gmail|yahoo|outlook|hotmail|icloud", re.IGNORECASE)


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


def get_bearer_token(request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    return auth[7:]
