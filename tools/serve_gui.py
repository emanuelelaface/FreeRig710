#!/usr/bin/env python3
"""Serve the FreeRig710 frontend on localhost (trusted browser origin)."""
from __future__ import annotations

import argparse
import http.server
from pathlib import Path
import socketserver

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"

class ReuseThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve FreeRig710 GUI on localhost")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(FRONTEND), **kw)
    server = ReuseThreadingServer(("127.0.0.1", args.port), handler)
    print(f"FreeRig710 GUI: http://localhost:{args.port}/")
    print("Default ESP32 backend: http://ft710.local (editable in Radio status)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == "__main__":
    main()
