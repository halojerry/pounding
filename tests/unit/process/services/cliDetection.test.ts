/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

// Isolate the home dir so default managed-dir scanning (~/.local/bin) never
// observes a real local CLI during tests.
vi.hoisted(() => {
  process.env.HOME = '/nonexistent-pounding-test-home';
  process.env.BUN_INSTALL = '/nonexistent-pounding-test-bun';
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

import { classifySource, detectCliInstallations, isRunnableVersionOutput } from '@/process/services/cliDetection';

interface Hit {
  path: string;
  version: string | null;
}

function mockWhichVersion(target: string, hits: Hit[]): void {
  execFileMock.mockImplementation(
    (
      command: string,
      args: string[],
      _options: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      if (command === 'which' && args[0] === '-a' && args[1] === target) {
        cb(null, hits.map((hit) => hit.path).join('\n') + (hits.length ? '\n' : ''), '');
        return;
      }
      const hit = hits.find((candidate) => candidate.path === command);
      if (hit && args.includes('--version')) {
        if (hit.version === null) {
          cb(new Error(`${command} failed`), '', '');
        } else {
          cb(null, `${command} v${hit.version}\n`, '');
        }
        return;
      }
      cb(new Error('ENOENT: not found'), '', '');
    }
  );
}

describe('classifySource', () => {
  it('classifies nvm installs by the ~/.nvm path segment', () => {
    expect(classifySource('/Users/u/.nvm/versions/node/v20.11.1/bin/claude', '/Users/u', [])).toBe('nvm');
  });

  it('classifies homebrew installs under /opt/homebrew', () => {
    expect(classifySource('/opt/homebrew/bin/claude', '/Users/u', [])).toBe('homebrew');
  });

  it('classifies bun installs by the ~/.bun path segment', () => {
    expect(classifySource('/Users/u/.bun/bin/claude', '/Users/u', [])).toBe('bun');
  });

  it('classifies ~/.local/bin as managed even without explicit managedDirs', () => {
    expect(classifySource('/Users/u/.local/bin/claude', '/Users/u', [])).toBe('managed');
  });

  it('classifies explicit managedDirs entries as managed', () => {
    expect(classifySource('/mnt/tooling/bin/claude', '/Users/u', ['/mnt/tooling/bin'])).toBe('managed');
  });

  it('classifies everything else as system', () => {
    expect(classifySource('/usr/local/bin/claude', '/Users/u', [])).toBe('system');
  });
});

describe('isRunnableVersionOutput', () => {
  it('rejects empty or whitespace-only output', () => {
    expect(isRunnableVersionOutput('')).toBe(false);
    expect(isRunnableVersionOutput('   \n\t ')).toBe(false);
  });

  it('accepts bare version output', () => {
    expect(isRunnableVersionOutput('2.1.215')).toBe(true);
  });

  it('accepts multi-line banner output', () => {
    expect(isRunnableVersionOutput('claude 2.1.215 (Claude Code)\nhttps://claude.com')).toBe(true);
  });
});

describe('detectCliInstallations', () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('detects a single PATH install and marks it default', async () => {
    mockWhichVersion('claude', [{ path: '/Users/u/.bun/bin/claude', version: '2.1.215' }]);
    const statuses = await detectCliInstallations(['claude'], {
      pathEntries: ['/Users/u/.bun/bin'],
      managedDirs: [],
    });

    expect(statuses).toHaveLength(1);
    const [status] = statuses;
    expect(status.target).toBe('claude');
    expect(status.installations).toHaveLength(1);
    expect(status.installations[0]).toMatchObject({
      binary: 'claude',
      path: '/Users/u/.bun/bin/claude',
      version: '/Users/u/.bun/bin/claude v2.1.215',
      runnable: true,
      source: 'bun',
      isDefault: true,
    });
    expect(status.defaultPath).toBe('/Users/u/.bun/bin/claude');
    expect(status.conflict).toBe(false);
  });

  it('enumerates multi-source installs, keeps PATH-first default, flags conflict', async () => {
    mockWhichVersion('claude', [
      { path: '/opt/homebrew/bin/claude', version: '2.1.215' },
      { path: '/Users/u/.nvm/versions/node/v20.11.1/bin/claude', version: '2.1.200' },
    ]);
    const statuses = await detectCliInstallations(['claude'], {
      pathEntries: ['/opt/homebrew/bin', '/Users/u/.nvm/versions/node/v20.11.1/bin'],
      managedDirs: [],
    });

    expect(statuses[0].installations).toHaveLength(2);
    expect(statuses[0].installations[0]).toMatchObject({ source: 'homebrew', isDefault: true });
    expect(statuses[0].installations[1]).toMatchObject({ source: 'nvm', isDefault: false });
    expect(statuses[0].defaultPath).toBe('/opt/homebrew/bin/claude');
    expect(statuses[0].conflict).toBe(true);
  });

  it('flags multiple same-source hits as conflict', async () => {
    mockWhichVersion('openclaw', [
      { path: '/usr/local/bin/openclaw', version: '2026.6.33' },
      { path: '/usr/local/sbin/openclaw', version: '2026.6.33' },
    ]);
    const statuses = await detectCliInstallations(['openclaw'], {
      pathEntries: ['/usr/local/bin', '/usr/local/sbin'],
      managedDirs: [],
    });

    expect(statuses[0].installations).toHaveLength(2);
    expect(statuses[0].conflict).toBe(true);
  });

  it('marks a broken binary as not runnable without version', async () => {
    mockWhichVersion('hermes', [{ path: '/usr/local/bin/hermes', version: null }]);
    const statuses = await detectCliInstallations(['hermes'], {
      pathEntries: ['/usr/local/bin'],
      managedDirs: [],
    });

    expect(statuses[0].installations[0]).toMatchObject({
      runnable: false,
      version: null,
      isDefault: true,
    });
    expect(statuses[0].conflict).toBe(false);
  });

  it('scans managed dirs for installs not on PATH', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pounding-cli-detect-'));
    tempDirs.push(root);
    const managedBin = path.join(root, 'bin');
    mkdirSync(managedBin, { recursive: true });
    writeFileSync(path.join(managedBin, 'claude'), '#!/bin/sh\necho 2.1.215\n');

    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void
      ) => {
        if (command === 'which') {
          cb(new Error('not on PATH'), '', '');
          return;
        }
        if (command === path.join(managedBin, 'claude') && args.includes('--version')) {
          cb(null, '2.1.215\n', '');
          return;
        }
        cb(new Error('ENOENT: not found'), '', '');
      }
    );

    const statuses = await detectCliInstallations(['claude'], {
      pathEntries: [],
      managedDirs: [managedBin],
    });

    expect(statuses[0].installations).toHaveLength(1);
    expect(statuses[0].installations[0]).toMatchObject({
      source: 'managed',
      isDefault: false,
      runnable: true,
      version: '2.1.215',
    });
    expect(statuses[0].defaultPath).toBeNull();
    expect(statuses[0].conflict).toBe(false);
  });

  it('dedupes a managed dir entry that also appears on PATH', async () => {
    mockWhichVersion('claude', [{ path: '/Users/u/.local/bin/claude', version: '2.1.215' }]);
    const statuses = await detectCliInstallations(['claude'], {
      pathEntries: ['/Users/u/.local/bin'],
      managedDirs: ['/Users/u/.local/bin'],
    });

    expect(statuses[0].installations).toHaveLength(1);
    expect(statuses[0].installations[0]).toMatchObject({
      source: 'managed',
      isDefault: true,
    });
    expect(statuses[0].conflict).toBe(false);
  });

  it('returns a status per requested target', async () => {
    mockWhichVersion('claude', [{ path: '/usr/local/bin/claude', version: '2.1.215' }]);
    mockWhichVersion('openclaw', [{ path: '/usr/local/bin/openclaw', version: '2026.6.33' }]);
    const statuses = await detectCliInstallations(['claude', 'openclaw'], {
      pathEntries: ['/usr/local/bin'],
      managedDirs: [],
    });

    expect(statuses.map((status) => status.target)).toEqual(['claude', 'openclaw']);
  });
});
