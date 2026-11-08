"""Fail-closed admission of the exact public reference bytes used for FIX rules."""
import hashlib
import re
import urllib.error
import urllib.parse
import urllib.request

MAX_REFERENCE_BYTES = 16 * 1024 * 1024
OFFICIAL_HOSTS = frozenset({"fixtrading.org", "www.fixtrading.org"})
class PreflightError(ValueError):
    """Fixed code only; never include an upstream response body."""
    def __init__(self, code):
        super().__init__(code)

def validate_url(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != "https" or parsed.hostname not in OFFICIAL_HOSTS
            or parsed.username is not None or parsed.password is not None
            or parsed.port not in (None,443) or parsed.fragment):
            raise PreflightError("REFERENCE_ORIGIN")
    except (ValueError, TypeError):
        raise PreflightError("REFERENCE_ORIGIN") from None
    return url

class OwnedRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        old = urllib.parse.urlsplit(req.full_url)
        new = urllib.parse.urlsplit(newurl)
        if old.hostname != new.hostname:
            raise PreflightError("REFERENCE_REDIRECT")
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def validate_reference(status, content_type, payload, expected_sha256, kind):
    if kind != "pdf" or not isinstance(expected_sha256,str) or not re.fullmatch(r"[a-f0-9]{64}",expected_sha256):
        raise PreflightError("REFERENCE_PIN")
    if status != 200:
        raise PreflightError("REFERENCE_STATUS")
    if not isinstance(payload,bytes) or not 1024 <= len(payload) <= MAX_REFERENCE_BYTES:
        raise PreflightError("REFERENCE_SIZE")
    if not isinstance(content_type,str) or content_type.split(";",1)[0].strip().lower() != "application/pdf":
        raise PreflightError("REFERENCE_TYPE")
    if not payload.startswith(b"%PDF-") or not payload.rstrip().endswith(b"%%EOF"):
        raise PreflightError("REFERENCE_PDF")
    digest=hashlib.sha256(payload).hexdigest()
    if digest != expected_sha256:
        raise PreflightError("REFERENCE_HASH")
    return {"bytes":len(payload),"sha256":digest}

def checked_download(url, expected_sha256):
    validate_url(url)
    try:
        with urllib.request.build_opener(OwnedRedirects()).open(url,timeout=30) as response:
            length=response.headers.get("Content-Length")
            if length is not None and (not length.isdecimal() or int(length)>MAX_REFERENCE_BYTES):
                raise PreflightError("REFERENCE_SIZE")
            payload=response.read(MAX_REFERENCE_BYTES+1)
            validate_reference(response.status,response.headers.get("Content-Type"),payload,expected_sha256,"pdf")
            return payload
    except PreflightError:
        raise
    except (OSError,ValueError,urllib.error.URLError):
        raise PreflightError("REFERENCE_UNAVAILABLE") from None
