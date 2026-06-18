#!/usr/bin/env python3
"""Configure — local config management for pounding-ozon-hybrid."""
from __future__ import annotations

import argparse
import json
import os
from typing import Any

from scripts._const import SKILL_ROOT
from scripts._errors import ERR_MISSING_CONFIG
from scripts.lib.config_store import check_config, get, get_required_keys, load_config, save_config

COMMAND_NAME = 'configure'
COMMAND_DESC = '配置管理 — 查看/设置本 skill 的运行配置'


def _cmd_status() -> dict[str, Any]:
    status = check_config()
    config = load_config()
    lines = ['**配置状态**\n']
    for key, label in get_required_keys().items():
        val = config.get(key, os.environ.get(key, ''))
        masked = val[:6] + '****' if val else '(未设置)'
        lines.append(f'- {label}: `{masked}`')
    lines.append('')
    if status['missing']:
        lines.append(f'缺失: {", ".join(status["missing"])}')
    else:
        lines.append('所有必需配置已就绪 ✅')
    return {'success': len(status['missing']) == 0, 'markdown': '\n'.join(lines), 'data': status}


def _cmd_set(key: str, value: str) -> dict[str, Any]:
    save_config({**load_config(), key: value})
    return {'success': True, 'markdown': f'已设置 `{key}`', 'data': {key: '已设置'}}


def _cmd_guide() -> dict[str, Any]:
    lines = [
        '**pounding-ozon-hybrid 配置指南**\n',
        '本 skill 需要以下配置：',
        '',
        '1. 1688 AK（本地搜索用）:',
        '   ```',
        '   python3 cli.py configure set ALI_1688_AK <YOUR_AK>',
        '   ```',
        '',
        '2. Ozon 店铺:',
        '   ```',
        '   python3 cli.py configure set OZON_CLIENT_ID <ID>',
        '   python3 cli.py configure set OZON_API_KEY <KEY>',
        '   ```',
        '',
        '3. 平台 Token（云委托认证）:',
        '   ```',
        '   python3 cli.py configure set MXOU_TOKEN <TOKEN>',
        '   ```',
        '',
        '4. mxou 图片生成 Token（云图片生成）:',
        '   ```',
        '   python3 cli.py configure set MXOU_IMAGE_TOKEN <TOKEN>',
        '   ```',
        '',
        '完成后执行:',
        '   python3 cli.py configure status',
    ]
    return {'success': True, 'markdown': '\n'.join(lines)}


def _cmd_show(key: str) -> dict[str, Any]:
    val = get(key)
    if val:
        masked = str(val)[:6] + '****' if len(str(val)) > 6 else '****'
        return {'success': True, 'markdown': f'`{key}` = `{masked}`', 'data': {key: val}}
    return {'success': False, 'markdown': f'`{key}` 未设置', 'error_code': ERR_MISSING_CONFIG}


def main(args: list[str]) -> int:
    parser = argparse.ArgumentParser(description='配置管理')
    parser.add_argument('action', nargs='?', default='status',
                        choices=['status', 'set', 'guide', 'show'])
    parser.add_argument('key', nargs='?', default='')
    parser.add_argument('value', nargs='?', default='')
    parsed = parser.parse_args(args)

    if parsed.action == 'status':
        result = _cmd_status()
    elif parsed.action == 'set':
        if not parsed.key or not parsed.value:
            result = {'success': False, 'markdown': '用法: configure set <KEY> <VALUE>',
                      'error_code': ERR_MISSING_CONFIG}
        else:
            result = _cmd_set(parsed.key, parsed.value)
    elif parsed.action == 'guide':
        result = _cmd_guide()
    elif parsed.action == 'show':
        result = _cmd_show(parsed.key)
    else:
        result = _cmd_status()

    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return 0 if result['success'] else 1
