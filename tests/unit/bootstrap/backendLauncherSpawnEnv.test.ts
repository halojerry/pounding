/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import path from 'path';

vi.stubEnv('HOME', '/fake-pounding-home');
vi.stubEnv('PATH', '/usr/bin:/bin');
delete process.env.BUN_INSTALL;

import { buildSpawnEnv } from '../../../packages/web-host/src/backend-launcher';

describe('buildSpawnEnv managed CLI PATH injection', () => {
  it('prepends the managed CLI bin dirs so the backend doctor can spawn shims', () => {
    const env = buildSpawnEnv({ cacheDir: '/c', workDir: '/w', logDir: '/l' });
    const parts = (env.PATH ?? '').split(path.delimiter);

    // ~/.local/bin first (hermes/claude/openclaw shims), then ~/.bun/bin
    expect(parts[0]).toBe(path.join('/fake-pounding-home', '.local', 'bin'));
    expect(parts[1]).toBe(path.join('/fake-pounding-home', '.bun', 'bin'));
    // Original PATH is retained after the injected entries
    expect(parts.slice(2)).toContain('/usr/bin');
    expect(parts.slice(2)).toContain('/bin');
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
    } finally {
      delete process.env.BUN_INSTALL;
    }
  });
});
