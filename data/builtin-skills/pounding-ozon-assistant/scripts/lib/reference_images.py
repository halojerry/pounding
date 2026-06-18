#!/usr/bin/env python3
from __future__ import annotations

from typing import Iterable
from urllib.parse import urlparse


def _normalized_url(value: str) -> str:
    return str(value or '').strip()


def is_likely_product_image(url: str) -> bool:
    lowered = str(url or '').strip().lower()
    if not lowered:
        return False
    parsed = urlparse(lowered)
    path = parsed.path or ''
    if not path:
        return False
    image_exts = ('.jpg', '.jpeg', '.png', '.webp', '.avif')
    if not path.endswith(image_exts):
        return False
    bad_tokens = (
        'logo', 'icon', 'sprite', 'avatar', 'banner', 'badge', 'svg', 'gg_dtc',
        'tps-15-', 'tps-16-', 'tps-18-', 'tps-24-', 'tps-28-', 'tps-32-', 'tps-36-', 'tps-44-', 'tps-45-', 'tps-48-', 'tps-64-', 'tps-87-', 'tps-96-', 'tps-120-64', 'tps-200-64',
        'rate.jpg', 'overseas_pic', 'placeholder', '/gw/', 'gw.alicdn.com/imgextra',
    )
    if any(token in lowered for token in bad_tokens):
        return False
    return True


def dedupe_reference_images(urls: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for raw in urls:
        url = _normalized_url(raw)
        if not url:
            continue
        if url in seen:
            continue
        seen.add(url)
        ordered.append(url)
    return ordered


def reference_priority(url: str) -> tuple[int, int, str]:
    lowered = url.lower()
    white_background_hint = 0 if any(token in lowered for token in ('white', '白底', 'cutout', 'isolated')) else 1
    preferred_host = 0 if any(host in lowered for host in ('alicdn.com', '1688.com', 'taobaocdn.com')) else 1
    length_score = -len(url)
    return (white_background_hint, preferred_host, length_score)


def select_reference_images(urls: Iterable[str], limit: int = 4) -> list[str]:
    deduped = dedupe_reference_images(urls)
    filtered = [url for url in deduped if is_likely_product_image(url)] or deduped
    ordered = sorted(filtered, key=reference_priority)
    return ordered[:limit]


def merge_followup_reference_images(white_background_url: str, source_urls: Iterable[str], limit: int = 4) -> list[str]:
    merged = [white_background_url] + list(source_urls)
    deduped = dedupe_reference_images(merged)
    if not deduped:
        return []
    primary = deduped[0]
    rest = select_reference_images(deduped[1:], limit=max(0, limit - 1))
    return [primary] + rest
