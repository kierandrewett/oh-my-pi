#!/usr/bin/env python3
"""Resolve the latest stable upstream release and decide whether to build it."""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def api(path, allow_missing=False):
    request = urllib.request.Request(
        "https://api.github.com/" + path,
        headers={"Accept": "application/vnd.github+json", "Authorization": "Bearer " + os.environ["GH_TOKEN"],
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "omp-fork-release"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if allow_missing and error.code == 404:
            return None
        raise


if os.environ["GITHUB_REF"] != "refs/heads/" + os.environ["DEFAULT_BRANCH"]:
    raise SystemExit("Fork releases must run from the default branch")
if os.environ["GITHUB_REPOSITORY"] != "kierandrewett/oh-my-pi":
    raise SystemExit("This workflow may only publish to kierandrewett/oh-my-pi")
upstream = api("repos/can1357/oh-my-pi/releases/latest")
tag = upstream["tag_name"]
if upstream["draft"] or upstream["prerelease"] or not re.fullmatch(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", tag):
    raise SystemExit(f"Latest upstream release is not a stable semver release: {tag!r}")
revision = Path("scripts/fork/revision").read_text().strip()
if not re.fullmatch(r"[1-9][0-9]*", revision):
    raise SystemExit("scripts/fork/revision must contain a positive integer")
fork_tag = f"{tag}-fork.{revision}"
existing = api("repos/kierandrewett/oh-my-pi/releases/tags/" + urllib.parse.quote(fork_tag, safe=""), True)
if existing:
    if existing["draft"] or existing["prerelease"]:
        raise SystemExit(f"Release {fork_tag} exists but is a draft or prerelease; inspect it before retrying")
    assets = {asset["name"] for asset in existing["assets"] if asset["state"] == "uploaded" and asset["size"] > 0}
    if not {"omp-linux-x64", "SHA256SUMS.txt"}.issubset(assets):
        raise SystemExit(f"Published release {fork_tag} is missing required assets; inspect it")
elif api("repos/kierandrewett/oh-my-pi/git/ref/tags/" + urllib.parse.quote(fork_tag, safe=""), True):
    raise SystemExit(f"Tag {fork_tag} already exists without a release; inspect it before retrying")
with open(os.environ["GITHUB_OUTPUT"], "a") as output:
    print(f"upstream_tag={tag}", file=output)
    print(f"fork_tag={fork_tag}", file=output)
    print(f"build={'false' if existing else 'true'}", file=output)
print(f"Upstream {tag}; fork {fork_tag}; {'already published' if existing else 'building'}")
