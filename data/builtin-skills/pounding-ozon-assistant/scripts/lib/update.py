"""Skill auto-update from COS — version check + file download.

All network calls are best-effort: if COS is unreachable the skill continues
to work normally with locally-installed files.  No automatic downloads happen
without explicit user action (``pounding-ozon update``).

Opt-out: set ``POUNDING_SKIP_UPDATE_CHECK=1`` in the environment.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any

import requests

from scripts._const import (
    SKILL_VERSION,
    SKILL_ROOT,
    COS_VERSION_URL,
    COS_DOWNLOAD_BASE,
    SKIP_UPDATE_CHECK,
    UPDATE_CACHE_TTL,
)

logger = logging.getLogger(__name__)

# Session-level guard — only notify once per process lifetime.
# The cache (24h TTL) already prevents duplicate network calls; this
# prevents the banner from printing multiple times in one session.
_notified_this_session = False

# Files / glob patterns that must NEVER be overwritten during an update.
_PROTECTED_PATTERNS = (
    ".env",
    "*.env",
    "runtime_config*.json",
    "data/**",
    ".git/**",
    "__pycache__/**",
    "*.pyc",
    "scripts/dev/**",
    "contracts/**",
)

# Files that are essential for bootstrap.  If any of these are missing the
# skill is considered not-yet-bootstrapped.
_BOOTSTRAP_ESSENTIALS = (
    "scripts/lib/cloud_client.py",
    "scripts/cli.py",
    "pyproject.toml",
)


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------


def _cache_path() -> Path:
    """Local version-check cache file (survives skill reinstalls)."""
    d = Path.home() / ".pounding"
    d.mkdir(parents=True, exist_ok=True)
    return d / "update_cache.json"


def _notified_version_path() -> Path:
    """Track which version upgrade we already notified about."""
    d = Path.home() / ".pounding"
    d.mkdir(parents=True, exist_ok=True)
    return d / "update_notified.json"


def _read_cache() -> dict[str, Any] | None:
    """Read cached version info.  Returns None if expired or missing."""
    cp = _cache_path()
    if not cp.exists():
        return None
    try:
        data = json.loads(cp.read_text(encoding="utf-8"))
    except Exception:
        return None

    checked_at = data.get("checked_at", 0)
    if time.time() - checked_at > UPDATE_CACHE_TTL:
        return None
    return data


def _write_cache(data: dict[str, Any]) -> None:
    """Persist version-check result with timestamp."""
    data["checked_at"] = int(time.time())
    try:
        _cache_path().write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:
        pass  # best-effort


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def check_skill_version() -> dict[str, Any]:
    """Fetch COS version.json and compare with local SKILL_VERSION.

    Returns::

        {
            'update_available': bool,
            'current_version': str,
            'latest_version': str,
            'changed_files': list[str],
            'release_notes': str,
            'error': str | None,
        }

    This function is **non-blocking** — any network / parse error results in
    ``update_available=False`` with a non-null ``error`` field.

    Results are cached locally for ``UPDATE_CACHE_TTL`` seconds to avoid
    hammering COS on every import.
    """
    if SKIP_UPDATE_CHECK:
        return {
            "update_available": False,
            "current_version": SKILL_VERSION,
            "latest_version": SKILL_VERSION,
            "changed_files": [],
            "release_notes": "",
            "error": "skipped (POUNDING_SKIP_UPDATE_CHECK=1)",
        }

    # Serve from cache when fresh
    cached = _read_cache()
    if cached is not None:
        cached.setdefault("error", None)
        cached.setdefault("changed_files", [])
        cached.setdefault("release_notes", "")
        return cached

    try:
        resp = requests.get(COS_VERSION_URL, timeout=15)
        resp.raise_for_status()
        manifest = resp.json()
    except Exception as exc:
        result: dict[str, Any] = {
            "update_available": False,
            "current_version": SKILL_VERSION,
            "latest_version": SKILL_VERSION,
            "changed_files": [],
            "release_notes": "",
            "error": f"无法获取版本信息: {exc}",
        }
        _write_cache(result)
        return result

    latest = manifest.get("version", SKILL_VERSION)
    files = manifest.get("files", {})
    changed_files = _compute_changed(files)

    result = {
        "update_available": latest != SKILL_VERSION and len(changed_files) > 0,
        "current_version": SKILL_VERSION,
        "latest_version": latest,
        "changed_files": changed_files,
        "release_notes": manifest.get("release_notes", ""),
        "error": None,
    }
    _write_cache(result)
    return result


def download_skill_update(changed_files: list[str]) -> dict[str, Any]:
    """Download changed files from COS and atomically replace local copies.

    Each file's SHA256 is verified against the version manifest.
    Protected files (``.env``, ``data/``, etc.) are never overwritten.

    Returns::

        {'updated': list[str], 'failed': list[str], 'error': str | None}
    """
    if not changed_files:
        return {"updated": [], "failed": [], "error": "没有需要更新的文件"}

    # Re-fetch manifest for checksums
    try:
        resp = requests.get(COS_VERSION_URL, timeout=15)
        resp.raise_for_status()
        manifest = resp.json()
    except Exception as exc:
        return {"updated": [], "failed": list(changed_files), "error": f"无法获取版本清单: {exc}"}

    file_checksums: dict[str, str] = manifest.get("files", {})
    updated: list[str] = []
    failed: list[str] = []

    for rel_path in changed_files:
        if _is_protected(rel_path):
            logger.info("update: skipping protected file %s", rel_path)
            continue

        expected_sha = file_checksums.get(rel_path, "")

        try:
            # Download with ?version= param for cache-busting
            version = manifest.get("version", "latest")
            url = f"{COS_DOWNLOAD_BASE}/{rel_path}?version={version}"
            dl_resp = requests.get(url, timeout=30)
            dl_resp.raise_for_status()
            content = dl_resp.content

            # Verify checksum
            if expected_sha:
                actual_sha = hashlib.sha256(content).hexdigest()
                expected_clean = expected_sha.replace("sha256:", "").strip()
                if actual_sha != expected_clean:
                    failed.append(rel_path)
                    logger.warning(
                        "update: checksum mismatch for %s (expected %s, got %s)",
                        rel_path, expected_clean[:16], actual_sha[:16],
                    )
                    continue

            # Atomic write: temp file → os.replace
            target = SKILL_ROOT / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)

            fd, tmp_path = tempfile.mkstemp(
                dir=str(target.parent), prefix=".update-"
            )
            try:
                os.write(fd, content)
            finally:
                os.close(fd)

            os.replace(tmp_path, str(target))
            updated.append(rel_path)

        except Exception as exc:
            failed.append(rel_path)
            logger.warning("update: download failed for %s: %s", rel_path, exc)

    return {
        "updated": updated,
        "failed": failed,
        "error": None if not failed else f"{len(failed)} 个文件更新失败",
    }


def bootstrap_skill() -> dict[str, Any]:
    """First-run bootstrap: download ALL skill files from COS.

    Called when ``SKILL_VERSION == '0.0.0'`` (bootstrap marker) or when
    essential files (``cloud_client.py``, ``cli.py``, etc.) are missing.

    Returns::

        {'ok': bool, 'downloaded': int, 'failed': list[str], 'error': str | None}
    """
    try:
        resp = requests.get(COS_VERSION_URL, timeout=15)
        resp.raise_for_status()
        manifest = resp.json()
    except Exception as exc:
        return {"ok": False, "downloaded": 0, "failed": [], "error": f"无法连接 COS: {exc}"}

    all_files = list(manifest.get("files", {}).keys())
    if not all_files:
        return {"ok": False, "downloaded": 0, "failed": [], "error": "版本清单为空"}

    result = download_skill_update(all_files)
    return {
        "ok": len(result["updated"]) > 0,
        "downloaded": len(result["updated"]),
        "failed": result["failed"],
        "error": result.get("error"),
    }


def check_and_notify() -> None:
    """Non-blocking update check → console notification (once per version).

    Called at import time.  Cached for 24h; the same version notification
    is suppressed on subsequent calls within the same cache TTL.
    No files are downloaded automatically.
    """
    global _notified_this_session
    if _notified_this_session:
        return

    try:
        info = check_skill_version()
    except Exception:
        return  # best-effort

    if not info.get("update_available"):
        return

    # Suppress duplicate notifications for the same version.
    # Read cache BEFORE check_skill_version writes it — the "notified"
    # version is tracked separately from the network response cache.
    notified_key = f"{info['current_version']}->{info['latest_version']}"
    notified_cache = _notified_version_path()
    if notified_cache.exists():
        try:
            data = json.loads(notified_cache.read_text(encoding='utf-8'))
            if data.get('key') == notified_key:
                return  # already notified for this upgrade
        except Exception:
            pass
    # Mark as notified
    try:
        notified_cache.write_text(
            json.dumps({'key': notified_key, 'time': int(time.time())}, ensure_ascii=False),
            encoding='utf-8',
        )
    except Exception:
        pass

    _notified_this_session = True

    latest = info.get("latest_version", "?")
    current = info.get("current_version", "?")
    notes = info.get("release_notes", "")

    msg = (
        f"\n📦 pounding-ozon 新版本可用: v{latest} (当前: v{current})\n"
        f"   更新内容: {notes}\n"
        f"   运行 'python3 cli.py update' 或 'pounding-ozon update' 升级\n"
    )
    # Use print (not logger) so it's visible to the user in their terminal
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

import fnmatch
import sys


def _is_protected(rel_path: str) -> bool:
    """Check whether *rel_path* matches any protected glob pattern."""
    for pat in _PROTECTED_PATTERNS:
        if fnmatch.fnmatch(rel_path, pat):
            return True
        # Also match if any path component matches
        parts = rel_path.replace("\\", "/").split("/")
        for part in parts:
            if fnmatch.fnmatch(part, pat):
                return True
    return False


def _compute_changed(remote_files: dict[str, str]) -> list[str]:
    """Compare remote checksums with local files.

    Returns list of relative paths that differ (new, changed, or missing locally).
    """
    changed: list[str] = []
    for rel_path, remote_sha in remote_files.items():
        if _is_protected(rel_path):
            continue
        local_path = SKILL_ROOT / rel_path
        if not local_path.exists():
            changed.append(rel_path)
            continue

        try:
            local_hash = hashlib.sha256(local_path.read_bytes()).hexdigest()
        except Exception:
            changed.append(rel_path)
            continue

        remote_clean = remote_sha.replace("sha256:", "").strip()
        if local_hash != remote_clean:
            changed.append(rel_path)

    return changed
