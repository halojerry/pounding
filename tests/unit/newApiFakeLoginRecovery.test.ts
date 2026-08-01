/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression tests for the fake-login fix: runtime-config recovery must NOT
 * treat third-party CLI configs (a user's own Anthropic/DeepSeek key in
 * ~/.claude/settings.json or ~/.hermes/config.yaml) as a POUNDING session.
 * Only configs whose base URL points at the POUNDING API count.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false, getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: vi.fn(() => ({ provider: vi.fn(), invoke: vi.fn() })),
    buildEmitter: vi.fn(() => ({ emit: vi.fn(), on: vi.fn() })),
  },
  storage: {
    buildStorage: () => ({
      getSync: () => undefined,
      setSync: () => {},
      get: async () => undefined,
      set: async () => {},
    }),
  },
}));

// better-sqlite3 is a native module — not needed for these pure helpers.
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));

import { __TEST__ } from '@process/bridge/services/NewApiDesktopAccountService';

describe('isPoundingBaseUrl', () => {
  it('accepts the POUNDING API host', () => {
    expect(__TEST__.isPoundingBaseUrl('https://api.mxou.cn')).toBe(true);
    expect(__TEST__.isPoundingBaseUrl('https://api.mxou.cn/')).toBe(true);
    expect(__TEST__.isPoundingBaseUrl('https://api.mxou.cn/v1')).toBe(true);
  });

  it('rejects third-party hosts (the fake-login source)', () => {
    // The exact scenario from the field: Claude CLI configured for DeepSeek.
    expect(__TEST__.isPoundingBaseUrl('https://api.deepseek.com/anthropic')).toBe(false);
    expect(__TEST__.isPoundingBaseUrl('https://api.anthropic.com')).toBe(false);
    expect(__TEST__.isPoundingBaseUrl('https://api.openai.com/v1')).toBe(false);
  });

  it('rejects missing or malformed URLs', () => {
    expect(__TEST__.isPoundingBaseUrl(undefined)).toBe(false);
    expect(__TEST__.isPoundingBaseUrl('')).toBe(false);
    expect(__TEST__.isPoundingBaseUrl('not-a-url')).toBe(false);
  });
});

describe('recoverManagedRuntimeSnapshotFromClaudeSettings', () => {
  let homeDir: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), 'pounding-fakelogin-'));
    process.env.HOME = homeDir;
    // os.homedir() on Windows reads USERPROFILE, not HOME — without this the
    // isolated .claude/settings.json is never seen and the test fails.
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  function writeClaudeSettings(env: Record<string, string>): void {
    const dir = path.join(homeDir, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env }, null, 2));
  }

  it('does NOT recover a session from a third-party base URL', () => {
    writeClaudeSettings({
      ANTHROPIC_AUTH_TOKEN: 'sk-user-own-deepseek-key',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
    });

    const snapshot = __TEST__.recoverManagedRuntimeSnapshotFromClaudeSettings();
    expect(snapshot, 'third-party config must not fake a POUNDING login').toBeUndefined();
  });

  it('does NOT recover a session when base URL is absent', () => {
    writeClaudeSettings({
      ANTHROPIC_AUTH_TOKEN: 'sk-token-of-unknown-origin',
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
    });

    const snapshot = __TEST__.recoverManagedRuntimeSnapshotFromClaudeSettings();
    expect(snapshot, 'token without a POUNDING base URL must not count').toBeUndefined();
  });

  it('recovers a session when the settings point at the POUNDING API', () => {
    writeClaudeSettings({
      ANTHROPIC_AUTH_TOKEN: 'sk-pounding-managed-key',
      ANTHROPIC_BASE_URL: 'https://api.mxou.cn',
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
    });

    const snapshot = __TEST__.recoverManagedRuntimeSnapshotFromClaudeSettings();
    expect(snapshot).toBeTruthy();
    expect(snapshot?.token).toBe('sk-pounding-managed-key');
    expect(snapshot?.baseUrl).toBe('https://api.mxou.cn');
    expect(snapshot?.models).toContain('deepseek-v4-pro');
  });
});
