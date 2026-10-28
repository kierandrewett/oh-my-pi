#!/usr/bin/env python3
"""Stamp the CLI-visible version without changing native ABI or dependency versions."""
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
upstream, fork = sys.argv[2:4]
if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", upstream) or not re.fullmatch(re.escape(upstream) + r"-fork\.[1-9][0-9]*", fork):
    raise SystemExit("Invalid release version")
manifest = root / "packages/utils/package.json"
text = manifest.read_text()
pattern = r'("version"\s*:\s*")' + re.escape(upstream[1:]) + r'("\s*[,}])'
updated, count = re.subn(pattern, lambda match: match.group(1) + fork[1:] + match.group(2), text, count=1)
if count != 1 or json.loads(text)["version"] != upstream[1:]:
    raise SystemExit("utils version does not match upstream release")
manifest.write_text(updated)
