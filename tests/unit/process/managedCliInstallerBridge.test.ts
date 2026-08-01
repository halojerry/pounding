/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const httpRequestMock = vi.hoisted(() => vi.fn());
const reconcileMock = vi.hoisted(() => vi.fn());

// Isolate home dir so detectPaths (~/.local/bin, ~/.bun/bin) never hit a
// real locally-installed CLI before the module-level constants are evaluated.
// Force-overwrite (no `||` fallback) — the test runner's HOME is real.
vi.hoisted(() => {
  process.env.HOME = '/nonexistent-pounding-test-home';
  process.env.BUN_INSTALL = '/nonexistent-pounding-test-bun';
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: httpRequestMock,
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  ipcBridge: {},
}));

vi.mock('@/common', () => ({
  ipcBridge: {},
}));

vi.mock('@/common/config/appEnv', () => ({
  getEnvAwareName: (name: string) => name,
}));

vi.mock('./services/NewApiDesktopAccountService', () => ({
  newApiDesktopAccountService: {
    reconcileManagedRuntimeState: reconcileMock,
    clearManagedRuntimeForCliTarget: vi.fn(),
  },
}));

import {
  installManagedCliBatch,
  resolveBundledPythonBinary,
} from '@/process/bridge/managedCliInstallerBridge';

function makeBundledPythonFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pounding-bridge-test-'));
  // Single-level python-build-standalone layout (as vendored by prepare-vendor.sh)
  const unixBin = path.join(root, 'runtimes', 'python', 'bin');
  const winBin = path.join(root, 'runtimes', 'python');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('fs').mkdirSync(unixBin, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('fs').writeFileSync(path.join(unixBin, 'python3'), '');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('fs').writeFileSync(path.join(winBin, 'python.exe'), '');
  // Legacy nested layout must NOT be hit (regression guard)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('fs').mkdirSync(path.join(root, 'runtimes', 'python', 'python', 'bin'), { recursive: true });
  return root;
}

describe('resolveBundledPythonBinary', () => {
  const fixtures: string[] = [];

  beforeEach(() => {
    fixtures.push(makeBundledPythonFixture());
  });

  afterEach(() => {
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
    fixtures.length = 0;
  });

  it('resolves the single-level unix layout (runtimes/python/bin/python3)', () => {
    const base = fixtures[0]!;
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      expect(resolveBundledPythonBinary(base)).toBe(path.join(base, 'runtimes', 'python', 'bin', 'python3'));
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('resolves python.exe on win32 (no python3.exe in python-build-standalone)', () => {
    const base = fixtures[0]!;
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(resolveBundledPythonBinary(base)).toBe(path.join(base, 'runtimes', 'python', 'python.exe'));
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('returns null for missing runtime and for the legacy nested layout', () => {
    expect(resolveBundledPythonBinary(null)).toBeNull();
    expect(resolveBundledPythonBinary('/nonexistent/dir')).toBeNull();
  });
});

describe('installManagedCli version pins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    httpRequestMock.mockResolvedValue(undefined);
    reconcileMock.mockResolvedValue(undefined);
  });

  it('installs claude pinned to CLAUDE_CLI_VERSION (2.1.215)', async () => {
    // 1st probe (which claude): not installed → reject
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e?: Error) => void) => {
      cb(new Error('not found'));
    });
    // npm install -g @anthropic-ai/claude-code@2.1.215 → resolve
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e?: Error) => void) => {
      cb();
    });
    // 2nd probe (which claude): installed → resolve
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e?: Error) => void) => {
      cb();
    });

    const [result] = await installManagedCliBatch(['claude']);

    expect(result.success).toBe(true);
    const installCall = execFileMock.mock.calls.find((call) =>
      (call[1] as string[]).includes('install')
    );
    expect(installCall).toBeDefined();
    expect(installCall![1]).toContain('install');
    expect(installCall![1]).toContain('-g');
    expect(installCall![1]).toContain('@anthropic-ai/claude-code@2.1.215');
  });

  it('installs openclaw pinned to OPENCLAW_VERSION (2026.6.33)', async () => {
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e?: Error) => void) => {
      cb(new Error('not found'));
    });
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e?: Error) => void) => {
      cb();
    });
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e?: Error) => void) => {
      cb();
    });

    const [result] = await installManagedCliBatch(['openclaw']);

    expect(result.success).toBe(true);
    const installCall = execFileMock.mock.calls.find((call) =>
      (call[1] as string[]).includes('install')
    );
    expect(installCall).toBeDefined();
    expect(installCall![1]).toContain('openclaw@2026.6.33');
  });
});
