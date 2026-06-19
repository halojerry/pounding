#!/usr/bin/env python3
from __future__ import annotations

import json
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any

from scripts._const import DATA_DIR, get_config_profile
from scripts._errors import ConfigError
from scripts.capabilities.browser_probe.service import find_browser_executable


def _profile_dir(profile: str) -> Path:
    path = DATA_DIR / 'browser' / 'profiles' / '1688' / profile
    path.mkdir(parents=True, exist_ok=True)
    return path


def _login_url() -> str:
    return 'https://login.1688.com/member/signin.htm'


def _session_file(profile: str) -> Path:
    path = DATA_DIR / 'browser' / 'sessions'
    path.mkdir(parents=True, exist_ok=True)
    return path / f'1688-{profile}.json'


def _pick_free_port() -> int:
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = int(sock.getsockname()[1])
    sock.close()
    return port


def _write_session(profile: str, payload: dict[str, Any]) -> Path:
    target = _session_file(profile)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    return target


def launch_1688_login_browser(*, profile: str | None = None, browser_path: str | None = None) -> dict[str, Any]:
    resolved_browser = find_browser_executable(browser_path)
    if not resolved_browser:
        raise ConfigError('未找到可用的 Chrome/Chromium 浏览器，请先安装 Google Chrome 或传入 --browser-path')
    profile_name = str(profile or get_config_profile() or 'default').strip() or 'default'
    user_data_dir = _profile_dir(profile_name)
    login_url = _login_url()
    remote_debugging_port = _pick_free_port()
    launch_args = [
        f'--user-data-dir={user_data_dir}',
        '--profile-directory=Default',
        f'--remote-debugging-port={remote_debugging_port}',
        '--new-window',
        login_url,
    ]
    if sys.platform == 'darwin' and resolved_browser.endswith('Google Chrome'):
        subprocess.Popen(['open', '-na', 'Google Chrome', '--args', *launch_args])
    else:
        subprocess.Popen([resolved_browser, *launch_args])
    session_path = _write_session(profile_name, {
        'profile': profile_name,
        'browser_path': resolved_browser,
        'user_data_dir': str(user_data_dir),
        'login_url': login_url,
        'remote_debugging_port': remote_debugging_port,
        'cdp_url': f'http://127.0.0.1:{remote_debugging_port}',
    })
    return {
        'profile': profile_name,
        'browser_path': resolved_browser,
        'user_data_dir': str(user_data_dir),
        'login_url': login_url,
        'remote_debugging_port': remote_debugging_port,
        'cdp_url': f'http://127.0.0.1:{remote_debugging_port}',
        'session_file': str(session_path),
    }
