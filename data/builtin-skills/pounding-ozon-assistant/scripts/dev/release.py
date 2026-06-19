#!/usr/bin/env python3
"""Release a new skill version to COS.

Usage:
  python3 scripts/dev/release.py 0.2.0 [--bucket ...] [--region ...] [--dry-run]

Environment variables (COS credentials):
  COS_SECRET_ID   — Tencent Cloud SecretId
  COS_SECRET_KEY  — Tencent Cloud SecretKey
  COS_BUCKET      — COS bucket name (e.g. pounding-ozon-1307121545)
  COS_REGION      — COS region (e.g. ap-guangzhou)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests

# ── Resolve paths ──
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent.parent  # pounding-ozon-assistant/

# ── Files to include in the distribution ──
INCLUDE_PATTERNS = (
    "scripts/**/*.py",
    "scripts/**/*.json",
    "pyproject.toml",
    "SKILL.md",
)

# Files / patterns to exclude from distribution
EXCLUDE_PATTERNS = (
    "scripts/dev/**",
    "scripts/data/**",
    "scripts/**/__pycache__/**",
    "scripts/**/*.pyc",
    "data/**",
    ".env",
    "*.env",
    ".git/**",
    ".pytest_cache/**",
    "contracts/**",
    "dist/**",
    "build/**",
    "*.egg-info/**",
)


def _collect_files() -> dict[str, Path]:
    """Walk SKILL_ROOT and collect distributable files.

    Returns {relative_path: absolute_path}.
    """
    import fnmatch

    files: dict[str, Path] = {}
    for root, dirs, filenames in os.walk(str(SKILL_ROOT)):
        # Prune excluded directories
        rel_root = Path(root).relative_to(SKILL_ROOT)
        root_str = str(rel_root) + "/" if str(rel_root) != "." else ""

        dirs_to_remove = []
        for d in dirs:
            d_rel = root_str + d
            if any(fnmatch.fnmatch(d_rel, p) for p in EXCLUDE_PATTERNS):
                dirs_to_remove.append(d)
        for d in dirs_to_remove:
            dirs.remove(d)

        for f in filenames:
            f_rel = root_str + f
            if any(fnmatch.fnmatch(f_rel, p) for p in EXCLUDE_PATTERNS):
                continue
            if not any(fnmatch.fnmatch(f_rel, p) for p in INCLUDE_PATTERNS):
                continue
            files[f_rel] = Path(root) / f

    return files


def _compute_sha256(file_path: Path) -> str:
    """SHA256 hex digest of a file."""
    return hashlib.sha256(file_path.read_bytes()).hexdigest()


def _cos_sign(
    secret_id: str,
    secret_key: str,
    method: str,
    uri: str,
    headers: dict[str, str],
    expires_seconds: int = 3600,
) -> str:
    """Build Tencent COS V1 Authorization header (HMAC-SHA1)."""
    now = int(time.time())
    key_time = f"{now};{now + max(60, expires_seconds)}"
    header_items = sorted(
        (str(k).lower(), str(v).strip()) for k, v in headers.items() if str(k).strip()
    )
    header_list = ";".join(name for name, _ in header_items)
    http_headers = "&".join(
        f"{name}={quote(str(value), safe='')}" for name, value in header_items
    )

    http_string = f"{method.lower()}\n{uri}\n\n{http_headers}\n"
    sign_key = hmac.new(
        secret_key.encode("utf-8"), key_time.encode("utf-8"), hashlib.sha1
    ).hexdigest()
    string_to_sign = f"sha1\n{key_time}\n{hashlib.sha1(http_string.encode('utf-8')).hexdigest()}\n"
    signature = hmac.new(
        sign_key.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha1
    ).hexdigest()

    return (
        f"q-sign-algorithm=sha1"
        f"&q-ak={secret_id}"
        f"&q-sign-time={key_time}"
        f"&q-key-time={key_time}"
        f"&q-header-list={header_list}"
        f"&q-url-param-list="
        f"&q-signature={signature}"
    )


def _upload_file(
    content: bytes,
    object_key: str,
    *,
    bucket: str,
    region: str,
    secret_id: str,
    secret_key: str,
    content_type: str = "application/octet-stream",
    acl: str = "public-read",
) -> bool:
    """Upload a single file to COS.  Returns True on success."""
    host = f"{bucket}.cos.{region}.myqcloud.com"
    url = f"https://{host}/{quote(object_key, safe='/')}"
    uri = f"/{object_key}"

    headers = {
        "Host": host,
        "Content-Type": content_type,
        "x-cos-acl": acl,
    }
    authorization = _cos_sign(secret_id, secret_key, "PUT", uri, headers)
    headers["Authorization"] = authorization

    resp = requests.put(url, data=content, headers=headers, timeout=120)
    if resp.status_code >= 400:
        print(f"  ❌ Upload failed ({resp.status_code}): {resp.text[:300]}")
        return False
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    new_version = sys.argv[1]
    dry_run = "--dry-run" in sys.argv

    # COS config — env first, then local config_store
    def _cos_cfg(key: str, default: str = "") -> str:
        val = os.environ.get(key, "").strip()
        if val:
            return val
        try:
            sys.path.insert(0, str(SKILL_ROOT))
            from scripts.lib.config_store import load_config
            return load_config().get(key, default)
        except Exception:
            return default

    secret_id = _cos_cfg("COS_SECRET_ID")
    secret_key = _cos_cfg("COS_SECRET_KEY")
    bucket = _cos_cfg("COS_BUCKET", "yss-1256275613")
    region = _cos_cfg("COS_REGION", "ap-guangzhou")
    prefix = _cos_cfg("COS_PUBLIC_PREFIX", "ozon-skill").strip("/")

    if not dry_run and (not secret_id or not secret_key):
        print("❌ 请设置 COS_SECRET_ID 和 COS_SECRET_KEY (环境变量或 runtime_config.json)")
        return 1

    # 1. Read current version
    const_file = SKILL_ROOT / "scripts" / "_const.py"
    content = const_file.read_text(encoding="utf-8")
    import re
    version_match = re.search(r"SKILL_VERSION\s*=\s*['\"]([^'\"]+)['\"]", content)
    current_version = version_match.group(1) if version_match else "0.0.0"

    print(f"📦 当前版本: v{current_version} → 新版本: v{new_version}")

    # 2. Collect files
    files = _collect_files()
    print(f"\n📁 收集到 {len(files)} 个文件:")
    for rel_path in sorted(files):
        print(f"   {rel_path}")

    # 3. Build manifest
    manifest: dict[str, Any] = {
        "version": new_version,
        "min_python": "3.11",
        "release_notes": "",
        "released_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": {},
    }
    for rel_path, abs_path in sorted(files.items()):
        manifest["files"][rel_path] = f"sha256:{_compute_sha256(abs_path)}"

    # 4. Upload files + manifest
    if dry_run:
        print("\n🔍 [DRY RUN] 将上传到:")
        print(f"   bucket: {bucket}")
        print(f"   region: {region}")
        print(f"   文件数: {len(files)}")
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0

    uploaded = 0
    failed = 0
    print(f"\n⬆️  上传到 COS ({bucket}.cos.{region}.myqcloud.com)...")

    for rel_path, abs_path in sorted(files.items()):
        object_key = f"{prefix}/files/{rel_path}"
        data = abs_path.read_bytes()
        print(f"   {rel_path} ({len(data)} bytes) ...", end=" ")
        if _upload_file(data, object_key, bucket=bucket, region=region,
                        secret_id=secret_id, secret_key=secret_key,
                        content_type="text/plain" if rel_path.endswith((".py", ".md", ".toml", ".json")) else "application/octet-stream"):
            print("✅")
            uploaded += 1
        else:
            print("❌")
            failed += 1

    # Upload version.json
    version_data = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    print(f"   version.json ({len(version_data)} bytes) ...", end=" ")
    if _upload_file(version_data, f"{prefix}/version.json", bucket=bucket, region=region,
                    secret_id=secret_id, secret_key=secret_key,
                    content_type="application/json"):
        print("✅")
    else:
        print("❌")
        failed += 1

    if failed:
        print(f"\n⚠️  {uploaded} 成功, {failed} 失败")
        return 1

    # 5. Bump local version
    new_content = content.replace(
        f"SKILL_VERSION = '{current_version}'",
        f"SKILL_VERSION = '{new_version}'",
    )
    const_file.write_text(new_content, encoding="utf-8")

    print(f"\n✅ 发布成功! v{new_version}")
    print(f"   本地版本已更新: scripts/_const.py → SKILL_VERSION = '{new_version}'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
