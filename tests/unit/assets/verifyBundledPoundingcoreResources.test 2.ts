import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  verifyBundledPoundingcoreResources,
} = require('../../../packages/shared-scripts/src/verify-bundled-poundingcore-resources');

describe('verifyBundledPoundingcoreResources', () => {
  let tmp: string;
  let resourcesDir: string;
  let managedResourcesDir: string;
  let codexRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pounding-bundled-resources-'));
    resourcesDir = join(tmp, 'resources');
    managedResourcesDir = join(resourcesDir, 'bundled-poundingcore', 'win32-x64', 'managed-resources');

    mkdirSync(join(resourcesDir, 'bundled-poundingcore', 'win32-x64'), { recursive: true });
    writeFileSync(join(resourcesDir, 'bundled-poundingcore', 'win32-x64', 'poundingcore.exe'), '', { flush: true });
    writeFileSync(join(resourcesDir, 'bundled-poundingcore', 'win32-x64', 'manifest.json'), '{}', { flush: true });

    const nodeRoot = join(managedResourcesDir, 'node', 'node-v24.11.0-win-x64');
    mkdirSync(nodeRoot, { recursive: true });
    writeFileSync(join(nodeRoot, 'node.exe'), '', { flush: true });

    codexRoot = join(managedResourcesDir, 'acp', 'codex-acp', '0.14.0', 'win32-x64');
    mkdirSync(codexRoot, { recursive: true });
    writeFileSync(join(codexRoot, 'manifest.json'), JSON.stringify({ entrypoint: 'codex-acp.exe', path_entries: [] }), {
      flush: true,
    });
    writeFileSync(join(codexRoot, 'codex-acp.exe'), '', { flush: true });

    const claudeRoot = join(managedResourcesDir, 'acp', 'claude-agent-acp', '0.13.0', 'win32-x64');
    mkdirSync(claudeRoot, { recursive: true });
    writeFileSync(
      join(claudeRoot, 'manifest.json'),
      JSON.stringify({ entrypoint: 'claude-agent-acp.exe', path_entries: [] }),
      { flush: true }
    );
    writeFileSync(join(claudeRoot, 'claude-agent-acp.exe'), '', { flush: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('passes when node and managed ACP entrypoints exist', () => {
    const result = verifyBundledPoundingcoreResources({
      resourcesDir,
      electronPlatformName: 'win32',
      targetArch: 'x64',
    });

    expect(result.runtimeKey).toBe('win32-x64');
    expect(result.missing).toEqual([]);
  });

  it('reports missing managed node runtime executable', () => {
    rmSync(join(managedResourcesDir, 'node', 'node-v24.11.0-win-x64', 'node.exe'));

    const result = verifyBundledPoundingcoreResources({
      resourcesDir,
      electronPlatformName: 'win32',
      targetArch: 'x64',
    });

    expect(result.missing).toContain('bundled-poundingcore/win32-x64/managed-resources/node/*/node.exe');
  });

  it('passes for non-Windows node runtime layout', () => {
    const darwinResourcesDir = join(tmp, 'darwin-resources');
    const darwinManagedResourcesDir = join(
      darwinResourcesDir,
      'bundled-poundingcore',
      'darwin-arm64',
      'managed-resources'
    );

    mkdirSync(join(darwinResourcesDir, 'bundled-poundingcore', 'darwin-arm64'), { recursive: true });
    writeFileSync(join(darwinResourcesDir, 'bundled-poundingcore', 'darwin-arm64', 'poundingcore'), '', {
      flush: true,
    });
    writeFileSync(join(darwinResourcesDir, 'bundled-poundingcore', 'darwin-arm64', 'manifest.json'), '{}', {
      flush: true,
    });
    mkdirSync(join(darwinManagedResourcesDir, 'node', 'node-v24.11.0-darwin-arm64', 'bin'), { recursive: true });
    writeFileSync(join(darwinManagedResourcesDir, 'node', 'node-v24.11.0-darwin-arm64', 'bin', 'node'), '', {
      flush: true,
    });

    const darwinCodexRoot = join(darwinManagedResourcesDir, 'acp', 'codex-acp', '0.14.0', 'darwin-arm64');
    mkdirSync(darwinCodexRoot, { recursive: true });
    writeFileSync(join(darwinCodexRoot, 'manifest.json'), JSON.stringify({ entrypoint: 'codex-acp' }), {
      flush: true,
    });
    writeFileSync(join(darwinCodexRoot, 'codex-acp'), '', { flush: true });

    const darwinClaudeRoot = join(darwinManagedResourcesDir, 'acp', 'claude-agent-acp', '0.13.0', 'darwin-arm64');
    mkdirSync(darwinClaudeRoot, { recursive: true });
    writeFileSync(join(darwinClaudeRoot, 'manifest.json'), JSON.stringify({ entrypoint: 'claude-agent-acp' }), {
      flush: true,
    });
    writeFileSync(join(darwinClaudeRoot, 'claude-agent-acp'), '', { flush: true });

    const result = verifyBundledPoundingcoreResources({
      resourcesDir: darwinResourcesDir,
      electronPlatformName: 'darwin',
      targetArch: 'arm64',
    });

    expect(result.missing).toEqual([]);
    expect(result.checked).toContain('bundled-poundingcore/darwin-arm64/managed-resources/node/*/bin/node');
  });

  it('reports missing non-Windows managed node runtime executable', () => {
    const linuxResourcesDir = join(tmp, 'linux-resources');
    const linuxManagedResourcesDir = join(linuxResourcesDir, 'bundled-poundingcore', 'linux-x64', 'managed-resources');

    mkdirSync(join(linuxResourcesDir, 'bundled-poundingcore', 'linux-x64'), { recursive: true });
    writeFileSync(join(linuxResourcesDir, 'bundled-poundingcore', 'linux-x64', 'poundingcore'), '', { flush: true });
    writeFileSync(join(linuxResourcesDir, 'bundled-poundingcore', 'linux-x64', 'manifest.json'), '{}', { flush: true });
    mkdirSync(join(linuxManagedResourcesDir, 'node', 'node-v24.11.0-linux-x64'), { recursive: true });

    const result = verifyBundledPoundingcoreResources({
      resourcesDir: linuxResourcesDir,
      electronPlatformName: 'linux',
      targetArch: 'x64',
    });

    expect(result.missing).toContain('bundled-poundingcore/linux-x64/managed-resources/node/*/bin/node');
  });

  it('reports missing managed ACP manifest', () => {
    rmSync(join(codexRoot, 'manifest.json'));

    const result = verifyBundledPoundingcoreResources({
      resourcesDir,
      electronPlatformName: 'win32',
      targetArch: 'x64',
    });

    expect(result.missing).toContain(
      'bundled-poundingcore/win32-x64/managed-resources/acp/codex-acp/*/win32-x64/manifest.json'
    );
  });

  it('reports missing managed ACP entrypoint declared by manifest', () => {
    rmSync(join(codexRoot, 'codex-acp.exe'));

    const result = verifyBundledPoundingcoreResources({
      resourcesDir,
      electronPlatformName: 'win32',
      targetArch: 'x64',
    });

    expect(result.missing).toContain(
      'bundled-poundingcore/win32-x64/managed-resources/acp/codex-acp/0.14.0/win32-x64/codex-acp.exe'
    );
  });
});
