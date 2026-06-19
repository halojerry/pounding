#!/usr/bin/env python3
"""Cloud ingress client — pipeline submission + polling.

Architecture:
  Local Skill (thin)          Cloud Pipeline (heavy lifting)
  ─────────────────────       ──────────────────────────────
  search_1688 (browser/CDP)
  match_supply → price calc
  build_envelope
  POST /webhook/follow-sell → import_by_sku → poll → update
  POST /webhook/pipeline    → Build → Upload Ozon → Save SB
  POST /webhook/stage-image-gen → 主图生成 → 跟随图 → 清单
  poll status ← cloud storage      gateway_tasks CRUD

Local-only (must stay local):
  - 1688 search/detail (browser + CDP login)
  - 1688→Ozon category matching confirmation (human decision)
  - Attribute collection from 1688 product detail
  - Attribute resolution engine (complex matching logic)
  - Ozon category tree search (when mapping not cached)

Cloud handles (stable, rarely changes):
  - All Ozon API calls (import_by_sku, poll, update, upload)
  - mxou image generation (prompt building, API calls, manifest assembly)
  - COS asset mirror
  - cloud storage read/write
  - Follow-sell complete flow with copy_denied detection
  - Category resolution from cloud storage cache
"""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Any

import requests

from scripts._const import CLOUD_API_BASE
from scripts._errors import (
    ERR_CLOUD_UNAVAILABLE,
    ERR_CLOUD_REJECTED,
    ERR_CLOUD_TIMEOUT,
    ERR_CLOUD_FAILED,
)
from scripts.lib.config_store import load_env_file, init_sentry, capture_exception
from scripts.lib.task_paths import cleanup_old_files

# Load persisted user credentials from .env at import time so every
# subsequent os.environ.get() picks them up.  Idempotent — existing
# env vars are never overwritten.
load_env_file()

# Initialize Sentry for local skill error tracking (best-effort)
init_sentry()

# Periodically clean up old probe artifacts (>7 days) to prevent
# unlimited disk growth.  Runs at most once per session (import-time).
try:
    cleanup_old_files(max_age_days=7)
except Exception:
    pass  # cleanup is best-effort, never blocks the skill

# ── Skill update check (best-effort, non-blocking) ──
# Checks COS for a newer version of the skill.  Logs a warning if
# one is available.  Does NOT auto-download — user must explicitly
# run `pounding-ozon update`.  Controlled by POUNDING_SKIP_UPDATE_CHECK.
try:
    from scripts.lib.update import check_and_notify
    check_and_notify()
except Exception:
    pass  # update check is best-effort, never blocks the skill


def _load_path_registry() -> dict[str, str]:
    """Load webhook paths. Priority: cloud API discovery > registry file > hardcoded."""
    defaults = {
        "pipeline": "/webhook/pl-v3-304140",
        "ingest": "/webhook/v2-ingest-292201",
        "follow_sell": "/webhook/fs-v4-303992",
        "refresh": "/webhook/re-v2-304020",
        "image_gen": "/webhook/mx-bp2-377417",
        "pricing": "/webhook/pricing-v1",
    }

    # 1. Try file registry first (fast, offline)
    try:
        registry_path = Path(__file__).resolve().parent / "path_registry.json"
        if registry_path.exists():
            with open(registry_path) as f:
                data = json.load(f)
            for key in defaults:
                if key in data and data[key]:
                    defaults[key] = data[key]
    except Exception:
        pass

    # 2. Try cloud API service discovery (tag-based, always current)
    try:
        _refresh_from__discovery_api(defaults)
    except Exception:
        pass

    return defaults


def _refresh_from__discovery_api(paths: dict[str, str]) -> None:
    """Query cloud REST API for active workflows tagged 'pounding-ozon'.

    Any workflow tagged with 'pounding-ozon' + 'prod-{role}' will
    automatically update its webhook path in the registry.

    This means: deploy a new workflow, tag it, and the skill
    auto-discovers it without any code changes.
    """
    base = _get_api_base()
    _discovery_api = base.replace("webhook", "rest") if "/webhook" in base else f"{base.rstrip('/')}/rest"
    # Strip webhook base, use REST API
    if "worker.mxou.cn" in base:
        _discovery_api = "https://worker.mxou.cn/rest"
    else:
        return  # Only auto-discover on known server

    try:
        resp = requests.get(
            f"{_discovery_api}/workflows",
            params={"active": "true"},
            timeout=10,
        )
        resp.raise_for_status()
        workflows = resp.json().get("data", [])
    except Exception:
        return

    tag_role_map = {
        "prod-pipeline": "pipeline",
        "prod-ingest": "ingest",
        "prod-follow-sell": "follow_sell",
        "prod-refresh": "refresh",
        "prod-image-gen": "image_gen",
    }

    for wf in workflows:
        tags = wf.get("tags", [])
        wf_name = wf.get("name", "")
        for tag, role in tag_role_map.items():
            if tag in tags or tag in wf_name:
                # Extract webhook path from the webhook node
                for node in wf.get("nodes", []):
                    if "webhook" in node.get("type", ""):
                        wh_path = node.get("parameters", {}).get("path", "")
                        if wh_path:
                            paths[role] = f"/webhook/{wh_path}"
                            logger.info(
                                "🔍 cloud discovery: %s → %s (from workflow '%s')",
                                role, paths[role], wf_name
                            )

    # Save discovered paths back to registry for offline use
    try:
        registry_path = Path(__file__).resolve().parent / "path_registry.json"
        save_data = {k: v for k, v in paths.items() if not k.startswith("_")}
        with open(registry_path, "w") as f:
            json.dump(save_data, f, indent=2, ensure_ascii=False)
    except Exception:
        pass

_paths = _load_path_registry()
PIPELINE_PATH = _paths["pipeline"]


def _get_api_base() -> str:
    return os.environ.get("MXOU_API_BASE", "").strip() or CLOUD_API_BASE


