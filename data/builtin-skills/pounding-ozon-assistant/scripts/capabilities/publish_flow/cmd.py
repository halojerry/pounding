#!/usr/bin/env python3
"""Publish flow — full publish chain via cloud delegation."""
from __future__ import annotations

import argparse
import json
import os
import uuid
from pathlib import Path
from typing import Any

from scripts.lib.cloud_client import build_envelope, submit_task

COMMAND_NAME = 'publish_flow'
COMMAND_DESC = '完整发布链路 — 组装信封提交云端执行发布'


def _resolve_source(publish_args: argparse.Namespace) -> dict[str, Any]:
    source: dict[str, Any] = {}
    if publish_args.query:
        source['query'] = publish_args.query
    if publish_args.url:
        source['source_url'] = publish_args.url
        source['source_item_id'] = publish_args.url.rstrip('/').split('/')[-1]
    if publish_args.product_id:
        source['product_id'] = publish_args.product_id
    if publish_args.offer_id:
        source['offer_id'] = publish_args.offer_id
    return source


def _resolve_assets(publish_args: argparse.Namespace) -> dict[str, Any]:
    assets: dict[str, Any] = {}
    if publish_args.image:
        assets['image_urls'] = [publish_args.image] if isinstance(publish_args.image, str) else publish_args.image
    return assets


def _resolve_draft(publish_args: argparse.Namespace) -> dict[str, Any]:
    draft: dict[str, Any] = {}
    if publish_args.draft_file:
        draft_path = Path(publish_args.draft_file)
        if draft_path.is_file():
            try:
                draft_content = json.loads(draft_path.read_text(encoding='utf-8'))
                if isinstance(draft_content, dict):
                    draft = draft_content
                else:
                    draft['content'] = draft_content
            except (json.JSONDecodeError, OSError) as exc:
                raise ValueError(f'无效的 draft 文件: {draft_path}') from exc
    if publish_args.assets_file:
        assets_path = Path(publish_args.assets_file)
        if assets_path.is_file():
            try:
                assets_content = json.loads(assets_path.read_text(encoding='utf-8'))
                if isinstance(assets_content, dict):
                    draft['assets_override'] = assets_content
                else:
                    draft['assets_override'] = {'urls': assets_content}
            except (json.JSONDecodeError, OSError) as exc:
                raise ValueError(f'无效的 assets 文件: {assets_path}') from exc
    return draft


def main(args: list[str]) -> int:
    parser = argparse.ArgumentParser(description='完整发布链路（云委托）')
    parser.add_argument('--query', '-q', default='', help='搜索关键词')
    parser.add_argument('--url', '-u', default='', help='1688 商品链接')
    parser.add_argument('--draft-file', '-d', default='', help='draft 文件路径')
    parser.add_argument('--assets-file', '-a', default='', help='assets 文件路径')
    parser.add_argument('--image', '-i', action='append', help='图片 URL（可重复）')
    parser.add_argument('--product-id', help='Ozon product_id（翻新用）')
    parser.add_argument('--offer-id', help='Ozon offer_id')
    parser.add_argument('--project-id', default='', help='项目 ID（不传则自动生成）')
    parser.add_argument('--store-id', default='', help='店铺 ID（用于多店铺场景）')
    parser.add_argument('--dry-run', action='store_true', help='只校验不提交')
    parser.add_argument('--poll-status', action='store_true', help='提交后轮询直到完成')
    parser.add_argument('--max-polls', type=int, default=60, help='最大轮询次数')
    parsed = parser.parse_args(args)

    project_id = parsed.project_id or f'proj_{uuid.uuid4().hex[:12]}'
    subproject_id = f'item_{uuid.uuid4().hex[:8]}'

    try:
        source = _resolve_source(parsed)
        assets = _resolve_assets(parsed)
        draft = _resolve_draft(parsed)
    except ValueError as exc:
        result = {
            'success': False,
            'markdown': f'**发布链路校验失败**\n\n- {exc}',
            'error_code': 'INVALID_INPUT',
        }
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
        return 1

    envelope = build_envelope(
        project_id=project_id,
        subproject_id=subproject_id,
        source=source,
        assets=assets,
        draft=draft,
        store_id=parsed.store_id,
    )

    if parsed.dry_run:
        result = {
            'version': 'v1',
            'project_id': project_id,
            'subproject_id': subproject_id,
            'request_id': envelope['request_id'],
            'dry_run': True,
            'envelope': envelope,
            'message': '信封校验通过（dry-run 模式，未提交云端）',
        }
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
        return 0

    result = submit_task(
        envelope,
        poll=parsed.poll_status,
        max_polls=parsed.max_polls,
        poll_interval_sec=3.0,
    )

    # Build markdown summary
    status = result.get('status', 'unknown')
    task_id = result.get('task_id', 'N/A')
    error = result.get('error')

    md_lines = [
        '**发布链路结果**\n',
        f'- Project ID: `{project_id}`',
        f'- Subproject ID: `{subproject_id}`',
        f'- Task ID: `{task_id}`',
        f'- 状态: `{status}`',
    ]
    if error:
        md_lines.append(f'- 错误: `{error.get("code", "")}` — {error.get("message", "")}')
    md_lines.append(f'- 请求来源: `{source.get("source_url") or source.get("query", "N/A")}`')

    result['markdown'] = '\n'.join(md_lines)
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return 0 if status in ('succeeded', 'accepted', 'queued', 'running') else 1
