#!/usr/bin/env python3
"""Lightweight 1688 AK client — search + product detail fetch."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
import uuid
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

import requests

from scripts.lib.config_store import load_config

BASE_URL = "https://skills-gateway.1688.com"
AINEXT_BASE_URL = "https://ainext.1688.com"
FIND_PRODUCT_API = "/api/find_product/1.0.0"
WORKFLOW_API = "/1688claw/skill/workflow"
DEFAULT_TIMEOUT_SECONDS = 30
DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


class ConfigError(Exception):
    pass


class ApiError(Exception):
    pass


# ── Auth helpers ──


def _extract_ak_keys(raw_ak: str) -> tuple[str, str]:
    raw_ak = raw_ak.strip()
    if ":" in raw_ak:
        parts = raw_ak.split(":", 1)
        return parts[0].strip(), parts[1].strip()
    # Base64 encoded: decode, first 32 chars = secret, rest = access key id
    padded = raw_ak + "=" * (-len(raw_ak) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded).decode("utf-8")
        return decoded[32:], decoded[:32]
    except Exception:
        pass
    if len(raw_ak) > 32:
        return raw_ak[32:], raw_ak[:32]
    raise ConfigError("1688 AK 格式无效（需要 AK:Secret 或 64位密钥）")


def _content_md5(body: str) -> str:
    if not body:
        return ""
    return base64.b64encode(hashlib.md5(body.encode("utf-8")).digest()).decode("utf-8")


def _canonicalized_resource(uri: str) -> str:
    parsed = urlparse(uri)
    path = parsed.path or "/"
    if not parsed.query:
        return path
    params = parse_qs(parsed.query, keep_blank_values=True)
    parts: list[str] = []
    for key in sorted(params.keys()):
        for value in sorted(params[key]):
            parts.append(f"{quote(key, safe='')}={quote(value, safe='')}")
    return f"{path}?{'&'.join(parts)}"


def _signature_headers(method: str, path: str, body: str) -> dict[str, str]:
    cfg = load_config()
    ak = cfg.get("ALI_1688_AK", os.environ.get("ALI_1688_AK", ""))
    if not ak:
        raise ConfigError("缺少 1688 AK")
    access_key_id, access_key_secret = _extract_ak_keys(ak)
    content_type = "application/json"
    timestamp = str(int(time.time()))
    nonce = uuid.uuid4().hex[:8]
    content_md5_val = _content_md5(body)
    sign_headers = {
        "x-csk-ak": access_key_id,
        "x-csk-time": timestamp,
        "x-csk-nonce": nonce,
        "x-csk-content-md5": content_md5_val,
        "x-csk-version": "0.1.0",
    }
    canonicalized_headers = "".join(
        f"{key.lower()}:{sign_headers[key].strip()}\n"
        for key in sorted(sign_headers.keys())
    )
    string_to_sign = (
        method.upper()
        + "\n" + content_md5_val
        + "\n" + content_type
        + "\n" + timestamp
        + "\n" + canonicalized_headers
        + _canonicalized_resource(path)
    )
    signature = base64.b64encode(
        hmac.new(
            access_key_secret.encode("utf-8"),
            string_to_sign.encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).decode("utf-8")
    return {
        "Content-Type": content_type,
        "x-csk-sign": signature,
        **sign_headers,
    }


def _post_1688(path: str, body: dict[str, Any], *, base_url: str = BASE_URL) -> dict[str, Any]:
    url = f"{base_url}{path}"
    body_str = json.dumps(body, ensure_ascii=False)
    headers = {
        **DEFAULT_HEADERS,
        **_signature_headers("POST", path, body_str),
    }
    resp = requests.post(url, headers=headers, data=body_str.encode("utf-8"), timeout=DEFAULT_TIMEOUT_SECONDS)
    if resp.status_code >= 400:
        raise ApiError(f"1688 API 请求失败 ({resp.status_code}): {resp.text[:500]}")
    return resp.json()



# ── all_info parser ──


def _extract_markdown_section(all_info: str, heading: str) -> str:
    import re
    pattern = rf"#\s*{re.escape(heading)}\n(.*?)(?=\n#\s|\Z)"
    match = re.search(pattern, str(all_info or ""), flags=re.S)
    return match.group(1).strip() if match else ""


def _parse_markdown_kv_table(section_text: str) -> dict[str, list[str]]:
    parsed: dict[str, list[str]] = {}
    for raw_line in str(section_text or "").splitlines():
        line = raw_line.strip()
        if not line.startswith("|") or line.startswith("|--"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        key, value = cells[0], cells[1]
        if key in {"属性名", "类目级别"} or not key or not value:
            continue
        parsed.setdefault(key, []).append(value)
    return parsed


def _parse_category_table(section_text: str) -> list[dict[str, str]]:
    categories: list[dict[str, str]] = []
    for raw_line in str(section_text or "").splitlines():
        line = raw_line.strip()
        if not line.startswith("|") or line.startswith("|--"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        level, name = cells[0], cells[1]
        if level == "类目级别" or not level or not name:
            continue
        categories.append({"level": level, "name": name})
    return categories


def parse_offer_detail_info(all_info: str) -> dict[str, Any]:
    """Parse ainext offer_detail all_info text into structured data."""
    import re
    title_section = _extract_markdown_section(all_info, "商品标题")
    price_section = _extract_markdown_section(all_info, "商品价格")
    category_section = _extract_markdown_section(all_info, "商品类目")
    sku_section = _extract_markdown_section(all_info, "商品SKU属性")
    title = next((line.strip() for line in title_section.splitlines() if line.strip()), "")
    price_match = re.search(r"([0-9]+(?:\.[0-9]+)?)", price_section)
    return {
        "title": title,
        "price": float(price_match.group(1)) if price_match else None,
        "categories": _parse_category_table(category_section),
        "sku_attributes": _parse_markdown_kv_table(sku_section),
        "all_info": str(all_info or ""),
    }



# ── Public API ──


def search_products(
    query: str,
    *,
    page: int = 1,
    page_size: int = 20,
) -> list[dict[str, Any]]:
    """Search 1688 products by keyword.

    Returns list of product dicts with keys:
    itemId, title, price, image, detailUrl, etc.
    """
    body: dict[str, Any] = {
        "query": query,
        "pageNum": page,
        "pageSize": page_size,
        "purchaseAmount": 1,
        "scoreLevel": "high",
        "tags": "4306497",
    }
    try:
        result = _post_1688(FIND_PRODUCT_API, body)
        data_wrapper = result.get("data", {})
        items = data_wrapper.get("data") or []
        return items if isinstance(items, list) else []
    except Exception:
        return []


def get_product_details(item_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Fetch product details via ainext.1688.com offer_detail API.

    Returns dict mapping item_id -> {item_id, title, price, categories, sku_attributes, all_info, raw}
    """
    if not item_ids:
        return {}
    try:
        result = _post_1688(
            WORKFLOW_API,
            {"code": "offer_detail", "bizParams": {"item_id": [str(i).strip() for i in item_ids]}},
            base_url=AINEXT_BASE_URL,
        )
        model = result.get("model") or {}
        biz_data = model.get("bizData") or {}
        if not isinstance(biz_data, dict):
            return {}
        details: dict[str, dict[str, Any]] = {}
        for item_id, item in biz_data.items():
            if not isinstance(item, dict):
                continue
            nid = str(item_id).strip()
            if not nid:
                continue
            all_info = str(item.get("all_info") or "")
            parsed = parse_offer_detail_info(all_info)
            details[nid] = {
                "item_id": nid,
                "title": parsed["title"],
                "price": parsed["price"],
                "categories": parsed["categories"],
                "sku_attributes": parsed["sku_attributes"],
                "all_info": all_info,
                "raw": item,
            }
        return details
    except Exception:
        return {}