def _get_token() -> str:
    # Priority: env > pounding config > config_store
    token = os.environ.get("MXOU_TOKEN", "").strip()
    if not token:
        token = _read_pounding_config("api.key") or ""
    if not token:
        try:
            from scripts.lib.config_store import get as _get
            token = _get("MXOU_TOKEN", "")
        except ImportError:
            pass
    return token


def _get_ozon_credentials() -> dict[str, str]:
    """Get Ozon credentials from all available sources.

    Priority: env > pounding config > config_store > defaults.
    Returns {"client_id": str, "api_key": str}
    """
    cid = os.environ.get("OZON_CLIENT_ID", "").strip()
    akey = os.environ.get("OZON_API_KEY", "").strip()

    if not cid:
        cid = _read_pounding_config("ozon.client_id") or ""
    if not akey:
        akey = _read_pounding_config("ozon.api_key") or ""

    if not cid or not akey:
        try:
            from scripts.lib.config_store import get as _get
            cid = cid or _get("OZON_CLIENT_ID", "")
            akey = akey or _get("OZON_API_KEY", "")
        except ImportError:
            pass

    return {"client_id": cid, "api_key": akey}


def _read_pounding_config(key_path: str) -> str | None:
    """Read a value from ~/.pounding/config.json using dot-notation key.

    Supports nested keys like 'api.key', 'ozon.client_id'.
    Returns None if file or key not found.
    """
    config_path = Path.home() / ".pounding" / "config.json"
    if not config_path.exists():
        return None
    try:
        with open(config_path) as f:
            cfg = json.load(f)
        for part in key_path.split("."):
            if isinstance(cfg, dict):
                cfg = cfg.get(part)
            else:
                return None
        return str(cfg) if cfg else None
    except Exception:
        return None


