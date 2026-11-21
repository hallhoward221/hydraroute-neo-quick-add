#!/usr/bin/env python3
"""Tiny mock of the HRweb API for local development.

This is NOT the real HRweb. It mimics the parts used by the extension:
login, session cookie, csrf cookie, config.get / config.save and a restart delay.
"""

import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
EXT_ROOT = os.path.dirname(ROOT)

DEFAULT_DOMAIN_FILE = "\n".join([
    "##Youtube",
    "youtube.com,googlevideo.com/HydraRoute",
    "",
    "##Discord",
    "discord.com/HydraRoute",
    "",
    "##OpenAI",
    "openai.com,chatgpt.com/HydraRoute",
    "",
])

STATE = {
    "domainFile": DEFAULT_DOMAIN_FILE,
    "cidrFile": "",
    "cidrEnabled": False,
    "restartCount": 0,
    "lastSaveAt": 0,
    "log": [],
}

LOCK = threading.Lock()
SESSION = "mock-session-ok"
CSRF = "mock-csrf-ok"


class Handler(BaseHTTPRequestHandler):
    server_version = "HRwebMock/1.0"

    def log_message(self, fmt, *args):
        pass

    def _log(self, body=b""):
        with LOCK:
            STATE["log"].append({
                "method": self.command,
                "path": self.path,
                "headers": {k: v for k, v in self.headers.items()},
                "body": body.decode("utf-8", "replace")[:4000],
                "at": time.time(),
            })
            if len(STATE["log"]) > 200:
                STATE["log"] = STATE["log"][-200:]

    def _json(self, code, payload, cookies=None):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for cookie in cookies or []:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def _same_origin(self):
        origin = self.headers.get("Origin")
        referer = self.headers.get("Referer")
        host = self.headers.get("Host", "")
        if not origin and not referer:
            return True
        if origin:
            return origin.split("://", 1)[-1].rstrip("/") == host
        if referer:
            return urlparse(referer).netloc == host
        return False

    def _session_ok(self):
        return f"app_session={SESSION}" in (self.headers.get("Cookie") or "")

    def _csrf_ok(self):
        return (self.headers.get("X-CSRF") or "") == CSRF

    def _read_body(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        return self.rfile.read(length) if length else b""

    def do_OPTIONS(self):
        self._log()
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-CSRF")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        self._log()

        if path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"<html><body><h1>HRweb mock</h1></body></html>")
            return

        if path == "/page":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"<html><head><title>Mock site</title></head><body><h1>Mock site</h1></body></html>")
            return

        if path == "/slow":
            time.sleep(5)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"<html><head><title>Slow site</title></head><body><h1>Slow site</h1></body></html>")
            return

        if path == "/rkn/":
            query = parse_qs(urlparse(self.path).query)
            domain = (query.get("data") or [""])[0].strip().lower()

            if domain == "challenge.test":
                name = "mock_rkn_challenge.html"
                match = ""
            elif domain in ("instagram.com", "youtube.com", "example.org", "127.0.0.1.nip.io"):
                name = "mock_rkn_found.html"
                match = "*." + domain
            else:
                name = "mock_rkn_not_found.html"
                match = ""

            body = open(os.path.join(ROOT, name), encoding="utf-8").read()
            body = body.replace("{{domain}}", domain).replace("{{match}}", match)

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
            return

        if path == "/test":
            self._serve_file(os.path.join(ROOT, "api_test.html"), "text/html; charset=utf-8")
            return
        if path == "/test.js":
            self._serve_file(os.path.join(ROOT, "api_test.js"), "application/javascript; charset=utf-8")
            return
        if path.startswith("/lib/"):
            name = path[len("/lib/"):]
            safe = os.path.basename(name)
            self._serve_file(os.path.join(EXT_ROOT, "lib", safe), "application/javascript; charset=utf-8")
            return

        if path == "/state":
            with LOCK:
                payload = {
                    "domainFile": STATE["domainFile"],
                    "cidrFile": STATE["cidrFile"],
                    "cidrEnabled": STATE["cidrEnabled"],
                    "restartCount": STATE["restartCount"],
                }
            self._json(200, payload)
            return

        if path == "/dump":
            with LOCK:
                payload = list(STATE["log"])
            self._json(200, payload)
            return

        self._json(404, {"error": "not found"})

    def do_POST(self):
        body = self._read_body()
        self._log(body)
        path = urlparse(self.path).path

        if path == "/login":
            form = parse_qs(body.decode("utf-8", "replace"))
            login = (form.get("login") or [""])[0]
            password = (form.get("password") or [""])[0]
            if login == "admin" and password == "secret":
                self._json(
                    200,
                    {"success": True},
                    [
                        f"app_session={SESSION}; Path=/; SameSite=Strict",
                        f"csrf={CSRF}; Path=/; SameSite=Strict",
                    ],
                )
            else:
                self._json(200, {"success": False, "error": "РќРµРІРµСЂРЅС‹Р№ Р»РѕРіРёРЅ РёР»Рё РїР°СЂРѕР»СЊ"})
            return

        if path == "/reset":
            with LOCK:
                STATE["domainFile"] = DEFAULT_DOMAIN_FILE
                STATE["cidrFile"] = ""
                STATE["cidrEnabled"] = False
                STATE["restartCount"] = 0
                STATE["log"] = []
            self._json(200, {"ok": True})
            return

        if path == "/api":
            if not self._same_origin():
                self._json(403, {"ok": False, "error": "forbidden origin"})
                return
            if not self._csrf_ok():
                self._json(403, {"ok": False, "error": "invalid csrf token"})
                return
            if not self._session_ok():
                self._json(401, {"ok": False, "error": "unauthorized"})
                return

            try:
                request = json.loads(body.decode("utf-8", "replace"))
            except Exception:
                self._json(400, {"ok": False, "error": "bad request body"})
                return

            method = request.get("m")
            params = request.get("p") or {}

            if method == "system.ping":
                self._json(200, {"ok": True, "data": {"status": "ok"}})
                return
            if method == "system.info":
                self._json(200, {"ok": True, "data": {"hrweb": "1.68.0-mock", "hrneo": "3.24.2-mock"}})
                return
            if method == "config.get":
                with LOCK:
                    payload = {
                        "domainFile": STATE["domainFile"],
                        "cidrFile": STATE["cidrFile"],
                        "cidrEnabled": STATE["cidrEnabled"],
                    }
                self._json(200, {"ok": True, "data": payload})
                return
            if method == "hrneo.config.get":
                self._json(200, {"ok": True, "data": {"config": {"policyOrder": "HydraRoute"}, "defaults": {}}})
                return
            if method == "config.save":
                domain_file = params.get("domainFile")
                cidr_file = params.get("cidrFile")
                if not isinstance(domain_file, str):
                    self._json(200, {"ok": False, "error": "domainFile is required"})
                    return
                time.sleep(0.8)
                with LOCK:
                    STATE["domainFile"] = domain_file
                    if isinstance(cidr_file, str):
                        STATE["cidrFile"] = cidr_file
                    STATE["restartCount"] += 1
                    STATE["lastSaveAt"] = time.time()
                self._json(200, {"ok": True, "data": {"warning": None}})
                return

            self._json(200, {"ok": False, "error": "unknown method: " + str(method)})
            return

        self._json(404, {"error": "not found"})

    def _serve_file(self, path, content_type):
        try:
            data = open(path, "rb").read()
        except OSError:
            self._json(404, {"error": "file not found"})
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"HRweb mock listening on http://127.0.0.1:{args.port}", flush=True)
    print("login: admin / secret", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

