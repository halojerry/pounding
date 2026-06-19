"""Thin Ozon REST API client — inlined from pounding-ozon-cloud.

This module replaces the pounding-ozon-cloud dependency.  Only the functions
actually used by cloud_client.py are ported; the heavier cloud-only modules
(COS, Windmill, orchestration, attribute resolution, etc.) are not needed here.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)

OZON_BASE_URL = "https://api-seller.ozon.ru"

# ---------------------------------------------------------------------------
# Custom exception (replaces pounding_ozon_cloud.domain.OzonApiError)
# ---------------------------------------------------------------------------


class OzonApiError(RuntimeError):
    """Raised when Ozon API calls fail."""
    pass


# ---------------------------------------------------------------------------
# Session pool — reduces TLS handshake overhead for repeated API calls
# ---------------------------------------------------------------------------

_ozon_session: requests.Session | None = None


def _get_session() -> requests.Session:
    global _ozon_session
    if _ozon_session is None:
        s = requests.Session()
        retries = Retry(total=2, backoff_factor=0.5, allowed_methods={"POST"})
        adapter = HTTPAdapter(max_retries=retries, pool_connections=10, pool_maxsize=10)
        s.mount("https://", adapter)
        _ozon_session = s
    return _ozon_session


def _ozon_headers(client_id: str, api_key: str) -> dict[str, str]:
    if not client_id or not api_key:
        raise OzonApiError("缺少 Ozon 凭证，无法访问 Ozon API")
    return {
        "Client-Id": client_id,
        "Api-Key": api_key,
        "Content-Type": "application/json",
    }


def _post(
    client_id: str, api_key: str, path: str, body: dict[str, Any], timeout: int = 20
) -> dict[str, Any]:
    response = _get_session().post(
        f"{OZON_BASE_URL}{path}",
        headers=_ozon_headers(client_id, api_key),
        json=body,
        timeout=timeout,
    )
    try:
        payload = response.json()
    except Exception as exc:
        raise OzonApiError(f"Ozon 返回非 JSON: {response.text[:500]}") from exc
    if response.status_code >= 400:
        raise OzonApiError(f"Ozon API 请求失败 ({response.status_code}): {payload}")
    return payload


# ---------------------------------------------------------------------------
# Private helpers (only used internally by the public functions below)
# ---------------------------------------------------------------------------


def _query_category_tree(
    client_id: str, api_key: str, language: str = "ZH_HANS"
) -> list[dict[str, Any]]:
    payload = _post(
        client_id, api_key, "/v1/description-category/tree", {"language": language}
    )
    return list(payload.get("result") or [])


def _get_import_info(
    client_id: str, api_key: str, task_id: str
) -> dict[str, Any]:
    return _post(
        client_id, api_key,
        "/v1/product/import/info",
        {"task_id": int(task_id)},
        timeout=30,
    )


# ---------------------------------------------------------------------------
# Public API — the 8 functions used by cloud_client.py
# ---------------------------------------------------------------------------


def search_categories(
    client_id: str,
    api_key: str,
    query: str,
    *,
    language: str = "ZH_HANS",
    max_results: int = 10,
) -> list[dict[str, Any]]:
    """Search Ozon category tree by keyword and return matching leaf types.

    Fetches the full category tree, then searches for matching category/type
    names.  Returns a list of candidates, each with: description_category_id,
    type_id, category_name, type_name, score.
    """
    tree = _query_category_tree(client_id, api_key, language=language)
    query_lower = query.strip().lower()
    results: list[dict[str, Any]] = []

    def _walk(
        nodes: list[dict[str, Any]],
        parent_desc_cat_id: int | None,
        parent_name: str = "",
    ) -> None:
        for node in nodes:
            desc_cat_id = node.get("description_category_id")
            type_id = node.get("type_id")
            category_name = node.get("category_name", "") or ""
            type_name = node.get("type_name", node.get("category_name", "")) or ""
            children = node.get("children") or []

            name_to_search = (type_name or category_name or "").lower()

            score = 0
            if query_lower in name_to_search:
                if name_to_search == query_lower:
                    score = 1
                elif name_to_search.startswith(query_lower):
                    score = 2
                else:
                    score = 3

            if score > 0:
                results.append({
                    "description_category_id": desc_cat_id or parent_desc_cat_id,
                    "type_id": type_id,
                    "category_name": parent_name or category_name,
                    "type_name": type_name or category_name,
                    "score": score,
                })

            if children:
                _walk(children, desc_cat_id or parent_desc_cat_id, category_name)

    _walk(tree, None)
    results.sort(key=lambda r: (r["score"], r.get("category_name", "")))
    return results[:max_results]


def list_product_infos(
    client_id: str,
    api_key: str,
    *,
    product_ids: list[str] | None = None,
    offer_ids: list[str] | None = None,
    skus: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Look up Ozon product info by product_id, offer_id, or SKU.

    POST /v3/product/info/list
    """
    payload = _post(
        client_id,
        api_key,
        "/v3/product/info/list",
        {
            "product_id": [str(item) for item in (product_ids or [])],
            "offer_id": [str(item) for item in (offer_ids or [])],
            "sku": [str(item) for item in (skus or [])],
        },
        timeout=30,
    )
    return list(payload.get("items") or [])


