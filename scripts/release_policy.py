"""Release policy shared by the Python workflow steps; no API calls at import time."""

import json
import re
import subprocess
from urllib.parse import quote


_NUMBER = r"(?:0|[1-9]\d*)"
_SOURCE_VERSION = re.compile(rf"({_NUMBER}\.{_NUMBER}\.{_NUMBER})(?:-rc\.{_NUMBER})?")
_NIGHTLY_TAG = re.compile(r"v\d+\.\d+\.\d+-nightly\.\d{8}(?:\.\d+)?")
_SHA = re.compile(r"[0-9a-f]{40}")


def nightly_releases(releases):
    """Use the same canonical tags for previous-release discovery and retention."""
    return sorted(
        (release for release in releases
         if release["prerelease"] and not release["draft"]
         and _NIGHTLY_TAG.fullmatch(release["tag_name"])),
        key=lambda release: release["published_at"], reverse=True,
    )


def next_nightly_tag(version, date, occupied):
    """An RC on main still produces X.Y.Z-nightly tags, not RC-nightly hybrids."""
    source = _SOURCE_VERSION.fullmatch(version)
    if not source or not re.fullmatch(r"\d{8}", date):
        raise ValueError("Invalid nightly source version or UTC date")
    base = f"v{source[1]}-nightly.{date}"
    same_day = re.compile(re.escape(base) + r"(?:\.(\d+))?")
    suffixes = [int(match[1] or 0) for tag in occupied
                if (match := same_day.fullmatch(tag))]
    # Never fill suffix gaps: deleted immutable tags cannot be reused either.
    return f"{base}.{max(suffixes) + 1}" if suffixes else base


def _github_json(endpoint):
    return json.loads(subprocess.check_output(["gh", "api", endpoint], text=True))


def verify_tag_commit(repository, tag, planned_sha, fetch=None):
    """Resolve the remote ref, peel nested annotated tags, and fail closed on moves."""
    if not _SHA.fullmatch(planned_sha):
        raise ValueError("Invalid planned commit SHA")
    fetch = fetch or _github_json
    prefix = f"repos/{repository}/git"
    value = fetch(f"{prefix}/ref/tags/{quote(tag, safe='')}")["object"]
    seen = set()
    while value["type"] == "tag":
        sha = value["sha"]
        if not _SHA.fullmatch(sha) or sha in seen:
            raise ValueError("Invalid or cyclic annotated tag")
        seen.add(sha)
        value = fetch(f"{prefix}/tags/{sha}")["object"]
    if value["type"] != "commit" or value["sha"] != planned_sha:
        raise ValueError(f"Remote tag {tag} does not match planned commit {planned_sha}")
    return planned_sha
