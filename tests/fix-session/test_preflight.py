"""Admission controls: malformed or unpinned public inputs must never pass preflight."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
class PreflightTests(unittest.TestCase):
    def module(self):
        path = ROOT / "tools/fix-session/preflight.py"
        self.assertTrue(path.is_file(), "reference admission is not implemented")
        spec = importlib.util.spec_from_file_location("fix_preflight", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_exact_pdf_identity(self):
        m = self.module()
        payload = b"%PDF-1.7\n" + b"x" * 2048 + b"\n%%EOF\n"
        result = m.validate_reference(200, "application/pdf", payload, hashlib.sha256(payload).hexdigest(), "pdf")
        self.assertEqual(result, {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})

    def test_challenge_is_not_a_reference(self):
        m = self.module()
        for status in [200, 202, 301, 403, 429, 500]:
            with self.subTest(status=status):
                payload = b"<html>Robot Challenge Screen</html>"
                with self.assertRaises(m.PreflightError):
                    m.validate_reference(status, "text/html", payload, hashlib.sha256(payload).hexdigest(), "pdf")

    def test_non_200_pdf_refused(self):
        m = self.module()
        payload = b"%PDF-1.7\n" + b"x"*2048 + b"\n%%EOF"
        for status in [202, 206, 301, 403]:
            with self.subTest(status=status), self.assertRaises(m.PreflightError):
                m.validate_reference(status, "application/pdf", payload, hashlib.sha256(payload).hexdigest(), "pdf")

    def test_magic_and_trailer_are_required(self):
        m = self.module()
        for payload in [b"", b"%PDF-1.7", b"x"*2048+b"%%EOF", b"%PDF-1.7"+b"x"*2048]:
            with self.subTest(size=len(payload)), self.assertRaises(m.PreflightError):
                m.validate_reference(200,"application/pdf",payload,hashlib.sha256(payload).hexdigest(),"pdf")

    def test_wrong_hash_refused(self):
        m = self.module()
        payload = b"%PDF-1.7\n"+b"x"*2048+b"\n%%EOF"
        with self.assertRaises(m.PreflightError):
            m.validate_reference(200,"application/pdf",payload,"0"*64,"pdf")

    def test_oversize_refused(self):
        m = self.module()
        payload=b"%PDF-1.7\n"+b"x"*(16*1024*1024)+b"\n%%EOF"
        with self.assertRaises(m.PreflightError):
            m.validate_reference(200,"application/pdf",payload,hashlib.sha256(payload).hexdigest(),"pdf")

    def test_malformed_hash_and_kind_refused(self):
        m = self.module()
        for digest,kind in [("", "pdf"),("A"*64,"pdf"),("x"*64,"pdf"),("0"*64,"exe")]:
            with self.subTest(digest=digest,kind=kind),self.assertRaises(m.PreflightError):
                m.validate_reference(200,"application/pdf",b"%PDF-1.7\n"+b"x"*2048+b"\n%%EOF",digest,kind)

    def test_url_ownership(self):
        m=self.module()
        allowed="https://fixtrading.org/packages/fix-session-layer-test-cases/?wpdmdl=2736"
        self.assertEqual(m.validate_url(allowed),allowed)
        for url in ["http://fixtrading.org/x","file:///etc/passwd","https://127.0.0.1/x","https://fixtrading.org.evil.invalid/x","https://user:pw@fixtrading.org/x","https://fixtrading.org:444/x","https://fixtrading.org/x#token"]:
            with self.subTest(url=url),self.assertRaises(m.PreflightError):m.validate_url(url)

    def test_cross_origin_redirect_refused(self):
        m=self.module()
        handler=m.OwnedRedirects()
        with self.assertRaises(m.PreflightError):
            handler.redirect_request(__import__("urllib.request").request.Request("https://fixtrading.org/x"),None,302,"",{},"https://repo.maven.apache.org/x")

    def test_no_raw_error_body_in_diagnostics(self):
        m=self.module()
        secret=b"PRIVATE_TEST_VALUE"
        try:
            m.validate_reference(202,"text/html",secret,"0"*64,"pdf")
        except m.PreflightError as error:self.assertNotIn(secret.decode(),str(error))
        else:self.fail("challenge was accepted")

if __name__ == "__main__":unittest.main()