def get_product_attributes_v4(
    client_id: str,
    api_key: str,
    *,
    product_ids: list[str] | None = None,
    offer_ids: list[str] | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """Get product attributes via /v4/product/info/attributes."""
    filter_payload: dict[str, Any] = {}
    if product_ids:
        filter_payload["product_id"] = [str(item) for item in product_ids]
    if offer_ids:
        filter_payload["offer_id"] = [str(item) for item in offer_ids]
    payload = _post(
        client_id,
        api_key,
        "/v4/product/info/attributes",
        {
            "filter": filter_payload,
            "limit": int(limit),
            "sort_dir": "ASC",
        },
        timeout=30,
    )
    return payload


def import_by_sku(
    client_id: str, api_key: str, items: list[dict[str, Any]]
) -> dict[str, Any]:
    """Copy a product from another seller by SKU (跟卖).

    POST /v1/product/import-by-sku
    items: [{"sku": 298789742, "name": "...", "offer_id": "...", ...}]

    Returns {"task_id": int, "unmatched_sku_list": [...]}
    """
    payload = _post(
        client_id, api_key,
        "/v1/product/import-by-sku",
        {"items": items},
        timeout=30,
    )
    return payload.get("result", payload)


def list_products(
    client_id: str,
    api_key: str,
    *,
    last_id: str = "",
    limit: int = 100,
    visibility: str = "ALL",
) -> dict[str, Any]:
    """List products in the store. POST /v3/product/list."""
    return _post(
        client_id,
        api_key,
        "/v3/product/list",
        {
            "filter": {"visibility": visibility},
            "last_id": last_id,
            "limit": int(limit),
        },
        timeout=30,
    )


def detect_contract_currency(
    client_id: str, api_key: str, limit: int = 3
) -> str | None:
    """Auto-detect the store's contract currency from existing products.

    POST /v5/product/info/prices — returns the first recognised currency code
    (RUB, CNY, USD, EUR) or None.
    """
    payload = _post(
        client_id,
        api_key,
        "/v5/product/info/prices",
        {
            "filter": {"visibility": "ALL"},
            "cursor": "",
            "limit": int(limit),
        },
        timeout=30,
    )
    items = payload.get("items") or []
    for item in items:
        if not isinstance(item, dict):
            continue
        direct = str(item.get("currency_code") or "").strip().upper()
        if direct in {"RUB", "CNY", "USD", "EUR"}:
            return direct
        price = item.get("price") or {}
        if isinstance(price, dict):
            nested = str(price.get("currency_code") or "").strip().upper()
            if nested in {"RUB", "CNY", "USD", "EUR"}:
                return nested
    return None


# ---------------------------------------------------------------------------
# Follow-sell (跟卖) helpers
# ---------------------------------------------------------------------------


def poll_import_task(
    client_id: str,
    api_key: str,
    task_id: str | int,
    *,
    max_wait_seconds: int = 300,
    poll_interval_seconds: int = 5,
) -> dict[str, Any]:
    """Poll /v1/product/import/info until the import task completes.

    Returns a dict with:
      - status: "completed" | "failed" | "timeout" | "copy_denied" | "already_imported"
      - product_id: str | None
      - offer_id: str | None
      - raw: the final API response
    """
    deadline = time.monotonic() + max_wait_seconds
    task_id_int = int(task_id)

    while time.monotonic() < deadline:
        try:
            info = _get_import_info(client_id, api_key, str(task_id_int))
        except Exception as exc:
            logger.warning("poll_import_task(%s): API error: %s", task_id, exc)
            time.sleep(poll_interval_seconds)
            continue

        result = info.get("result", info)
        items = result.get("items") or []
        first_item = items[0] if items else {}
        item_status = str(first_item.get("status") or "").lower()

        # Check for copy-related errors in items
        item_errors = first_item.get("errors") or []
        copy_denied_codes = (
            "foreign_seller_card_copy_denied",
            "copy_protection",
            "copy_denied",
            "copy_forbidden",
        )
        already_imported_codes = (
            "updating_with_seller_sku",
            "sku_already_exists",
            "duplicate_sku",
        )
        copy_errors = [
            e
            for e in item_errors
            if str(e.get("code", "")).lower() in copy_denied_codes
            or any(
                s in str(e.get("description", "")).lower()
                for s in ("невозможно скопировать", "copy", "копирова")
            )
        ]
        already_imported = any(
            str(e.get("code", "")).lower() in already_imported_codes
            for e in item_errors
        )

        if item_status in ("success", "completed", "done", "imported"):
            if copy_errors:
                error_descs = "; ".join(
                    str(
                        e.get("description")
                        or e.get("message")
                        or e.get("code", "")
                    )
                    for e in copy_errors
                )
                return {
                    "status": "copy_denied",
                    "product_id": str(first_item.get("product_id", "")),
                    "offer_id": str(first_item.get("offer_id", "")),
                    "error": error_descs,
                    "copy_errors": copy_errors,
                    "raw": result,
                }
            return {
                "status": "completed",
                "product_id": str(first_item.get("product_id", "")),
                "offer_id": str(first_item.get("offer_id", "")),
                "raw": result,
            }

        if item_status in ("failed", "error", "cancelled"):
            if already_imported:
                return {
                    "status": "already_imported",
                    "product_id": str(first_item.get("product_id", "")),
                    "offer_id": str(first_item.get("offer_id", "")),
                    "error": str(
                        first_item.get("errors", [{}])[0].get("description", "")
                        if first_item.get("errors")
                        else ""
                    ),
                    "raw": result,
                }
            if copy_errors:
                error_descs = "; ".join(
                    str(
                        e.get("description")
                        or e.get("message")
                        or e.get("code", "")
                    )
                    for e in copy_errors
                )
                return {
                    "status": "copy_denied",
                    "product_id": str(first_item.get("product_id", "")),
                    "offer_id": str(first_item.get("offer_id", "")),
                    "error": error_descs,
                    "copy_errors": copy_errors,
                    "raw": result,
                }
            error_msg = str(
                result.get("error")
                or result.get("message")
                or first_item.get("error")
                or ""
            )
            return {
                "status": "failed",
                "product_id": None,
                "offer_id": None,
                "error": error_msg,
                "raw": result,
            }

        time.sleep(poll_interval_seconds)

    return {
        "status": "timeout",
        "product_id": None,
        "offer_id": None,
        "error": f"Import task {task_id} did not complete within {max_wait_seconds}s",
        "raw": {},
    }


def update_existing_product(
    client_id: str,
    api_key: str,
    *,
    product_id: str,
    offer_id: str,
    name: str = "",
    images: list[str] | None = None,
    price: str = "",
    old_price: str = "",
    vat: str = "0.0",
    attributes: list[dict[str, Any]] | None = None,
    currency_code: str = "RUB",
    depth: int = 0,
    width: int = 0,
    height: int = 0,
    dimension_unit: str = "mm",
    weight: int = 0,
    weight_unit: str = "g",
) -> dict[str, Any]:
    """Update an existing Ozon product via /v3/product/import.

    Provide product_id to update instead of create.
    Only non-empty fields will be included in the update payload.
    """
    item: dict[str, Any] = {
        "product_id": int(product_id),
        "offer_id": str(offer_id),
    }

    if name:
        item["name"] = str(name)
    if images:
        item["images"] = [str(url) for url in images]
    if price:
        item["price"] = str(price)
        item["currency_code"] = str(currency_code)
    if old_price:
        item["old_price"] = str(old_price)
    if attributes:
        item["attributes"] = attributes
    if vat:
        item["vat"] = str(vat)

    if depth > 0:
        item["depth"] = depth
        item["dimension_unit"] = dimension_unit
    if width > 0:
        item["width"] = width
    if height > 0:
        item["height"] = height
    if weight > 0:
        item["weight"] = weight
        item["weight_unit"] = weight_unit

    # Auto-fetch category info from existing product if not in attributes
    if "description_category_id" not in item:
        try:
            infos = list_product_infos(
                client_id, api_key, product_ids=[str(product_id)]
            )
            if infos:
                existing = infos[0]
                cat_id = existing.get("description_category_id") or existing.get(
                    "category_id"
                )
                type_id = existing.get("type_id")
                if cat_id:
                    item["description_category_id"] = int(cat_id)
                if type_id:
                    item["type_id"] = int(type_id)
        except Exception:
            pass

    try:
        result = _post(
            client_id, api_key, "/v3/product/import", {"items": [item]}, timeout=30
        )
        task_id = str(((result.get("result") or {}).get("task_id", "")))
        return {
            "ok": True,
            "task_id": task_id,
            "product_id": product_id,
            "offer_id": offer_id,
        }
    except Exception as exc:
        logger.exception("update_existing_product(%s) failed", product_id)
        return {
            "ok": False,
            "error": str(exc),
            "product_id": product_id,
            "offer_id": offer_id,
        }
