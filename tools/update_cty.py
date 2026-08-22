#!/usr/bin/env python3
"""Fetch an AD1C CTY.DAT snapshot for the FreeRig710 static frontend."""
from __future__ import annotations

import argparse
import hashlib
import os
import pathlib
import tempfile
import urllib.error
import urllib.request

DEFAULT_URLS = (
    "https://www.country-files.com/bigcty/cty.dat",
    "https://www.country-files.com/cty/cty.dat",
    # Known-good Debian/WSJT-X snapshot fallback. The official AD1C URLs above
    # are always tried first so normal deployments get current data.
    "https://sources.debian.org/data/main/w/wsjtx-improved/3.1.0%2B260228%2Brepack-1~bpo13%2B1/cty.dat",
)


def fetch(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "FreeRig710-CTY-Updater/1.0", "Accept": "text/plain,*/*;q=0.5"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def valid(data: bytes) -> bool:
    # Real CTY.DAT files are comfortably over 100 kB and contain the standard
    # colon-delimited entity header plus semicolon-terminated prefix lists.
    return len(data) >= 100_000 and data.count(b":") > 1_000 and data.count(b";") > 200


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", nargs="?", default="frontend/cty.dat")
    parser.add_argument("--url", action="append", dest="urls", help="override source URL (repeatable)")
    args = parser.parse_args()

    destination = pathlib.Path(args.destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    urls = tuple(args.urls or DEFAULT_URLS)
    errors: list[str] = []
    data = b""
    used_url = ""
    for url in urls:
        try:
            candidate = fetch(url)
            if not valid(candidate):
                raise ValueError(f"downloaded file failed CTY sanity checks ({len(candidate)} bytes)")
            data = candidate
            used_url = url
            break
        except Exception as exc:  # keep trying mirrors; print detail only on total failure
            errors.append(f"{url}: {exc}")

    if not data:
        raise SystemExit("Unable to download a valid CTY.DAT:\n  " + "\n  ".join(errors))

    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as tmp:
        tmp.write(data)
        tmp.flush()
        os.fsync(tmp.fileno())
        temp_name = tmp.name
    os.replace(temp_name, destination)

    digest = hashlib.sha256(data).hexdigest()
    print(f"Updated {destination} ({len(data)} bytes)")
    print(f"Source: {used_url}")
    print(f"SHA-256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