def _cloud_post(url: str, body: dict[str, Any], *, timeout_sec: int = 60, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """POST to cloud pipeline webhook, return parsed JSON or error envelope."""
    try:
        resp = requests.post(url, json=body, timeout=timeout_sec, headers=headers)
        if resp.status_code in (401, 403):
            return _error_envelope(body, "AUTH_FAILED", "认证失败", terminal=True)
        resp.raise_for_status()
        result = resp.json() if resp.text else {}
        if isinstance(result, dict) and result.get('_auth_error'):
            return _error_envelope(body, result.get('error_code', 'AUTH_UNKNOWN'),
                                   result.get('message', 'Authentication failed'), terminal=True)
        return result if isinstance(result, dict) else {}
    except requests.ConnectionError as exc:
        capture_exception(exc, url=url, phase='cloud_post')
        return _error_envelope(body, ERR_CLOUD_UNAVAILABLE, f"无法连接云端 ({url})", details=str(exc))
    except requests.Timeout as exc:
        capture_exception(exc, url=url, phase='cloud_post')
        return _error_envelope(body, ERR_CLOUD_TIMEOUT, f"云端请求超时 ({timeout_sec}s)", terminal=False, retryable=True, details=str(exc))
    except requests.HTTPError as exc:
        capture_exception(exc, url=url, phase='cloud_post', status=exc.response.status_code)
        detail = exc.response.text[:500]
        return _error_envelope(body, ERR_CLOUD_REJECTED, f"云端拒绝请求 ({exc.response.status_code}): {detail}", terminal=exc.response.status_code < 500, retryable=exc.response.status_code >= 500, details=detail)


# ── Envelope assembly ──


def build_envelope(
    *,
    project_id: str,
    subproject_id: str,
    source: dict[str, Any],
    assets: dict[str, Any] | None = None,
    draft: dict[str, Any] | None = None,
    request_id: str | None = None,
    extensions: dict[str, Any] | None = None,
    store_id: str = "",
) -> dict[str, Any]:
    """Build a standard request envelope for cloud submission."""
    if not project_id:
        raise ValueError("project_id is required")
    if not subproject_id:
        raise ValueError("subproject_id is required")

    resolved_extensions = dict(extensions or {})
    # Auto-fill from pounding config / env / config_store
    ozon = _get_ozon_credentials()
    resolved_extensions.setdefault("ozon_client_id", ozon["client_id"])
    resolved_extensions.setdefault("ozon_api_key", ozon["api_key"])
    mxou_token = _read_pounding_config("api.key") or os.environ.get("MXOU_IMAGE_TOKEN", "")
    resolved_extensions.setdefault("mxou_token", mxou_token)
    resolved_extensions.setdefault("mxou_base_url", "https://api.mxou.cn")
    if store_id:
        resolved_extensions.setdefault("store_id", store_id)

    envelope: dict[str, Any] = {
        "version": "v1",
        "project_id": project_id,
        "subproject_id": subproject_id,
        "request_id": request_id or str(uuid.uuid4()),
        "source": source,
        "assets": assets or {},
        "draft": draft or {},
    }
    if any(v is not None for v in resolved_extensions.values()):
        envelope["extensions"] = resolved_extensions
    return envelope


# ── Submit / Poll ──

INGEST_PATH = _paths["ingest"]


def submit_envelope(
    envelope: dict[str, Any],
    *,
    task_id: str | None = None,
) -> dict[str, Any]:
    """Submit envelope to cloud ingest — resolves category, writes task, returns enriched result.

    POST /webhook/ingest with action=submit.
    Cloud handles: intake → category_resolution (cloud storage lookup) → task write.

    Returns {task_id, status, category_resolution, ...}.
    On success, category_resolution contains {description_category_id, type_id, confidence}.
    If not resolved, caller should run category self-service (search → confirm).
    """
    tid = task_id or f"task-{uuid.uuid4().hex[:12]}"
    base = _get_api_base()
    token = _get_token()

    body = {
        "action": "submit",
        "task_id": tid,
        "envelope": envelope,
        "token": token,
    }
    result = _cloud_post(
        f"{base.rstrip('/')}{INGEST_PATH}",
        body,
        headers={"Authorization": f"Bearer {token}"},
    )
    result.setdefault("task_id", tid)
    return result


def submit_task(
    envelope: dict[str, Any],
    *,
    task_id: str | None = None,
) -> dict[str, Any]:
    """Submit envelope to cloud pipeline for Ozon upload.

    POST /webhook/pipeline — cloud handles: payload_build → ozon_upload → save SB.
    Call this AFTER category_resolution, attribute_resolution, and image_generation.
    """
    tid = task_id or f"task-{uuid.uuid4().hex[:12]}"
    base = _get_api_base()
    token = _get_token()
    body = {"task_id": tid, "envelope": envelope, "token": token}
    result = _cloud_post(
        f"{base.rstrip('/')}{PIPELINE_PATH}",
        body,
        headers={"Authorization": f"Bearer {token}"},
    )
    result.setdefault("task_id", tid)
    return result


# ── Category self-service ──


def search_categories_locally(
    *, query: str, client_id: str = "", api_key: str = "", language: str = "ZH_HANS", max_results: int = 10
) -> list[dict[str, Any]]:
    """Search Ozon categories by keyword. Uses Ozon API when cloud storage has no mapping."""
    cid = client_id or os.environ.get("OZON_CLIENT_ID", "")
    akey = api_key or os.environ.get("OZON_API_KEY", "")
    if not cid or not akey:
        import logging
        logging.warning("search_categories_locally: missing OZON_CLIENT_ID/OZON_API_KEY")
        return []

    try:
        from scripts.lib.ozon_api import search_categories
        return search_categories(client_id=cid, api_key=akey, query=query, language=language, max_results=max_results)
    except ImportError as exc:
        import logging
        logging.warning("search_categories_locally: cannot import cloud pipeline: %s", exc)
        return []


# ── Error helpers ──


def _error_envelope(
    source_envelope: dict[str, Any],
    code: str,
    message: str,
    *,
    terminal: bool = True,
    retryable: bool = False,
    details: Any = None,
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    env: dict[str, Any] = {
        "version": "v1",
        "project_id": source_envelope.get("project_id", ""),
        "subproject_id": source_envelope.get("subproject_id", ""),
        "task_id": None,
        "status": "rejected" if terminal else "failed",
        "terminal": terminal,
        "error": {"code": code, "message": message, "retryable": retryable},
    }
    if details is not None:
        env["error"]["details"] = details
    if extras:
        env.update(extras)
    return env


# ── Ozon helpers ──


def parse_ozon_url(url: str) -> dict[str, str] | None:
    """Parse Ozon product/shop URL, extract product_id or offer_id."""
    import re
    value = str(url or "").strip()
    if not value:
        return None
    # /product/xxx-name-123456789/
    m = re.search(r"/products?/(?:[^/]+-)?(\d{6,15})", value)
    if m:
        return {"product_id": m.group(1), "type": "product"}
    # /context/detail/id/123456789/
    m = re.search(r"/detail/id/(\d{6,15})", value)
    if m:
        return {"product_id": m.group(1), "type": "product"}
    # offer_id in query
    m = re.search(r"[?&]offer_id=([^&]+)", value)
    if m:
        return {"offer_id": m.group(1), "type": "offer"}
    # /seller/12345/
    m = re.search(r"/seller/(\d+)", value)
    if m:
        return {"seller_id": m.group(1), "type": "shop"}
    return None


def get_ozon_product_info(client_id: str, api_key: str, product_id: str) -> dict[str, Any] | None:
    """Get Ozon product info by product_id. Returns {name, offer_id, images, category_id, attributes, price}."""
    try:
        # Try cloud package first, then fallback to direct import
        try:
            from scripts.lib.ozon_api import list_product_infos, get_product_attributes_v4
        except ImportError:
            # Direct HTTP call as fallback
            import requests as _r
            resp = _r.post(
                "https://api-seller.ozon.ru/v3/product/info/list",
                headers={"Client-Id": client_id, "Api-Key": api_key, "Content-Type": "application/json"},
                json={"product_id": [str(product_id)]}, timeout=20
            )
            items = resp.json().get("items", [])
            if not items:
                return None
            item = items[0]
            return {
                "product_id": product_id,
                "offer_id": item.get("offer_id", ""),
                "name": item.get("name", ""),
                "images": item.get("images", []),
                "category_id": item.get("description_category_id", ""),
                "price": item.get("price", ""),
                "currency": item.get("currency_code", "RUB"),
                "barcode": item.get("barcode", ""),
                "attributes": [],
            }

        infos = list_product_infos(client_id, api_key, product_ids=[product_id])
        if not infos:
            return None
        item = infos[0]
        result = {
            "product_id": product_id,
            "offer_id": item.get("offer_id", ""),
            "name": item.get("name", ""),
            "images": item.get("images", []),
            "category_id": item.get("description_category_id", ""),
            "price": item.get("price", ""),
            "currency": item.get("currency_code", "RUB"),
            "barcode": item.get("barcode", ""),
        }
        try:
            attrs = get_product_attributes_v4(client_id, api_key, product_ids=[product_id])
            result["attributes"] = attrs.get("result", [])
        except Exception:
            result["attributes"] = []
        return result
    except Exception:
        return None


import logging

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Follow-sell (跟卖) flow
# ---------------------------------------------------------------------------

COPY_PROTECTION_SIGNALS = (
    "запрещено",
    "запрет",
    "copy protection",
    "forbidden",
    "not allowed",
    "copy is not allowed",
    "cannot copy",
    "can't copy",
    "access denied",
    "permission denied",
    "禁止复制",
    "不允许复制",
    "无法复制",
    "protected",
    "foreign_seller",
    "wrong_country",
    "другой страны",  # "another country" in Russian
    "невозможно скопировать",  # "impossible to copy" in Russian
)


def _is_copy_protection_error(error_message: str, error_code: str = "") -> bool:
    """Detect if an import_by_sku error is due to copy protection."""
    text = f"{error_message or ''} {error_code or ''}".lower()
    return any(signal in text for signal in COPY_PROTECTION_SIGNALS)


def follow_sell_by_sku(
    client_id: str, api_key: str,
    *,
    sku: int,
    offer_id: str,
    name: str,
    price: str,
    old_price: str = "",
    currency_code: str = "RUB",
    vat: str = "0.0",
) -> dict[str, Any]:
    """Follow-sell (跟卖): copy another seller's product by SKU.

    Returns:
      - ok: True on success
      - task_id: the Ozon import task ID
      - unmatched_sku_list: SKUs that couldn't be matched (copy protection, etc.)
      - copy_protected: True when the SKU has copy protection
      - error: error message if failed
    """
    try:
        from scripts.lib.ozon_api import import_by_sku
        items = [{
            "sku": int(sku),
            "name": str(name),
            "offer_id": str(offer_id),
            "price": str(price),
            "currency_code": str(currency_code),
            "vat": str(vat),
        }]
        if old_price:
            items[0]["old_price"] = str(old_price)
        result = import_by_sku(client_id, api_key, items)
        task_id = result.get("task_id")
        unmatched = result.get("unmatched_sku_list", [])

        # Check if SKU was rejected (copy protection)
        if unmatched and int(sku) in [int(u.get("sku", 0)) for u in unmatched]:
            error_msg = ""
            for u in unmatched:
                if int(u.get("sku", 0)) == int(sku):
                    error_msg = str(u.get("error") or u.get("message") or "SKU не найден")
                    break
            return {
                "ok": False,
                "copy_protected": True,
                "task_id": None,
                "unmatched_sku_list": unmatched,
                "error": error_msg or "该商品禁止复制 (copy protection)",
            }

        return {
            "ok": bool(task_id),
            "task_id": task_id,
            "copy_protected": False,
            "unmatched_sku_list": unmatched,
        }
    except ImportError:
        return {"ok": False, "copy_protected": False, "error": "import_by_sku unavailable"}
    except Exception as exc:
        error_text = str(exc)
        copy_protected = _is_copy_protection_error(error_text)
        return {
            "ok": False,
            "copy_protected": copy_protected,
            "task_id": None,
            "error": error_text,
        }


def _fallback_new_product(
    client_id: str, api_key: str,
    sku: int,
    name: str,
    price: str,
    *,
    reason: str = "",
) -> dict[str, Any]:
    """Build the fallback result for Path B: new product upload."""
    product_info = get_ozon_product_info(
        client_id, api_key,
        product_id=str(sku) if sku else "",
    )
    if product_info:
        return {
            "ok": True,
            "path": "fallback_new_product",
            "sku": sku,
            "ozon_images": product_info.get("images", []),
            "ozon_attributes": product_info.get("attributes", []),
            "ozon_name": product_info.get("name", name),
            "ozon_price": product_info.get("price", price),
            "ozon_category_id": product_info.get("category_id", ""),
            "ozon_offer_id": product_info.get("offer_id", ""),
            "message": f"{reason} — 使用 Ozon 主图 + 找货源 + 新建上传",
        }
    return {
        "ok": True,
        "path": "fallback_new_product",
        "sku": sku,
        "ozon_images": [],
        "ozon_name": name,
        "ozon_price": price,
        "message": f"{reason} — Ozon 产品详情获取失败，需手动提供图片",
    }


def follow_sell_flow(
    client_id: str, api_key: str,
    *,
    sku: int,
    offer_id: str,
    name: str,
    price: str,
    old_price: str = "",
    currency_code: str = "RUB",
    vat: str = "0.0",
    mxou_token: str = "",
) -> dict[str, Any]:
    """Complete follow-sell flow with two paths:

    Path A (copy allowed):
      1. import_by_sku → copy the product structure
      2. Poll import task → get product_id
      3. (Later) update product with new images/attributes/price

    Path B (copy protected / forbidden):
      1. Get Ozon product info → main images, attributes, price
      2. Use Ozon main image directly
      3. (Later) go through full 9-stage upload pipeline as new product

    Returns:
      - path: "copy_and_update" | "fallback_new_product" | "failed"
      - product_id: Ozon product_id (Path A only)
      - ozon_images: main images from Ozon (Path B only)
      - ozon_attributes: product attributes from Ozon (Path B only)
      - error: error message if failed
    """
    # ── Step 1: Try import_by_sku ──
    copy_result = follow_sell_by_sku(
        client_id, api_key,
        sku=sku, offer_id=offer_id, name=name,
        price=price, old_price=old_price,
        currency_code=currency_code, vat=vat,
    )

    if copy_result.get("ok") and copy_result.get("task_id"):
        # ── Path A: Copy succeeded → poll for product_id ──
        try:
            from scripts.lib.ozon_api import poll_import_task
            poll_result = poll_import_task(
                client_id, api_key,
                task_id=copy_result["task_id"],
                max_wait_seconds=300,
            )
            if poll_result.get("status") == "copy_denied":
                # ── import_by_sku succeeded but copy was denied (foreign seller, etc.) → Path B ──
                logger.info("follow_sell_flow: copy denied for SKU %s: %s", sku, poll_result.get("error"))
                return _fallback_new_product(client_id, api_key, sku, name, price,
                                            reason=f"复制被拒: {poll_result.get('error', '')}")

            if poll_result.get("status") == "already_imported":
                # ── SKU already exists → find by offer_id then by listing all products ──
                logger.info("follow_sell_flow: SKU %s already imported, looking up", sku)
                try:
                    from scripts.lib.ozon_api import list_product_infos, list_products
                    pid = ""
                    oid = poll_result.get("offer_id", offer_id)
                    # Try 1: by offer_id (works if user reused same offer_id)
                    infos = list_product_infos(client_id, api_key, offer_ids=[oid])
                    if infos:
                        pid = str(infos[0].get("id", infos[0].get("product_id", "")))
                        oid = str(infos[0].get("offer_id", oid))
                    # Try 2: list all products, find matching name/source SKU
                    if not pid:
                        resp = list_products(client_id, api_key, visibility="ALL", limit=50)
                        items = resp.get("items") or resp.get("result", {}).get("items", [])
                        for item in items:
                            item_pid = str(item.get("product_id", item.get("id", "")))
                            # Try to match by offer_id pattern or source SKU
                            if item.get("offer_id", "").startswith("fs-") or str(sku) in str(item.get("offer_id", "")):
                                infos_detail = list_product_infos(client_id, api_key, product_ids=[item_pid])
                                for detail in infos_detail:
                                    sources = detail.get("sources", [])
                                    for src in sources:
                                        if str(src.get("sku", "")) == str(sku):
                                            pid = str(detail.get("id", item_pid))
                                            oid = str(detail.get("offer_id", oid))
                                            break
                                    if pid:
                                        break
                            if pid:
                                break
                        return {
                            "ok": True,
                            "path": "copy_and_update",
                            "sku": sku,
                            "product_id": pid,
                            "offer_id": oid,
                            "ozon_task_id": copy_result["task_id"],
                            "message": "SKU已存在，查找成功，可直接更新产品信息",
                        }
                except Exception as exc:
                    logger.warning("follow_sell_flow: SKU lookup failed: %s", exc)
                return {
                    "ok": True,
                    "path": "copy_and_update",
                    "sku": sku,
                    "product_id": "",
                    "offer_id": offer_id,
                    "message": "SKU已存在但无法查找到 product_id",
                    "warning": "SKU already imported, update manually",
                }

            if poll_result.get("status") == "failed":
                # ── Check if failure is copy-related → Path B ──
                error_msg = str(poll_result.get("error", ""))
                if _is_copy_protection_error(error_msg):
                    logger.info("follow_sell_flow: copy-related failure for SKU %s: %s", sku, error_msg)
                    return _fallback_new_product(client_id, api_key, sku, name, price,
                                                reason=f"复制失败: {error_msg}")
                # Generic failure — still try to handle gracefully
                logger.warning("follow_sell_flow: import task failed for SKU %s: %s", sku, error_msg)
                return {
                    "ok": False,
                    "path": "failed",
                    "error": error_msg or "Ozon 导入任务失败",
                    "detail": poll_result,
                }

            if poll_result.get("status") == "completed" and poll_result.get("product_id"):
                # ── Path A: Copy succeeded, product_id obtained ──
                # Note: import_by_sku does NOT copy images. Collect them from
                # the Ozon product page via browser/CDP before generating new ones.
                return {
                    "ok": True,
                    "path": "copy_and_update",
                    "sku": sku,
                    "product_id": poll_result["product_id"],
                    "offer_id": poll_result.get("offer_id") or offer_id,
                    "ozon_task_id": copy_result["task_id"],
                    "needs_images": True,
                    "message": "跟卖复制成功，等待收集Ozon原图+更新产品信息",
                    "next": [
                        "1. 浏览器打开Ozon商品页，收集主图和详情图（页面JS渲染，需CDP）",
                        "2. 用收集到的原图作为制图参考 → 调用stage-image-gen",
                        "3. update_followed_product(product_id=..., images=[...], price=...)",
                    ],
                }
            # Poll didn't get product_id — try to look it up by offer_id
            try:
                from scripts.lib.ozon_api import list_product_infos
                infos = list_product_infos(client_id, api_key, offer_ids=[offer_id])
                if infos:
                    return {
                        "ok": True,
                        "path": "copy_and_update",
                        "sku": sku,
                        "product_id": str(infos[0].get("product_id", infos[0].get("id", ""))),
                        "offer_id": offer_id,
                        "ozon_task_id": copy_result["task_id"],
                        "message": "跟卖复制成功(通过offer_id查找)，等待更新产品信息",
                    }
            except Exception:
                pass

            return {
                "ok": True,
                "path": "copy_and_update",
                "sku": sku,
                "product_id": poll_result.get("product_id", ""),
                "offer_id": poll_result.get("offer_id") or offer_id,
                "ozon_task_id": copy_result["task_id"],
                "message": f"跟卖已提交，导入任务状态: {poll_result.get('status')}",
                "warning": "无法确认 product_id，可能需要手动更新",
            }
        except ImportError:
            return {
                "ok": True,
                "path": "copy_and_update",
                "sku": sku,
                "product_id": "",
                "offer_id": offer_id,
                "ozon_task_id": copy_result["task_id"],
                "message": "跟卖已提交但无法轮询结果，请稍后手动更新",
            }

    if copy_result.get("copy_protected"):
        # ── Path B: Copy protection → fallback to new product flow ──
        try:
            # Get product info from Ozon
            product_info = get_ozon_product_info(
                client_id, api_key,
                product_id=str(sku) if sku else "",
            )
            if product_info:
                return {
                    "ok": True,
                    "path": "fallback_new_product",
                    "sku": sku,
                    "ozon_images": product_info.get("images", []),
                    "ozon_attributes": product_info.get("attributes", []),
                    "ozon_name": product_info.get("name", name),
                    "ozon_price": product_info.get("price", price),
                    "ozon_category_id": product_info.get("category_id", ""),
                    "ozon_offer_id": product_info.get("offer_id", ""),
                    "message": "禁止复制 — 使用 Ozon 主图 + 找货源 + 新建上传",
                }
            # Fallback: can't get product info either
            return {
                "ok": True,
                "path": "fallback_new_product",
                "sku": sku,
                "ozon_images": [],
                "ozon_name": name,
                "ozon_price": price,
                "message": "禁止复制，且无法获取Ozon产品详情 — 需手动提供图片和属性",
            }
        except Exception as exc:
            logger.warning("follow_sell_flow: Ozon product info fetch failed: %s", exc)
            return {
                "ok": True,
                "path": "fallback_new_product",
                "sku": sku,
                "ozon_images": [],
                "ozon_name": name,
                "ozon_price": price,
                "message": "禁止复制 — 需手动提供 Ozon 主图和货源信息",
            }

    # ── Failed: unknown error ──
    return {
        "ok": False,
        "path": "failed",
        "error": copy_result.get("error", "unknown error"),
        "detail": copy_result,
    }


def update_followed_product(
    client_id: str, api_key: str,
    *,
    product_id: str,
    offer_id: str,
    name: str = "",
    images: list[str] | None = None,
    price: str = "",
    old_price: str = "",
    attributes: list[dict[str, Any]] | None = None,
    currency_code: str = "",
    vat: str = "0.0",
    depth: int = 100,
    width: int = 100,
    height: int = 200,
    weight: int = 500,
) -> dict[str, Any]:
    """Update a copied (跟卖) product with new images, attributes, and price.

    Auto-detects contract currency if not provided.
    Includes default dimensions (100x100x200mm, 500g) because import_by_sku
    doesn't copy dimensions and Ozon requires them.
    """
    if not currency_code:
        try:
            from scripts.lib.ozon_api import detect_contract_currency
            detected = detect_contract_currency(client_id, api_key)
            if detected:
                currency_code = detected
                logger.info("update_followed_product: auto-detected currency=%s", currency_code)
        except Exception:
            currency_code = "CNY"  # default for Chinese sellers
    try:
        from scripts.lib.ozon_api import update_existing_product
        result = update_existing_product(
            client_id, api_key,
            product_id=product_id,
            offer_id=offer_id,
            name=name,
            images=images,
            price=price,
            old_price=old_price,
            attributes=attributes,
            currency_code=currency_code,
            vat=vat,
            depth=depth,
            width=width,
            height=height,
            weight=weight,
        )
        return result
    except ImportError:
        return {"ok": False, "error": "update_existing_product unavailable"}


# ---------------------------------------------------------------------------
# Follow-sell via cloud pipeline
# ---------------------------------------------------------------------------

FOLLOW_SELL_PATH = _paths["follow_sell"]
REFRESH_PATH = _paths["refresh"]
IMAGE_GEN_PATH = _paths["image_gen"]


# ═══════════════════════════════════════════════════════════════════════════
# Image generation (云端制图 + 重试)
# ═══════════════════════════════════════════════════════════════════════════

# Standard 10-slot prompts for Ozon product images
PRODUCT_IMAGE_SLOTS = [
    ("white_bg", "White bg reference. Pure white. Single product. Real photo quality."),
    ("multi_view", "Russian ecom multi-angle white bg. Highlight details. Keep identity."),
    ("main_image", "Russian ecom main image. High CTR. Product-focused. Keep identity."),
    ("multi_info", "Russian ecom info graphic. Show specs, dimensions. Product-focused."),
    ("detail", "Russian ecom detail showcase. Product-focused. Keep identity."),
    ("social_proof", "Russian ecom social proof. Storytelling feel. High CTR."),
    ("scene_travel", "Russian ecom usage scene: travel. Product-focused. Keep identity."),
    ("scene_home", "Russian ecom usage scene: home. Product-focused. Keep identity."),
    ("scene_biz", "Russian ecom usage scene: business. Product-focused. Keep identity."),
    ("comparison", "Russian ecom comparison. Neutral, restrained, truthful."),
]


def _call_image_gen(slot: str, prompt: str, token: str, max_retries: int = 3) -> str | None:
    """Call cloud image-gen endpoint with retry.

    Returns image URL on success, None if all retries exhausted.
    Retries on: timeout, 5xx, empty response.
    """
    base = _get_api_base()
    url = f"{base.rstrip('/')}{IMAGE_GEN_PATH}"

    for attempt in range(1, max_retries + 1):
        try:
            resp = requests.post(
                url,
                json={"slot": slot, "prompt": prompt, "token": token},
                timeout=180,
            )
            if resp.status_code == 200:
                data = resp.json() if resp.text else {}
                if data.get("ok") and data.get("url"):
                    return data["url"]
                if not data.get("ok"):
                    logger.warning(
                        "image_gen(%s): rejected (attempt %d/%d): %s",
                        slot, attempt, max_retries, data.get("error", "unknown")
                    )
            else:
                logger.warning(
                    "image_gen(%s): HTTP %d (attempt %d/%d)",
                    slot, resp.status_code, attempt, max_retries
                )
        except requests.Timeout:
            logger.warning(
                "image_gen(%s): timeout (attempt %d/%d)", slot, attempt, max_retries
            )
        except Exception as exc:
            logger.warning(
                "image_gen(%s): error (attempt %d/%d): %s",
                slot, attempt, max_retries, exc
            )

        if attempt < max_retries:
            import time
            time.sleep(min(10 * attempt, 30))  # Backoff: 10s, 20s, 30s

    return None


def generate_product_images(
    token: str,
    slots: list[tuple[str, str]] | None = None,
    max_concurrency: int = 2,
    max_retries: int = 3,
) -> dict[str, str]:
    """Generate Ozon product images via cloud endpoint with retry.

    Args:
        token: mxou API token
        slots: list of (slot_name, prompt). Default: 10 standard slots.
        max_concurrency: max parallel calls (2 recommended for mxou rate limits)
        max_retries: max attempts per image

    Returns:
        {slot_name: image_url} for successfully generated images.
        Failed slots are absent from the dict.
    """
    import concurrent.futures

    slots = list(slots or PRODUCT_IMAGE_SLOTS)

    results: dict[str, str] = {}

    def _gen(slot: str, prompt: str) -> tuple[str, str | None]:
        url = _call_image_gen(slot, prompt, token, max_retries=max_retries)
        return slot, url

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_concurrency) as ex:
        futures = {ex.submit(_gen, s, p): s for s, p in slots}
        for f in concurrent.futures.as_completed(futures):
            slot, url = f.result()
            if url:
                results[slot] = url
                logger.info("image_gen: ✅ %s (%d/%d)", slot, len(results), len(slots))
            else:
                logger.warning("image_gen: ❌ %s failed after %d retries", slot, max_retries)

    return results


def follow_sell_cloud(
    *,
    sku: int,
    offer_id: str = "",
    name: str = "",
    price: str = "1000",
    old_price: str = "",
    currency_code: str = "",
    vat: str = "0.0",
    ozon_client_id: str = "",
    ozon_api_key: str = "",
    # Fields to update after successful copy
    update_price: str = "",
    update_old_price: str = "",
    update_name: str = "",
    update_images: list[str] | None = None,
    update_attributes: list[dict[str, Any]] | None = None,
    timeout_sec: int = 180,
) -> dict[str, Any]:
    """Follow-sell via cloud pipeline — the recommended entry point.

    Posts to cloud /webhook/follow-sell which handles:
      1. import_by_sku → copy product structure
      2. Poll for result (up to 2 attempts, ~20s total)
      3. Detect copy_denied (foreign seller, copy protection, etc.)
      4. Optionally update product if update_* fields provided

    Returns:
      - path: "copy_and_update" | "fallback_new_product" | "failed"
      - product_id: str (Path A — copy succeeded)
      - ozon_task_id: str
      - See follow_sell_flow() for full schema

    Falls back to local Python implementation if cloud is unavailable.

    The 1688 supply matching MUST be done locally (browser/CDP dependency).
    After cloud returns product_id (Path A), call the pipeline workflow to
    update images/attributes with matched supply data.
    """
    cid = ozon_client_id or os.environ.get("OZON_CLIENT_ID", "")
    akey = ozon_api_key or os.environ.get("OZON_API_KEY", "")

    if not cid or not akey:
        return {
            "ok": False, "path": "failed",
            "error": "缺少 Ozon 凭证 (OZON_CLIENT_ID/OZON_API_KEY)",
        }

    # Auto-detect currency
    cur = currency_code
    if not cur:
        try:
            from scripts.lib.ozon_api import detect_contract_currency
            cur = detect_contract_currency(cid, akey) or "CNY"
        except Exception:
            cur = "CNY"

    body = {
        "sku": int(sku),
        "offer_id": offer_id or f"fs-{sku}-{uuid.uuid4().hex[:8]}",
        "name": name or f"Follow Sell {sku}",
        "price": str(price),
        "currency_code": cur,
        "vat": str(vat),
        "ozon_client_id": cid,
        "ozon_api_key": akey,
    }
    if old_price:
        body["old_price"] = str(old_price)
    if update_price:
        body["update_price"] = str(update_price)
    if update_old_price:
        body["update_old_price"] = str(update_old_price)
    if update_name:
        body["update_name"] = update_name
    if update_images:
        body["update_images"] = list(update_images)
    if update_attributes:
        body["update_attributes"] = list(update_attributes)

    base = _get_api_base()
    url = f"{base.rstrip('/')}{FOLLOW_SELL_PATH}"

    token = _get_token()
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=timeout_sec)
        if resp.status_code in (401, 403):
            return {"ok": False, "path": "failed", "error": "认证失败", "http_status": resp.status_code}
        resp.raise_for_status()
        result = resp.json() if resp.text else {}
    except requests.ConnectionError:
        # Cloud unavailable → fall back to local Python implementation
        logger.warning("cloud unavailable, falling back to local follow_sell_flow")
        return follow_sell_flow(
            cid, akey,
            sku=sku, offer_id=body["offer_id"], name=body["name"],
            price=body["price"], old_price=body.get("old_price", ""),
            currency_code=cur, vat=body["vat"],
        )
    except requests.HTTPError as exc:
        # Cloud returned 4xx/5xx → fall back if 5xx, propagate if 4xx
        if exc.response is not None and exc.response.status_code >= 500:
            logger.warning("cloud error %s, falling back to local", exc.response.status_code)
            return follow_sell_flow(
                cid, akey,
                sku=sku, offer_id=body["offer_id"], name=body["name"],
                price=body["price"], old_price=body.get("old_price", ""),
                currency_code=cur, vat=body["vat"],
            )
        # 404 means workflow not deployed yet — fall back
        if exc.response is not None and exc.response.status_code == 404:
            logger.warning("cloud endpoint not found (404), falling back to local")
            return follow_sell_flow(
                cid, akey,
                sku=sku, offer_id=body["offer_id"], name=body["name"],
                price=body["price"], old_price=body.get("old_price", ""),
                currency_code=cur, vat=body["vat"],
            )
    except requests.Timeout:
        return {"ok": False, "path": "failed", "error": f"云端请求超时 ({timeout_sec}s)", "retryable": True}
    except Exception as exc:
        return {"ok": False, "path": "failed", "error": str(exc)}

    if not isinstance(result, dict):
        return {"ok": False, "path": "failed", "error": f"云端返回非JSON: {str(result)[:200]}"}

    # Normalise response
    result.setdefault("ok", result.get("path") in ("copy_and_update", "fallback_new_product"))
    return result


