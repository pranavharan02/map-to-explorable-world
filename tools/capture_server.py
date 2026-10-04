"""Receive canvas captures from the app and save them to disk.

    python tools/capture_server.py [out_dir] [port]

The app's `window.__world.cap(name)` renders a few frames and POSTs the canvas as a JPEG to
http://127.0.0.1:5197/save?name=<name>.jpg. Useful when a test harness drives the page without a visible window.
"""
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "caps"))
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 5197
os.makedirs(OUT, exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        name = parse_qs(urlparse(self.path).query).get("name", ["capture.jpg"])[0]
        name = os.path.basename(name)                      # no paths from the client
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(b"ok")
        print(f"saved {name} ({len(data) // 1024} KB)")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"capture server on http://127.0.0.1:{PORT}, saving to {OUT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
