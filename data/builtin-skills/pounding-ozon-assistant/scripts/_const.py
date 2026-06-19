#!/usr/bin/env python3
"""Constants for pounding-ozon-hybrid."""
from __future__ import annotations

import os
from pathlib import Path

SKILL_VERSION = '0.3.0'
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent
DATA_DIR = SKILL_ROOT / 'data'
DATA_DIR.mkdir(parents=True, exist_ok=True)

RUNTIME_DIRS = (
    DATA_DIR / 'config',
    DATA_DIR / 'manual',
    DATA_DIR / 'managed',
    DATA_DIR / 'ozon',
    DATA_DIR / 'ozon' / 'properties',
    DATA_DIR / 'ozon' / 'dictionaries',
    DATA_DIR / 'ozon' / 'dictionary_shared',
    DATA_DIR / 'ozon' / 'prewarm_reports',
)
for runtime_dir in RUNTIME_DIRS:
    runtime_dir.mkdir(parents=True, exist_ok=True)


def get_config_dir() -> Path:
    path = DATA_DIR / 'config'
    path.mkdir(parents=True, exist_ok=True)
    return path


def get_config_profile() -> str:
    return (
        os.environ.get('POUNDING_OZON_STORE', '').strip()
        or os.environ.get('UNIFIED_1688_OZON_STORE', '').strip()
        or 'default'
    )


def resolve_input_path(raw_path: str | os.PathLike[str], *, must_exist: bool = False) -> Path:
    raw = str(raw_path).strip()
    if not raw:
        path = SKILL_ROOT
    else:
        candidate = Path(raw).expanduser()
        path = candidate if candidate.is_absolute() else (SKILL_ROOT / candidate)
    path = path.resolve()
    if must_exist and not path.exists():
        raise FileNotFoundError(f'路径不存在: {path}')
    return path


def get_config_file() -> Path:
    return get_config_dir() / f'runtime_config.{get_config_profile()}.json'


def get_legacy_config_file() -> Path:
    return get_config_dir() / 'runtime_config.json'


CONFIG_DIR = get_config_dir()
CONFIG_PROFILE = get_config_profile()
CONFIG_FILE = get_config_file()
LEGACY_CONFIG_FILE = get_legacy_config_file()

# Defaults
DEFAULT_OZON_CURRENCY = 'RUB'
DEFAULT_MXOU_BASE_URL = 'https://api.mxou.cn'
DEFAULT_IMAGE_ASPECT = '1024x1536'
DEFAULT_MAX_BATCH_SIZE = 100
DEFAULT_CACHE_TTL_SECONDS = 86400

SKILL_NAME = 'pounding-ozon-hybrid'

CLOUD_API_BASE = os.environ.get('MXOU_API_BASE', '').strip() or 'https://worker.mxou.cn'

# ═══════════════════════════════════════════════════════════════════════════════
# COS Skill Distribution (auto-update)
# ═══════════════════════════════════════════════════════════════════════════════

# Public-read COS bucket hosting the skill distribution.
# Override via POUNDING_COS_BASE env var for mirrors / testing.
COS_PUBLIC_BASE = os.environ.get(
    'POUNDING_COS_BASE',
    'https://yss-1256275613.cos.ap-guangzhou.myqcloud.com',
).rstrip('/')
COS_SKILL_PREFIX = os.environ.get('POUNDING_COS_PREFIX', 'ozon-skill').strip('/')
COS_VERSION_URL = f'{COS_PUBLIC_BASE}/{COS_SKILL_PREFIX}/version.json'
COS_DOWNLOAD_BASE = f'{COS_PUBLIC_BASE}/{COS_SKILL_PREFIX}/files'

# Set POUNDING_SKIP_UPDATE_CHECK=1 to opt out of automatic update checks.
SKIP_UPDATE_CHECK = (
    os.environ.get('POUNDING_SKIP_UPDATE_CHECK', '').strip().lower()
    in ('1', 'true', 'yes')
)

# How long to cache the version check result (seconds).  Default: 24 hours.
UPDATE_CACHE_TTL = int(os.environ.get(
    'POUNDING_UPDATE_CACHE_TTL', '86400',
))