# ═══════════════════════════════════════════════════════════════════════════
# Reusable flow steps (all call cloud pipeline — thin local wrapper)
# ═══════════════════════════════════════════════════════════════════════════

# These are the composable steps that both new-product and follow-sell flows use.
# Each step = POST to a cloud webhook → get result.
#
# Local-only steps (1688 matching via browser/CDP):
#   - search_1688(query) → product list
#   - get_1688_detail(url) → title/description/images/attributes
#   - match_supply(source_1688, target_ozon) → price calc
#
# Cloud steps (API calls, image gen, upload):
#   - follow_sell_cloud(sku, ...) → product_id | fallback
#   - submit_task(envelope) → task_id
#   - poll_task(task_id) → status
#   - analyze_ozon_product(url) → structured Ozon product data
#   - build_variant_envelope(...) → envelope with multi-SKU variants


# ═══════════════════════════════════════════════════════════════════════════
# 多SKU变体合并
# ═══════════════════════════════════════════════════════════════════════════


def build_variant_envelope(
    *,
    project_id: str,
    subproject_id: str,
    family_title: str,
    family_description: str = "",
    source_category_ids: list[str] | None = None,
    variants: list[dict[str, Any]] | None = None,
    common_attributes: dict[str, Any] | None = None,
    common_images: list[str] | None = None,
    store_id: str = "",
) -> dict[str, Any]:
    """Build an envelope for a multi-variant (merged) product card.

    On Ozon, variants share the same product card with a merge group identifier.
    Each variant has its own offer_id, price, images, and differentiating attributes
    (e.g., color, size). The cloud pipeline resolves the category, generates images,
    and uploads all variants together.

    Args:
        family_title: Master product name (e.g., "Ridberg Discover Suitcase")
        family_description: Shared product description
        source_category_ids: 1688 category IDs for mapping
        variants: List of variant specs:
            [{"sku_id": "red-m", "sku_title": "Red M", "price": "280",
              "attributes": {"color": "red", "size": "M"}, "images": [...]}, ...]
        common_attributes: Attributes shared across all variants (e.g., brand, material)
        common_images: Images shared across variants (fallback if variant has none)

    Returns: envelope dict ready for submit_envelope()
    """
    merged_attributes = dict(common_attributes or {})
    merged_attributes.setdefault("merge_group", family_title)

    variant_list = list(variants or [])
    # Ensure each variant has a merge key
    for i, v in enumerate(variant_list):
        if "variant_key" not in v:
            v["variant_key"] = v.get("sku_id", f"var-{i+1}")
        if "sku_title" not in v:
            v["sku_title"] = v.get("sku_id", f"Variant {i+1}")

    source: dict[str, Any] = {
        "source_item_id": f"variant-family-{subproject_id}",
        "source_url": "",
    }

    draft: dict[str, Any] = {
        "title": family_title,
        "description": family_description,
        "attributes": merged_attributes,
        "variants": variant_list,
    }
    if source_category_ids:
        draft["source_category_ids"] = list(source_category_ids)

    assets: dict[str, Any] = {}
    all_images = list(common_images or [])
    for v in variant_list:
        variant_images = v.get("images") or v.get("source_images") or []
        all_images.extend(variant_images)
    if all_images:
        assets["image_urls"] = list(dict.fromkeys(all_images))  # dedup, keep order

    return build_envelope(
        project_id=project_id,
        subproject_id=subproject_id,
        source=source,
        assets=assets,
        draft=draft,
        store_id=store_id,
    )


