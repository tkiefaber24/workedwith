from supabase_client import get_supabase

RESUME_BUCKET = "resumes"
SIGNED_URL_TTL_SECONDS = 300

ALLOWED_RESUME_MIME = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
}
MAX_RESUME_BYTES = 10 * 1024 * 1024  # 10 MB


def resume_object_path(professional_id, extension):
    return f"{professional_id}/resume.{extension}"


def upload_resume(professional_id, file_bytes, content_type, extension):
    path = resume_object_path(professional_id, extension)
    get_supabase().storage.from_(RESUME_BUCKET).upload(
        path, file_bytes,
        file_options={"content-type": content_type, "upsert": "true"},
    )
    return path


def signed_resume_url(path):
    result = get_supabase().storage.from_(RESUME_BUCKET) \
        .create_signed_url(path, SIGNED_URL_TTL_SECONDS)
    return result.get("signedURL") or result.get("signedUrl") or result.get("signed_url")