def parse_product_url(url: str) -> dict[str, str] | None:
    """Parse 1688 product URL to extract offer ID."""
    value = str(url or "").strip()
    if not value:
        return None
    # Pure numeric ID
    if re.fullmatch(r"\d{6,18}", value):
        return {
            "platform": "1688",
            "product_id": value,
            "canonical_url": f"https://detail.1688.com/offer/{value}.html",
        }
    # URL parsing
    parsed = urlparse(value)
    path = parsed.path or ""
    m = re.search(r"/offer/(\d+)", path)
    if m:
        pid = m.group(1)
        return {
            "platform": "1688",
            "product_id": pid,
            "canonical_url": f"https://detail.1688.com/offer/{pid}.html",
        }
    # Query param
    for key in ("id", "offerId", "offer_id"):
        m = re.search(rf"{key}=(\d+)", parsed.query or "")
        if m:
            pid = m.group(1)
            return {"platform": "1688", "product_id": pid, "canonical_url": value}
    return None


# ═══════════════════════════════════════════════════════════════════════════════
# Product enrichment — API + CDP merge (one call, all edge cases handled)
# ═══════════════════════════════════════════════════════════════════════════════


def enrich_product_with_cdp(
    detail_url: str,
    *,
    api_data: dict[str, Any] | None = None,
    timeout_seconds: int = 30,
) -> dict[str, Any]:
    """Enrich a 1688 product with CDP browser data.  Single entry point.

    Call this after ``get_product_details()`` — it handles everything:
    Chrome check, login check, CDP probe, API+CDP merge, and graceful
    degradation.  **Never raises** — always returns a structured result.

    Returns::

        {
            'ok': bool,               # CDP probe completed successfully
            'degraded': bool,         # true when CDP was unavailable / partial
            'degraded_reason': str,   # human-readable explanation
            'user_action': str | None, # what the user needs to do (if anything)
            'data': {
                'title': str,
                'price': str,
                'brand': str,
                'seller': str,
                'images': list[str],
                'weight_grams': int | None,
                'packaging_rows': list[dict],
                'sku_details': list[dict],
                'attributes': list[dict],
                'option_groups': list[dict],
            },
            'source': 'api+cdp' | 'api_only' | 'cdp_degraded',
        }

    Agent usage (Worker A Step 2b)::

        enriched = enrich_product_with_cdp(
            detail_url=item['detailUrl'],
            api_data=d,
        )
        # No branching needed — enriched['data'] is always populated.
        # When degraded, images/packaging_rows/etc. are empty lists.
    """
    from scripts.capabilities.browser_probe.service import (
        check_cdp_prerequisites,
        probe_1688_page_safe,
    )

    api = dict(api_data or {})

    # ── Base data from API (always available) ──
    result: dict[str, Any] = {
        'ok': False,
        'degraded': True,
        'degraded_reason': '',
        'user_action': None,
        'data': {
            'title': api.get('title', ''),
            'price': api.get('price', ''),
            'brand': '',
            'seller': '',
            'images': list(api.get('images') or []),
            'weight_grams': None,
            'packaging_rows': [],
            'sku_details': [],
            'attributes': [],
            'option_groups': [],
        },
        'source': 'api_only',
    }

    # ── Check CDP prerequisites ──
    prereqs = check_cdp_prerequisites()
    if not prereqs['browser_available']:
        # Auto-install Playwright Chromium — no user decision needed
        from scripts.capabilities.browser_probe.service import _auto_install_browser, check_cdp_prerequisites as _recheck
        installed = _auto_install_browser()
        if installed:
            prereqs = _recheck()
        else:
            result['degraded_reason'] = (
                '未找到 Chrome/Chromium 浏览器，自动安装 Playwright Chromium 失败。'
                '图片/重量/尺寸将为空，后续制图只能用文字描述生成。'
            )
            result['user_action'] = (
                '请手动安装浏览器: pip install playwright && playwright install chromium'
            )
            return result

    # ── Handle missing session or login: auto-launch + wait ──
    from scripts.capabilities.browser_probe.service import (
        _resolve_browser_session,
        _cdp_available,
        _wait_for_login_session,
        find_browser_executable,
    )

    profile_name = 'default'
    session = _resolve_browser_session(profile_name)
    cdp_url = str(session.get('cdp_url') or '').strip()
    session_alive = bool(cdp_url and _cdp_available(cdp_url))

    if not session_alive or prereqs['login_required']:
        # Auto-launch 1688 login page in Chrome, wait for user to log in
        url = str(detail_url or api.get('detail_url') or '').strip()
        if not url:
            url = 'https://detail.1688.com/'

        resolved_browser = find_browser_executable(None)
        new_session = _wait_for_login_session(
            url,
            profile_name=profile_name,
            browser_path=resolved_browser or '',
            timeout_seconds=max(timeout_seconds, 60),
        )
        if new_session and new_session.get('login_detected'):
            # Success! Continue to probe below
            pass
        elif new_session and new_session.get('cdp_url'):
            # Session created but login not confirmed — still try probe
            pass
        else:
            result['degraded_reason'] = (
                '等待 1688 登录超时。请先在 Chrome 中登录 1688 后重试。'
            )
            result['user_action'] = (
                '请在 Chrome 中打开 https://login.1688.com/member/signin.htm '
                '完成登录（扫码或密码），然后重新运行。'
            )
            return result

    # ── CDP probe ──
    url = str(detail_url or api.get('detail_url') or '').strip()
    if not url:
        result['degraded_reason'] = '缺少 1688 商品链接，无法启动浏览器探测。'
        return result

    probe_result = probe_1688_page_safe(url, timeout_seconds=timeout_seconds)
    probe_data = probe_result.get('data', {})

    if probe_result['ok']:
        result['ok'] = True
        result['degraded'] = False
        result['source'] = 'api+cdp'
    elif probe_result['degraded'] and probe_data.get('images'):
        # Partial success — got some data even though probe wasn't 100%
        result['degraded_reason'] = '部分商品数据未能提取，已获取已有数据。'
        result['source'] = 'cdp_degraded'
    else:
        result['degraded_reason'] = (
            f"浏览器探测失败: {probe_result.get('error', '未知错误')}"
        )
        result['source'] = 'api_only'
        return result

    # ── Merge CDP data over API data ──
    result['data'].update({
        'title': probe_data.get('title') or result['data']['title'],
        'price': probe_data.get('price') or result['data']['price'],
        'brand': probe_data.get('brand') or result['data']['brand'],
        'seller': probe_data.get('seller') or result['data']['seller'],
        'images': probe_data.get('images') or result['data']['images'],
        'weight_grams': probe_data.get('weight_grams') or result['data']['weight_grams'],
        'packaging_rows': probe_data.get('packaging_rows') or [],
        'sku_details': probe_data.get('sku_details') or [],
        'attributes': probe_data.get('attributes') or [],
        'option_groups': probe_data.get('option_groups') or [],
    })

    return result
