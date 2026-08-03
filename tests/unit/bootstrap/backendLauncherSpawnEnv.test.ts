/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'path';

vi.stubEnv('HOME', '/fake-pounding-home');
vi.stubEnv('PATH', '/usr/bin:/bin');
delete process.env.BUN_INSTALL;

import { buildSpawnEnv, resolveManagedPathEntries } from '../../../packages/web-host/src/backend-launcher';

describe('buildSpawnEnv managed CLI PATH injection', () => {
  it('prepends the managed CLI bin dirs so the backend doctor can spawn shims', () => {
    const env = buildSpawnEnv({ cacheDir: '/c', workDir: '/w', logDir: '/l' });
    const parts = (env.PATH ?? '').split(path.delimiter);

    // ~/.local/bin first (hermes/claude/openclaw shims), then ~/.bun/bin
    expect(parts[0]).toBe(path.join('/fake-pounding-home', '.local', 'bin'));
    expect(parts[1]).toBe(path.join('/fake-pounding-home', '.bun', 'bin'));
    // Original PATH is retained verbatim after the injected entries
    expect(env.PATH).toContain('/usr/bin:/bin');
    // AIONUI_* dirs are still forwarded
    expect(env.AIONUI_CACHE_DIR).toBe('/c');
    expect(env.AIONUI_WORK_DIR).toBe('/w');
    expect(env.AIONUI_LOG_DIR).toBe('/l');
  });

  it('honors BUN_INSTALL when set', () => {
    vi.stubEnv('BUN_INSTALL', '/custom-bun');
    try {
      const env = buildSpawnEnv({ cacheDir: '/c', workDir: '/w', logDir: '/l' });
      const parts = (env.PATH ?? '').split(path.delimiter);
      expect(parts[1]).toBe(path.join('/custom-bun', 'bin'));
      expect(env.PATH).toContain('/usr/bin:/bin');
    } finally {
      delete process.env.BUN_INSTALL;
    }
  });
});

describe('resolveManagedPathEntries', () => {
  it('prepends user override dirs before managed defaults, exe paths reduced to parent', () => {
    const entries = resolveManagedPathEntries('/home/u', '/home/u/.bun/bin', {
      claude: '/opt/claude/bin/claude',
    });
    expect(entries[0]).toBe('/opt/claude/bin');
    expect(entries).toContain('/home/u/.local/bin');
    expect(entries).toContain('/home/u/.bun/bin');
  });

  it('treats .cmd/.exe values as file paths and uses their parent dir', () => {
    const entries = resolveManagedPathEntries('/home/u', '/home/u/.bun/bin', {
      hermes: path.join('/x', 'hermes', 'hermes.cmd'),
    });
    expect(entries[0]).toBe(path.join('/x', 'hermes'));
  });

  it('treats plain dir values as-is and dedupes repeated dirs', () => {
    const entries = resolveManagedPathEntries('/home/u', '/home/u/.bun/bin', {
      openclaw: '/opt/oc',
      claude: '/opt/oc',
    });
    expect(entries[0]).toBe('/opt/oc');
    expect(entries.filter((entry) => entry === '/opt/oc')).toHaveLength(1);
  });

  it('returns only managed defaults when no overrides are given', () => {
    const entries = resolveManagedPathEntries('/home/u', '/home/u/.bun/bin', {});
    expect(entries).toEqual(['/home/u/.local/bin', '/home/u/.bun/bin']);
  });
});

describe('buildSpawnEnv cli-paths.json overrides', () => {
  it('prepends user CLI dirs from cli-paths.json ahead of managed defaults', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pounding-cli-paths-'));
    try {
      vi.stubEnv('HOME', home);
      mkdirSync(path.join(home, '.pounding'), { recursive: true });
      writeFileSync(
        path.join(home, '.pounding', 'cli-paths.json'),
        JSON.stringify({ claude: '/opt/claude/bin/claude' }),
        'utf8'
      );
      const env = buildSpawnEnv({ cacheDir: '/c', workDir: '/w', logDir: '/l' });
      const parts = (env.PATH ?? '').split(path.delimiter);
      expect(parts[0]).toBe('/opt/claude/bin');
      expect(parts).toContain(path.join(home, '.local', 'bin'));
      expect(env.PATH).toContain('/usr/bin:/bin');
    } finally {
      vi.stubEnv('HOME', '/fake-pounding-home');
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores a missing cli-paths.json and falls back to managed defaults', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pounding-cli-paths-'));
    try {
      vi.stubEnv('HOME', home);
      const env = buildSpawnEnv({ cacheDir: '/c', workDir: '/w', logDir: '/l' });
      const parts = (env.PATH ?? '').split(path.delimiter);
      expect(parts[0]).toBe(path.join(home, '.local', 'bin'));
      expect(parts[1]).toBe(path.join(home, '.bun', 'bin'));
      expect(env.PATH).toContain('/usr/bin:/bin');
    } finally {
      vi.stubEnv('HOME', '/fake-pounding-home');
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores a malformed cli-paths.json and falls back to managed defaults', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pounding-cli-paths-'));
    try {
      vi.stubEnv('HOME', home);
      mkdirSync(path.join(home, '.pounding'), { recursive: true });
      writeFileSync(path.join(home, '.pounding', 'cli-paths.json'), '{oops', 'utf8');
      const env = buildSpawnEnv({ cacheDir: '/c', workDir: '/w', logDir: '/l' });
      const parts = (env.PATH ?? '').split(path.delimiter);
      expect(parts[0]).toBe(path.join(home, '.local', 'bin'));
      expect(parts[1]).toBe(path.join(home, '.bun', 'bin'));
      expect(env.PATH).toContain('/usr/bin:/bin');
    } finally {
      vi.stubEnv('HOME', '/fake-pounding-home');
      rmSync(home, { recursive: true, force: true });
    }
  });
});
