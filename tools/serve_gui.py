#!/usr/bin/env python3
"""Serve the FreeRig710 frontend on localhost (trusted browser origin)."""
from __future__ import annotations

import argparse
import http.server
from pathlib import Path
import socketserver
import sys
import threading
import webbrowser


def frontend_directory() -> Path:
    """Return the bundled or source-tree frontend directory."""
    if getattr(sys, "frozen", False):
        bundle_root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
        return bundle_root / "frontend"
    return Path(__file__).resolve().parents[1] / "frontend"


class ReuseThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve FreeRig710 GUI on localhost")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="do not open the default browser automatically",
    )
    args = parser.parse_args()

    frontend = frontend_directory()
    if not frontend.is_dir():
        raise SystemExit(f"FreeRig710 frontend not found: {frontend}")

    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(frontend), **kw)
    server = ReuseThreadingServer(("127.0.0.1", args.port), handler)
    url = f"http://localhost:{args.port}/"

    print(f"FreeRig710 GUI: {url}")
    print("Default ESP32 backend: http://ft710.local (editable in Radio status)")
    print("Close this window or press Ctrl+C to stop the server.")

    if not args.no_browser:
        browser_timer = threading.Timer(0.4, webbrowser.open, args=(url,))
        browser_timer.daemon = True
        browser_timer.start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