# ═══════════════════════════════════════════════════════════════════════════
# Ozon选品 → 1688找货源
# ═══════════════════════════════════════════════════════════════════════════


def analyze_ozon_product(
    url_or_id: str,
    *,
    ozon_client_id: str = "",
    ozon_api_key: str = "",
) -> dict[str, Any]:
    """Parse an Ozon product URL and fetch full product details.

    Returns structured data for the local skill to:
      1. Search 1688 for matching supply (by image/keyword)
      2. Compare prices
      3. Ask user: follow-sell (跟卖) or create new (新建)?

    Returns:
      - product_id, offer_id, sku (from URL parsing and product info)
      - name, price, currency
      - images (Ozon primary images for 1688 image search)
      - category_id, type_id
      - attributes (for supply matching)
      - suggested_action: "follow_sell" | "new_product" | "ask_user"
      - supply_search_hints: keywords for 1688 search
    """
    cid = ozon_client_id or os.environ.get("OZON_CLIENT_ID", "")
    akey = ozon_api_key or os.environ.get("OZON_API_KEY", "")

    # Step 1: Parse URL
    parsed = parse_ozon_url(url_or_id)
    product_id = ""
    if parsed and parsed.get("product_id"):
        product_id = parsed["product_id"]
        product_type = parsed["type"]
    elif str(url_or_id).strip().isdigit():
        product_id = str(url_or_id).strip()
        product_type = "product_id"
    else:
        return {"ok": False, "error": f"无法从URL提取product_id: {url_or_id[:80]}"}

    # Step 2: Extract name from URL slug
    url_slug_name = ""
    # Pattern: /product/slug-name-123456789/ → extract "slug-name"
    slug_match = re.search(r"/([^/]+)-(\d{6,15})/?$", url_or_id)
    if slug_match:
        url_slug_name = slug_match.group(1).replace("-", " ").strip()

    # Step 3: Try to get richer product info from Ozon API
    images: list[str] = []
    attributes: list[dict[str, Any]] = []
    ozon_name = ""
    ozon_price = ""
    ozon_currency = ""
    category_id = ""
    type_id = ""
    offer_id = ""

    if cid and akey:
        info = get_ozon_product_info(cid, akey, product_id=product_id)
        if info:
            ozon_name = info.get("name", "")
            images = info.get("images", [])
            ozon_price = info.get("price", "")
            ozon_currency = info.get("currency", "CNY")
            category_id = info.get("category_id", "")
            offer_id = info.get("offer_id", "")
            attributes = info.get("attributes", [])

    # Step 4: Build supply search hints from name
    display_name = ozon_name or url_slug_name or f"Ozon Product {product_id}"
    search_hints = [display_name]
    # Add shorter search variations
    words = display_name.split()
    if len(words) > 3:
        search_hints.append(" ".join(words[:3]))  # First 3 words
        search_hints.append(" ".join(words[-3:]))  # Last 3 words

    return {
        "ok": True,
        "product_id": product_id,
        "product_type": product_type,
        "url_slug_name": url_slug_name,
        "name": display_name,
        "offer_id": offer_id,
        "price": ozon_price,
        "currency": ozon_currency or "CNY",
        "category_id": category_id,
        "type_id": type_id,
        "images": images,
        "image_count": len(images),
        "primary_image": images[0] if images else "",
        "attributes": attributes,
        "has_full_details": bool(ozon_name),
        "supply_search_hints": search_hints,
        "suggested_action": "ask_user",
        "needs_image_collection": not images,
        "next_steps": [
            f"1. 用浏览器打开 Ozon 商品页 → 收集主图和详情图（JS渲染，需CDP）" if not images else "1. 已有 {len(images)} 张参考图",
            f"2. 用关键词 '{search_hints[0][:60]}' 在1688搜同款 → 找最优货源",
            "3. 比较价格: Ozon售价 vs 1688成本+运费+利润",
            "4. 询问用户: 跟卖复制 or 新建商品?",
            "5. 跟卖 → follow_sell_cloud(sku=product_id)",
            "6. 制图以收集到的Ozon图+1688图为参考",
            "7. 新建 → submit_envelope(envelope) → 属性解析 → submit_task(envelope)",
        ],
    }
#   - generate_images(draft, mxou_token) → asset_manifest
