"""Serve extension/ at http://localhost:4477 for the dev page (see README).

Like `python3 -m http.server`, but with caching disabled so the browser never
runs a stale module after an edit.
"""

import functools
import http.server
from pathlib import Path

PORT = 4477
ROOT = Path(__file__).parent / "extension"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as server:
        print(f"Snack dev page: http://localhost:{PORT}/app.html")
        server.serve_forever()
