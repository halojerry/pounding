/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const httpRequestMock = vi.hoisted(() => vi.fn());
const reconcileMock = vi.hoisted(() => vi.fn());

// Isolate home dir so detectPaths (~/.local/bin, ~/.bun/bin) never hit a
// real locally-installed CLI before the module-level constants are evaluated.
// The home must be writable (materializeFromBundled copies the CLI shim there),
// so it lives under the OS tmp dir instead of a non-existent root path.
vi.hoisted(() => {
  const { tmpdir } = require('node:os');
  const path = require('node:path');
  process.env.HOME = path.join(tmpdir(), 'pounding-cli-test-home');
  process.env.BUN_INSTALL = path.join(tmpdir(), 'pounding-cli-test-bun');
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
  buildCosCliBundleUrl,
  type CosBundleDownloader,
  getManagedNpmBinDir,
  installManagedCli,
  installManagedCliBatch,
} from '@/process/bridge/managedCliInstallerBridge';

describe('installManagedCli version pins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Some tests set a persistent mockImplementation; reset it so it does
    // not leak into subsequent tests (clearAllMocks only clears call data).
    execFileMock.mockReset();
    // The hoisted HOME/BUN_INSTALL are fixed tmp paths shared across tests
    // and runs — clean leftover shims/prefix so no CLI ever looks
    // "already installed" via the filesystem (short-circuits install paths).
    rmSync(path.join(process.env.HOME!, '.local'), { recursive: true, force: true });
    rmSync(path.join(process.env.BUN_INSTALL!, 'install'), { recursive: true, force: true });
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
    const installCall = execFileMock.mock.calls.find((call) => (call[1] as string[]).includes('install'));
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
    const installCall = execFileMock.mock.calls.find((call) => (call[1] as string[]).includes('install'));
    expect(installCall).toBeDefined();
    expect(installCall![1]).toContain('openclaw@2026.6.33');
  });

  it('uses the bundled managed npm (offline bundle) instead of system npm', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pounding-managed-npm-'));
    // Fixture mirrors the managed-resources layout for the CURRENT platform
    // (resolveBundledResourcesDir builds the key as `${platform}-${arch}`):
    //   unix:  node/<ver>/bin/{node,npm}
    //   win32: node/<ver>/{node.exe,npm.cmd}
    const platformKey = `${process.platform}-${process.arch}`;
    const isWin = process.platform === 'win32';
    const nodeDir = isWin
      ? path.join(root, 'bundled-poundingcore', platformKey, 'managed-resources', 'node', `node-v24.0.0-${platformKey}`)
      : path.join(
          root,
          'bundled-poundingcore',
          platformKey,
          'managed-resources',
          'node',
          `node-v24.0.0-${platformKey}`,
          'bin'
        );
    const nodeName = isWin ? 'node.exe' : 'node';
    const npmName = isWin ? 'npm.cmd' : 'npm';
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(path.join(nodeDir, nodeName), '');
    writeFileSync(path.join(nodeDir, npmName), '');

    const originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath;
    Object.defineProperty(process, 'resourcesPath', { value: root, configurable: true });
    try {
      // probe not-installed → install via managed npm → probe installed
      execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e?: Error) => void) => {
        cb(new Error('not found'));
      });
      let managedNpmCommand: string | null = null;
      execFileMock.mockImplementationOnce((cmd: string, args: string[], _o: unknown, cb: (e?: Error) => void) => {
        if ((args as string[]).includes('install')) {
          managedNpmCommand = cmd;
        }
        cb();
      });
      execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e?: Error) => void) => {
        cb();
      });

      const result = await installManagedCli({ target: 'claude' });
      expect(result.success).toBe(true);
      expect(managedNpmCommand).toBe(path.join(nodeDir, npmName));
    } finally {
      if (originalResourcesPath === undefined) {
        delete (process as { resourcesPath?: string }).resourcesPath;
      } else {
        Object.defineProperty(process, 'resourcesPath', { value: originalResourcesPath, configurable: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the bundled Python runtime for hermes instead of system python3', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pounding-managed-py-'));
    const platformKey = `${process.platform}-${process.arch}`;
    const isWin = process.platform === 'win32';
    // Fixture mirrors the managed-resources layout for the CURRENT platform:
    //   runtimes/python/bin/python3 (unix) / runtimes/python/python.exe (win32)
    const pythonRoot = path.join(root, 'bundled-poundingcore', platformKey, 'managed-resources', 'runtimes', 'python');
    const pythonDir = isWin ? pythonRoot : path.join(pythonRoot, 'bin');
    const pythonName = isWin ? 'python.exe' : 'python3';
    mkdirSync(pythonDir, { recursive: true });
    writeFileSync(path.join(pythonDir, pythonName), '');

    const originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath;
    Object.defineProperty(process, 'resourcesPath', { value: root, configurable: true });
    try {
      let venvPython: string | null = null;
      let installed = false;
      execFileMock.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e?: Error) => void) => {
        const argv = args as string[];
        if (argv.includes('-m') && argv.includes('venv')) {
          // create venv with the bundled python
          venvPython = cmd;
          cb();
          return { unref: () => {} };
        }
        if (argv.includes('pip') && argv.includes('install')) {
          installed = true;
          cb();
          return { unref: () => {} };
        }
        // probe (which hermes): only reports installed after pip succeeded
        if (installed) {
          cb();
        } else {
          cb(new Error('not found'));
        }
        return { unref: () => {} };
      });

      const [result] = await installManagedCliBatch(['hermes']);

      expect(result.success).toBe(true);
      expect(venvPython).toBe(path.join(pythonDir, pythonName));
    } finally {
      if (originalResourcesPath === undefined) {
        delete (process as { resourcesPath?: string }).resourcesPath;
      } else {
        Object.defineProperty(process, 'resourcesPath', { value: originalResourcesPath, configurable: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins npm global installs to the managed prefix and writes a claude shim', async () => {
    // The hoisted test HOME/BUN_INSTALL are fixed tmp paths shared across
    // runs — clean any leftover shims/prefix from previous runs first.
    rmSync(path.join(process.env.HOME!, '.local'), { recursive: true, force: true });
    rmSync(path.join(process.env.BUN_INSTALL!, 'install'), { recursive: true, force: true });

    const root = mkdtempSync(path.join(tmpdir(), 'pounding-managed-prefix-'));
    const platformKey = `${process.platform}-${process.arch}`;
    const isWin = process.platform === 'win32';
    const nodeDir = isWin
      ? path.join(root, 'bundled-poundingcore', platformKey, 'managed-resources', 'node', `node-v24.0.0-${platformKey}`)
      : path.join(
          root,
          'bundled-poundingcore',
          platformKey,
          'managed-resources',
          'node',
          `node-v24.0.0-${platformKey}`,
          'bin'
        );
    const nodeName = isWin ? 'node.exe' : 'node';
    const npmName = isWin ? 'npm.cmd' : 'npm';
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(path.join(nodeDir, nodeName), '');
    writeFileSync(path.join(nodeDir, npmName), '');

    // Simulate the managed npm prefix bin that npm -g would produce.
    const managedPrefix = path.join(process.env.BUN_INSTALL ?? '', 'install', 'global');
    // npm's global bin dir differs per platform: unix <prefix>/bin,
    // win32 <prefix>/ (root). Mirror the current platform's layout.
    const managedBinDir = isWin ? managedPrefix : path.join(managedPrefix, 'bin');
    mkdirSync(managedBinDir, { recursive: true });
    const binName = isWin ? 'claude.cmd' : 'claude';
    writeFileSync(path.join(managedBinDir, binName), isWin ? '@echo off\r\n' : '#!/usr/bin/env node\n');

    const originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath;
    Object.defineProperty(process, 'resourcesPath', { value: root, configurable: true });
    try {
      let installEnv: NodeJS.ProcessEnv | null = null;
      execFileMock.mockImplementation(
        (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }, cb: (e?: Error) => void) => {
          const argv = args as string[];
          if (argv.includes('install')) installEnv = opts.env ?? null;
          if (argv.includes('-g') && argv.includes('install')) {
            // After npm install, the real bin would exist; our fixture already has it.
            cb();
            return { unref: () => {} };
          }
          // probe (which claude): not installed until after install
          if (installEnv) {
            cb();
          } else {
            cb(new Error('not found'));
          }
          return { unref: () => {} };
        }
      );

      const [result] = await installManagedCliBatch(['claude']);

      expect(result.success).toBe(true);
      expect(installEnv?.npm_config_prefix).toBe(managedPrefix);
      const shimPath = path.join(process.env.HOME!, '.local', 'bin', isWin ? 'claude.cmd' : 'claude');
      expect(readFileSync(shimPath, 'utf8')).toContain(managedPrefix);
    } finally {
      if (originalResourcesPath === undefined) {
        delete (process as { resourcesPath?: string }).resourcesPath;
      } else {
        Object.defineProperty(process, 'resourcesPath', { value: originalResourcesPath, configurable: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the npm global bin dir per platform (win32 = prefix root, unix = prefix/bin)', () => {
    const unixBin = getManagedNpmBinDir(false);
    const winBin = getManagedNpmBinDir(true);
    expect(unixBin.endsWith(path.join('install', 'global', 'bin'))).toBe(true);
    expect(winBin.endsWith(path.join('install', 'global'))).toBe(true);
    expect(winBin.endsWith(path.join('install', 'global', 'bin'))).toBe(false);
  });

  it('serializes concurrent installs of the same target (in-flight mutex)', async () => {
    vi.clearAllMocks();
    let releaseInstall: (() => void) | null = null;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = () => resolve();
    });
    let installCompleted = false;
    const installCalls: string[] = [];

    execFileMock.mockImplementation((_cmd: string, args: string[], _o: unknown, cb: (e?: Error) => void) => {
      const argv = args as string[];
      if (argv.includes('install')) {
        installCalls.push(argv.find((a) => a.includes('@')) ?? 'install');
        void installGate.then(() => {
          installCompleted = true;
          cb();
        });
        return { unref: () => {} };
      }
      // probe (which/where): only reports installed after the install finished
      if (installCompleted) {
        cb();
      } else {
        cb(new Error('not found'));
      }
      return { unref: () => {} };
    });

    const first = installManagedCli({ target: 'claude' });
    // Wait for the first install to actually be in flight
    await vi.waitFor(() => {
      expect(installCalls.length).toBe(1);
    });

    const second = installManagedCli({ target: 'claude' });
    // The second call must block on the mutex: no probe/install calls yet
    await new Promise((r) => setTimeout(r, 50));
    expect(execFileMock.mock.calls.length).toBe(2); // probe + install of the first call only

    releaseInstall?.();
    const [a, b] = await Promise.all([first, second]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(installCalls.length).toBe(1);
  });
});

describe('installManagedCli official-first + COS fallback', () => {
  const testHome = path.join(tmpdir(), 'pounding-cli-test-home');

  beforeEach(() => {
    vi.clearAllMocks();
    // Drop any persistent implementation a previous test left behind (e.g.
    // the mutex test's mockImplementation), and any unconsumed once-impls.
    execFileMock.mockReset();
    reconcileMock.mockResolvedValue(undefined);
    // Isolate per-test state: clean up shims/bundles the previous test wrote.
    for (const dir of ['.local', '.bun', '.pounding', '.hermes']) {
      rmSync(path.join(testHome, dir), { recursive: true, force: true });
    }
  });

  it('builds the pinned COS bundle URL for a target/version/platform', () => {
    const url = buildCosCliBundleUrl('claude');
    expect(url).toContain('/pounding/cli/claude/2.1.215/');
    expect(url).toContain(`/${process.platform}-${process.arch}/bundle.tar.gz`);
  });

  it('uses the official installer when it succeeds and never touches the COS fallback', async () => {
    execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e?: Error) => void) => {
      cb(new Error('not found'));
      return { unref: () => {} };
    });
    execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e?: Error) => void) => {
      cb();
      return { unref: () => {} };
    });
    execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e?: Error) => void) => {
      cb();
      return { unref: () => {} };
    });

    const downloader = vi.fn(async () => {
      throw new Error('COS fallback must not run when the official install succeeds');
    });

    const result = await installManagedCli({ target: 'claude' }, downloader);

    expect(result.success).toBe(true);
    expect(downloader).not.toHaveBeenCalled();
  });

  it('falls back to the COS bundle when the official install fails, then writes the managed shim', async () => {
    // probe: not installed → official npm install: fails
    execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e?: Error) => void) => {
      cb(new Error('not found'));
      return { unref: () => {} };
    });
    execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e?: Error) => void) => {
      cb(new Error('npm EAI_AGAIN'));
      return { unref: () => {} };
    });

    const downloader: CosBundleDownloader = async (_target, _version, destDir) => {
      mkdirSync(destDir, { recursive: true });
      writeFileSync(
        path.join(destDir, 'manifest.json'),
        JSON.stringify({ entrypoint: 'claude', kind: 'native' }),
        'utf8'
      );
      writeFileSync(path.join(destDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    };

    const result = await installManagedCli({ target: 'claude' }, downloader);

    expect(result.success).toBe(true);
    expect(result.status).toBe('installed');
    // The managed shim under ~/.local/bin was materialized from the COS bundle
    const shimName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const shimPath = path.join(testHome, '.local', 'bin', shimName);
    expect(require('fs').existsSync(shimPath)).toBe(true);
  });

  it('reports failure when the official install and the COS fallback both fail', async () => {
    execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e?: Error) => void) => {
      cb(new Error('not found'));
      return { unref: () => {} };
    });
    execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e?: Error) => void) => {
      cb(new Error('npm EAI_AGAIN'));
      return { unref: () => {} };
    });

    const downloader: CosBundleDownloader = async () => {
      throw new Error('COS unreachable');
    };

    const result = await installManagedCli({ target: 'claude' }, downloader);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
  });
});

describe('startup no longer auto-installs managed CLIs', () => {
  it('index.ts markBackendReady no longer references installManagedCliBatch', () => {
    const indexPath = fileURLToPath(new URL('../../../packages/desktop/src/index.ts', import.meta.url));
    const source = readFileSync(indexPath, 'utf8');
    expect(source).not.toContain('installManagedCliBatch');
    expect(source).not.toContain('Managed CLI tools ready');
  });
});
