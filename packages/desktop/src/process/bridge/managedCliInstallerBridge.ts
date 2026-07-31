/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import type {
  ManagedCliInstallOptions,
  ManagedCliInstallResult,
  ManagedCliInstallTarget,
} from '@/common/types/agent/managedCliInstaller';
import { newApiDesktopAccountService } from './services/NewApiDesktopAccountService';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEnvAwareName } from '@/common/config/appEnv';

// ── POUNDING managed CLI directory ────────────────────────────────────
// CLI tools installed by POUNDING live under the data directory, not in
// the user's global ~/.bun or ~/.local — self-contained, portable-safe,
// and never conflicts with tools the user already has.

function getCliBinDir(): string {
  const baseName = getEnvAwareName('.pounding');
  return path.join(os.homedir(), baseName, 'cli', 'bin');
}

type ExecCommandOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

type ManagedCliDescriptor = {
  target: ManagedCliInstallTarget;
  detectCommand: string;
  detectPaths?: string[];
  install: () => Promise<void>;
  uninstall: () => Promise<void>;
};

const NPM_DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const NPM_MIRROR_REGISTRY = 'https://registry.npmmirror.com';
const PYPI_TUNA_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const PYPI_DEFAULT_INDEX_URL = 'https://pypi.org/simple';
const HERMES_HOME_DIR = path.join(os.homedir(), '.hermes');
const HERMES_VENV_DIR = path.join(HERMES_HOME_DIR, 'hermes-agent', 'venv');
const HERMES_BIN_DIR = path.join(os.homedir(), '.local', 'bin');
const HERMES_SHIM_PATH = path.join(HERMES_BIN_DIR, process.platform === 'win32' ? 'hermes.cmd' : 'hermes');
const OPENCODE_CONFIG_ENV_NAME = 'OPENCODE_CONFIG';
const XDG_CONFIG_HOME_ENV_NAME = 'XDG_CONFIG_HOME';
const BUN_HOME_DIR = process.env.BUN_INSTALL?.trim() || path.join(os.homedir(), '.bun');

function getPOUNDINGDevDir(): string {
  try {
    const { app } = require('electron');
    if (app && app.isReady()) {
      return path.join(app.getPath('userData'), 'pounding');
    }
  } catch {
    /* not in Electron context */
  }
  return path.join(os.homedir(), getEnvAwareName('.pounding'));
}

function getManagedOpencodeConfigPath(): string {
  return path.join(getPOUNDINGDevDir(), 'managed-opencode', 'opencode.json');
}

function getManagedOpencodeXdgHome(): string {
  return path.join(getPOUNDINGDevDir(), 'xdg-config');
}

const BUN_BIN_DIR = path.join(BUN_HOME_DIR, 'bin');
const BUN_GLOBAL_NODE_MODULES_DIR = path.join(BUN_HOME_DIR, 'install', 'global', 'node_modules');
const BUN_BIN_PATH = path.join(BUN_BIN_DIR, process.platform === 'win32' ? 'bun.exe' : 'bun');
const BUN_SHIM_PATH = path.join(BUN_BIN_DIR, process.platform === 'win32' ? 'bun.cmd' : 'bun');

const LEGACY_OPENCODE_XDG_HOME = path.join(os.homedir(), getEnvAwareName('.pounding'), 'xdg-config');
const LEGACY_OPENCODE_CONFIG_PATH = path.join(
  os.homedir(),
  getEnvAwareName('.pounding'),
  'managed-opencode',
  'opencode.json'
);

function isAbsoluteExecutablePath(command: string): boolean {
  return path.isAbsolute(command) && fs.existsSync(command);
}

function runCommand(command: string, args: string[], options: ExecCommandOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        env: {
          ...process.env,
          ...options.env,
        },
        cwd: options.cwd,
        shell: false,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = [stderr, stdout, error.message].filter(Boolean).join('\n').trim();
          reject(new Error(detail || `${command} ${args.join(' ')} failed`));
          return;
        }
        resolve();
      }
    );

    child.unref?.();
  });
}

function runCommandOutput(command: string, args: string[], options: ExecCommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        env: {
          ...process.env,
          ...options.env,
        },
        cwd: options.cwd,
        shell: false,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = [stderr, stdout, error.message].filter(Boolean).join('\n').trim();
          reject(new Error(detail || `${command} ${args.join(' ')} failed`));
          return;
        }
        resolve(stdout);
      }
    );

    child.unref?.();
  });
}

function getNpmEnv(registry: string): NodeJS.ProcessEnv {
  return {
    npm_config_registry: registry,
    NPM_CONFIG_REGISTRY: registry,
  };
}

function getNpmCommand(): string {
  return process.env.npm_execpath && fs.existsSync(process.env.npm_execpath) ? process.env.npm_execpath : 'npm';
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeRm(targetPath: string): void {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function getOpencodePlatformPackage(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'opencode-darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'opencode-darwin-x64';
  if (platform === 'linux' && arch === 'arm64') return 'opencode-linux-arm64';
  if (platform === 'linux' && arch === 'x64') return 'opencode-linux-x64';
  if (platform === 'win32' && arch === 'arm64') return 'opencode-windows-arm64';
  if (platform === 'win32' && arch === 'x64') return 'opencode-windows-x64';
  throw new Error(`Unsupported OpenCode platform package for ${platform}-${arch}`);
}

function getOpencodeBinaryTargetPath(): string {
  return path.join(BUN_BIN_DIR, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
}

function getOpencodePlatformBinaryPath(): string {
  return path.join(
    BUN_GLOBAL_NODE_MODULES_DIR,
    getOpencodePlatformPackage(),
    'bin',
    process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  );
}

function writeOpencodeShim(): void {
  const targetBinary = getOpencodePlatformBinaryPath();
  if (!fs.existsSync(targetBinary)) {
    throw new Error(`OpenCode platform binary not found at ${targetBinary}`);
  }
  ensureDir(BUN_BIN_DIR);
  ensureDir(path.dirname(getManagedOpencodeConfigPath()));
  ensureDir(getManagedOpencodeXdgHome());
  const shimPath = getOpencodeBinaryTargetPath();
  safeRm(shimPath);
  if (process.platform === 'win32') {
    const shim = [
      '@echo off',
      `set "${XDG_CONFIG_HOME_ENV_NAME}=${getManagedOpencodeXdgHome()}"`,
      `set "${OPENCODE_CONFIG_ENV_NAME}=${getManagedOpencodeConfigPath()}"`,
      `"${targetBinary}" %*`,
      '',
    ].join('\r\n');
    fs.writeFileSync(shimPath, shim, { encoding: 'utf8' });
    return;
  }
  const shim = [
    '#!/usr/bin/env bash',
    `export ${XDG_CONFIG_HOME_ENV_NAME}=${JSON.stringify(getManagedOpencodeXdgHome())}`,
    `export ${OPENCODE_CONFIG_ENV_NAME}=${JSON.stringify(getManagedOpencodeConfigPath())}`,
    `exec ${JSON.stringify(targetBinary)} "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(shimPath, shim, { encoding: 'utf8', mode: 0o755 });
}

function ensureManagedOpencodeShim(): void {
  const targetBinary = getOpencodePlatformBinaryPath();
  if (!fs.existsSync(targetBinary)) return;

  const shimPath = getOpencodeBinaryTargetPath();
  if (!fs.existsSync(shimPath)) return;

  const currentShim = fs.existsSync(shimPath) ? fs.readFileSync(shimPath, 'utf8') : '';
  const isOwnedManagedShim =
    currentShim.includes(getManagedOpencodeConfigPath()) || currentShim.includes(getManagedOpencodeXdgHome());
  const isOwnedLegacyShim =
    currentShim.includes(LEGACY_OPENCODE_CONFIG_PATH) || currentShim.includes(LEGACY_OPENCODE_XDG_HOME);
  if (!isOwnedManagedShim && !isOwnedLegacyShim) {
    return;
  }

  const needsRewrite =
    !currentShim.includes(getManagedOpencodeConfigPath()) ||
    !currentShim.includes(getManagedOpencodeXdgHome()) ||
    currentShim.includes(LEGACY_OPENCODE_CONFIG_PATH) ||
    currentShim.includes(LEGACY_OPENCODE_XDG_HOME);

  if (needsRewrite) {
    writeOpencodeShim();
  }
}

export function resolveBundledResourcesDir(): string | null {
  const platformKey = `${process.platform}-${process.arch}`;
  const candidate = path.join(process.resourcesPath, 'bundled-poundingcore', platformKey, 'managed-resources');
  return fs.existsSync(candidate) ? candidate : null;
}

export function resolveNodeForShim(): string {
  // 1. Try bundled node in managed-resources
  const bundledResourcesDir = resolveBundledResourcesDir();
  if (bundledResourcesDir) {
    const nodeDir = path.join(bundledResourcesDir, 'node');
    if (fs.existsSync(nodeDir)) {
      const entries = fs.readdirSync(nodeDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const binName = process.platform === 'win32' ? 'node.exe' : 'node';
        // macOS/Linux: node-v24.x.x-darwin-arm64/bin/node
        const candidate = path.join(nodeDir, entry.name, 'bin', binName);
        if (fs.existsSync(candidate)) return candidate;
        // Windows: node-v24.x.x-win32-x64/node.exe (no bin/ subdirectory)
        const candidateFlat = path.join(nodeDir, entry.name, binName);
        if (fs.existsSync(candidateFlat)) return candidateFlat;
      }
    }
  }
  // 2. Fallback: system PATH
  return 'node';
}

function resolveBundledCliDir(target: string): string | null {
  const resourcesDir = resolveBundledResourcesDir();
  if (!resourcesDir) return null;
  const candidates = [path.join(resourcesDir, 'cli', target)];
  if (process.platform === 'darwin' && (process.env.HOME || os.homedir())) {
    // macOS-only cache path
    const cacheBase = path.join(
      process.env.HOME || os.homedir(),
      'Library',
      'Application Support',
      'POUNDING',
      'pounding',
      'runtime',
      'cli',
      target
    );
    candidates.push(cacheBase);
  } else if (process.platform === 'win32' && process.env.APPDATA) {
    // Windows cache path
    const cacheBase = path.join(process.env.APPDATA, 'POUNDING', 'pounding', 'runtime', 'cli', target);
    candidates.push(cacheBase);
  }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    // The bundle is versioned: cli/<target>/<version>/<platform>/
    // Return the innermost directory that contains manifest.json.
    const entries = fs.readdirSync(candidate, { withFileTypes: true });
    for (const versionEntry of entries) {
      if (!versionEntry.isDirectory()) continue;
      const versionDir = path.join(candidate, versionEntry.name);
      const platforms = fs.readdirSync(versionDir, { withFileTypes: true });
      for (const platformEntry of platforms) {
        if (!platformEntry.isDirectory()) continue;
        const platformDir = path.join(versionDir, platformEntry.name);
        if (fs.existsSync(path.join(platformDir, 'manifest.json'))) {
          return platformDir;
        }
      }
    }
  }
  return null;
}

function copyDirContents(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else {
      try {
        fs.linkSync(srcPath, destPath);
      } catch {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

function materializeFromBundled(descriptor: ManagedCliDescriptor, bundledDir: string): void {
  const manifestPath = path.join(bundledDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Bundle manifest missing at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const entrypointRel: string | undefined = manifest.entrypoint;
  if (!entrypointRel) {
    throw new Error(`Bundle manifest missing entrypoint at ${manifestPath}`);
  }

  const entrypointAbs = path.join(bundledDir, entrypointRel);
  if (!fs.existsSync(entrypointAbs)) {
    throw new Error(`Bundle entrypoint not found: ${entrypointAbs}`);
  }

  const kind: string = manifest.kind || 'node'; // default 'node' for backward compat

  if (kind === 'native') {
    // ── Native binary (e.g. Claude) ──────────────────────────────────
    // Copy the binary to the detect path instead of writing a shim.
    // Shims with absolute paths break on app update; a copied binary is
    // self-contained and survives updates.
    const shimPath = descriptor.detectPaths?.[0];
    if (shimPath && !fs.existsSync(shimPath)) {
      ensureDir(path.dirname(shimPath));
      fs.copyFileSync(entrypointAbs, shimPath);
      if (process.platform !== 'win32') {
        fs.chmodSync(shimPath, 0o755);
      }
    }
    return;
  }

  // ── Node.js package ──────────────────────────────────────────────
  // Copy node_modules to the global install dir so the CLI can resolve
  // its dependencies. Then copy the entrypoint script (with #!/usr/bin/env
  // node shebang) to the detect path — no absolute-path shim that breaks
  // on app update.

  const bundledNodeModules = path.join(bundledDir, 'node_modules');
  if (fs.existsSync(bundledNodeModules)) {
    const targetNodeModules = path.join(BUN_HOME_DIR, 'install', 'global', 'node_modules');
    ensureDir(targetNodeModules);
    const pkgParts = entrypointRel.split(path.sep);
    const scopeIdx = pkgParts.indexOf('node_modules');
    if (scopeIdx >= 0 && pkgParts.length > scopeIdx + 2) {
      const srcPkg = path.join(bundledNodeModules, pkgParts[scopeIdx + 1]!);
      const destPkg = path.join(targetNodeModules, pkgParts[scopeIdx + 1]!);
      copyDirContents(srcPkg, destPkg);
      const srcBin = path.join(bundledNodeModules, '.bin');
      const destBin = path.join(targetNodeModules, '.bin');
      if (fs.existsSync(srcBin)) copyDirContents(srcBin, destBin);
    }
  }

  // Copy the main entrypoint to the detect path with a node shebang.
  const shimPath = descriptor.detectPaths?.[0];
  if (shimPath && !fs.existsSync(shimPath)) {
    ensureDir(path.dirname(shimPath));
    const content = fs.readFileSync(entrypointAbs, 'utf-8');
    const withShebang = content.startsWith('#!') ? content : `#!/usr/bin/env node\n${content}`;
    fs.writeFileSync(shimPath, withShebang, { encoding: 'utf8', mode: 0o755 });
  }
}

async function installNpmPackage(packageName: string): Promise<void> {
  let lastError: unknown;
  for (const registry of [NPM_MIRROR_REGISTRY, NPM_DEFAULT_REGISTRY]) {
    try {
      await runCommand(getNpmCommand(), ['install', '-g', packageName], {
        env: getNpmEnv(registry),
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to install ${packageName}`);
}

async function uninstallNpmPackage(packageName: string): Promise<void> {
  try {
    await runCommand(getNpmCommand(), ['uninstall', '-g', packageName]);
  } catch {
    // ignore uninstall miss
  }
}

function resolveManagedNpm(): string {
  // Use the managed Node.js runtime's npm (already bundled in managed-resources).
  // Skips the need to download bun — everything is offline from the installer.
  const nodeForShim = resolveNodeForShim();
  if (nodeForShim) {
    const npmBin =
      process.platform === 'win32'
        ? path.join(path.dirname(nodeForShim), 'npm.cmd')
        : path.join(path.dirname(nodeForShim), 'npm');
    if (fs.existsSync(npmBin)) return npmBin;
  }
  // Fallback to system npm (dev environment or unmanaged installation)
  if (fs.existsSync('/usr/bin/npm')) return '/usr/bin/npm';
  return getNpmCommand();
}

async function getGlobalJsCommand(): Promise<string> {
  const managedNpm = resolveManagedNpm();
  if (fs.existsSync(managedNpm)) return managedNpm;
  throw new Error('No npm available to install JavaScript CLIs.');
}

async function installNpmPackage(packageName: string): Promise<void> {
  let lastError: unknown;
  for (const registry of [NPM_MIRROR_REGISTRY, NPM_DEFAULT_REGISTRY]) {
    try {
      await runCommand(getNpmCommand(), ['install', '-g', packageName], {
        env: getNpmEnv(registry),
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to install ${packageName}`);
}

async function uninstallNpmPackage(packageName: string): Promise<void> {
  try {
    await runCommand(getNpmCommand(), ['uninstall', '-g', packageName]);
  } catch {
    /* best effort */
  }
}

async function uninstallGlobalPackage(packageName: string): Promise<void> {
  await Promise.allSettled([uninstallNpmPackage(packageName), uninstallNpmPackage(packageName)]);
}

function writeHermesShim(): void {
  ensureDir(HERMES_BIN_DIR);
  const isWin = process.platform === 'win32';
  const shimName = isWin ? 'hermes.cmd' : 'hermes';
  const shimPath = path.join(HERMES_BIN_DIR, shimName);
  const hermesExe = isWin
    ? path.join(HERMES_VENV_DIR, 'Scripts', 'hermes.exe')
    : path.join(HERMES_VENV_DIR, 'bin', 'hermes');

  const shim = isWin
    ? `@echo off\r\n"${hermesExe}" %*\r\n`
    : `#!/usr/bin/env bash
unset PYTHONPATH
unset PYTHONHOME
exec "${hermesExe}" "$@"
`;
  const writeOpts = isWin ? { encoding: 'utf8' as const } : { encoding: 'utf8' as const, mode: 0o755 };
  fs.writeFileSync(shimPath, shim, writeOpts);
  if (!isWin) {
    // On Windows .cmd files are inherently executable
    try {
      fs.chmodSync(shimPath, 0o755);
    } catch {
      /* best-effort */
    }
  }
}

function resolvePython3Binary(): string | null {
  // Try bundled Python from managed-resources first (offline path)
  const bundledResourcesDir = resolveBundledResourcesDir();
  if (bundledResourcesDir) {
    const pythonBinDir = path.join(bundledResourcesDir, 'runtimes', 'python', 'python', 'bin');
    const pythonBinary = path.join(pythonBinDir, process.platform === 'win32' ? 'python3.exe' : 'python3');
    if (fs.existsSync(pythonBinary)) return pythonBinary;
  }
  // Fallback to system python3
  return process.env.PYTHON_BINARY || 'python3';
}

async function installHermes(): Promise<void> {
  const pythonBinary = resolvePython3Binary();
  if (!pythonBinary)
    throw new Error('Python3 not found. Bundled Python runtime is missing and no system python3 available.');

  const packageName = 'hermes-agent[acp]';
  const indexUrls = ['https://pypi.tuna.tsinghua.edu.cn/simple', 'https://pypi.org/simple'];

  ensureDir(path.dirname(HERMES_VENV_DIR));
  await runCommand(pythonBinary, ['-m', 'venv', '--clear', HERMES_VENV_DIR]);
  const venvPython =
    process.platform === 'win32'
      ? path.join(HERMES_VENV_DIR, 'Scripts', 'python.exe')
      : path.join(HERMES_VENV_DIR, 'bin', 'python3');

  let lastError: unknown;
  for (const indexUrl of indexUrls) {
    try {
      await runCommand(venvPython, [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '-i',
        indexUrl,
        '-U',
        packageName,
      ]);
      writeHermesShim();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to install hermes-agent');
}

async function uninstallHermes(): Promise<void> {
  safeRm(path.join(HERMES_HOME_DIR, 'hermes-agent'));
  safeRm(HERMES_SHIM_PATH);
}

export async function preinstallHermesFromBundle(bundledResourcesDir: string): Promise<boolean> {
  const hermesDescriptor = DESCRIPTORS.hermes;
  if (await isManagedCliInstalled(hermesDescriptor)) return true;

  const pythonDir = path.join(bundledResourcesDir, 'runtimes', 'python');
  const uvBinary = path.join(bundledResourcesDir, 'runtimes', 'uv', process.platform === 'win32' ? 'uv.exe' : 'uv');
  const hermesWheelDir = path.join(bundledResourcesDir, 'runtimes', 'hermes');

  if (!fs.existsSync(hermesWheelDir)) return false;
  const wheelFiles = fs.readdirSync(hermesWheelDir).filter((f) => f.endsWith('.whl'));
  if (wheelFiles.length === 0) return false;

  // Require vendored Python to create the venv.
  if (!fs.existsSync(pythonDir)) return false;
  const pythonBinDir = path.join(pythonDir, 'python', 'bin');
  const pythonBinary = path.join(pythonBinDir, process.platform === 'win32' ? 'python3.exe' : 'python3');
  if (!fs.existsSync(pythonBinary)) return false;

  try {
    await runCommand(pythonBinary, ['-m', 'venv', '--clear', HERMES_VENV_DIR]);

    const uvCmd = fs.existsSync(uvBinary) ? uvBinary : 'uv';
    const venvPython = path.join(
      HERMES_VENV_DIR,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python'
    );

    if (wheelFiles.length === 1) {
      // Legacy: single wheel (old vendor format). Install it, then
      // explicitly add agent-client-protocol for the [acp] extra.
      const wheelPath = path.join(hermesWheelDir, wheelFiles[0]);
      await runCommand(uvCmd, ['pip', 'install', '--python', venvPython, wheelPath]);
      await runCommand(uvCmd, ['pip', 'install', '--python', venvPython, 'agent-client-protocol']);
    } else {
      // Multi-wheel vendor bundle (pip download). Install everything from
      // the local directory — no network at all.
      await runCommand(uvCmd, [
        'pip',
        'install',
        '--python',
        venvPython,
        '--no-index',
        '--find-links',
        hermesWheelDir,
        'hermes-agent[acp]',
      ]);
    }

    writeHermesShim();
    console.log('[POUNDING] Hermes installed from bundled resources');
    return true;
  } catch (err) {
    console.error('[POUNDING] Failed to install Hermes from bundle:', err);
    return false;
  }
}

async function installOpenCode(): Promise<void> {
  ensureDir(BUN_HOME_DIR);
  ensureDir(BUN_GLOBAL_NODE_MODULES_DIR);
  try {
    await installNpmPackage('opencode-ai');
    if (await commandExists('opencode')) {
      writeOpencodeShim();
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('opencode-darwin') && !message.includes('failed to install the right opencode CLI package')) {
      throw error;
    }
  }

  await installNpmPackage(getOpencodePlatformPackage());
  writeOpencodeShim();
}

async function uninstallOpenCode(): Promise<void> {
  await uninstallNpmPackage('opencode-ai');
  await uninstallNpmPackage(getOpencodePlatformPackage());
  safeRm(getOpencodeBinaryTargetPath());
  safeRm(path.join(BUN_GLOBAL_NODE_MODULES_DIR, 'opencode-ai'));
  safeRm(path.join(BUN_GLOBAL_NODE_MODULES_DIR, getOpencodePlatformPackage()));
  safeRm(getManagedOpencodeXdgHome());
}

async function commandExists(command: string): Promise<boolean> {
  if (isAbsoluteExecutablePath(command)) return true;
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    await runCommand(locator, [command]);
    return true;
  } catch {
    return false;
  }
}

async function refreshAgents(): Promise<void> {
  await httpRequest('POST', '/api/agents/refresh');
}

const DESCRIPTORS: Record<ManagedCliInstallTarget, ManagedCliDescriptor> = {
  claude: {
    target: 'claude',
    detectCommand: 'claude',
    detectPaths: [
      path.join(HERMES_BIN_DIR, process.platform === 'win32' ? 'claude.cmd' : 'claude'),
      path.join(BUN_BIN_DIR, process.platform === 'win32' ? 'claude.cmd' : 'claude'),
    ],
    install: async () => {
      await installNpmPackage('@anthropic-ai/claude-code');
    },
    uninstall: async () => {
      await uninstallGlobalPackage('@anthropic-ai/claude-code');
    },
  },
  hermes: {
    target: 'hermes',
    detectCommand: 'hermes',
    detectPaths: [HERMES_SHIM_PATH],
    install: installHermes,
    uninstall: uninstallHermes,
  },
  openclaw: {
    target: 'openclaw',
    detectCommand: 'openclaw',
    detectPaths: [
      path.join(HERMES_BIN_DIR, process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw'),
      path.join(BUN_BIN_DIR, process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw'),
    ],
    install: async () => {
      await installNpmPackage('openclaw');
    },
    uninstall: async () => {
      await uninstallGlobalPackage('openclaw');
    },
  },
};

async function isManagedCliInstalled(descriptor: ManagedCliDescriptor): Promise<boolean> {
  const pathChecks = descriptor.detectPaths ?? [];
  if (pathChecks.some((candidate) => isAbsoluteExecutablePath(candidate))) return true;
  if (descriptor.target === 'hermes') return false;
  return commandExists(descriptor.detectCommand);
}

async function syncAfterInstall(target: ManagedCliInstallTarget): Promise<void> {
  await newApiDesktopAccountService.reconcileManagedRuntimeState({ cliTarget: target });
  await refreshAgents();
}

async function syncAfterUninstall(target: ManagedCliInstallTarget): Promise<void> {
  await newApiDesktopAccountService.clearManagedRuntimeForCliTarget(target);
  await refreshAgents();
}

async function installManagedCli(input: ManagedCliInstallOptions): Promise<ManagedCliInstallResult> {
  const descriptor = DESCRIPTORS[input.target];
  if (!descriptor) {
    return {
      success: false,
      status: 'failed',
      message: `Unsupported target: ${String(input.target)}`,
    };
  }

  try {
    const alreadyInstalled = await isManagedCliInstalled(descriptor);
    if (alreadyInstalled) {
      await syncAfterInstall(descriptor.target);
      return { success: true, status: 'installed' };
    }

    // Try native install first (bun add -g / pip install).
    // This properly registers the CLI on PATH and survives app updates.
    try {
      console.log(`[POUNDING] Installing ${descriptor.target} via native package manager...`);
      await descriptor.install();
      await syncAfterInstall(descriptor.target);
      const installed = await isManagedCliInstalled(descriptor);
      if (installed) {
        return { success: true, status: 'installed' };
      }
    } catch (err) {
      console.warn(`[POUNDING] Native install failed for ${descriptor.target}, trying bundled fallback:`, err);
    }

    // Bundled fallback: copy binary from app resources (no network needed).
    const bundledDir = resolveBundledCliDir(descriptor.target);
    if (bundledDir) {
      console.log(`[POUNDING] Installing ${descriptor.target} from bundled resources...`);
      materializeFromBundled(descriptor, bundledDir);
      await syncAfterInstall(descriptor.target);
      const installed = await isManagedCliInstalled(descriptor);
      if (installed) {
        return { success: true, status: 'installed' };
      }
    }

    // Hermes uses a different bundle layout (Python wheels in runtimes/).
    if (descriptor.target === 'hermes') {
      const bundledResourcesDir = resolveBundledResourcesDir();
      if (bundledResourcesDir) {
        console.log(`[POUNDING] Installing hermes from bundled Python wheels...`);
        const ok = await preinstallHermesFromBundle(bundledResourcesDir);
        if (ok) {
          writeHermesShim();
          await syncAfterInstall(descriptor.target);
          const installed = await isManagedCliInstalled(descriptor);
          if (installed) return { success: true, status: 'installed' };
        }
      }
    }

    return {
      success: false,
      status: 'failed',
      message: `${descriptor.detectCommand} is still not available in PATH`,
    };
  } catch (error) {
    return {
      success: false,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function uninstallManagedCli(target: ManagedCliInstallTarget): Promise<ManagedCliInstallResult> {
  const descriptor = DESCRIPTORS[target];
  if (!descriptor) {
    return {
      success: false,
      status: 'failed',
      message: `Unsupported target: ${String(target)}`,
    };
  }

  try {
    await descriptor.uninstall();
    await syncAfterUninstall(target);
    const installed = await isManagedCliInstalled(descriptor);
    return {
      success: !installed,
      status: installed ? 'failed' : 'not_installed',
      message: installed ? `${descriptor.detectCommand} is still available in PATH` : undefined,
    };
  } catch (error) {
    return {
      success: false,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installManagedCliBatch(targets: ManagedCliInstallTarget[]): Promise<ManagedCliInstallResult[]> {
  const results: ManagedCliInstallResult[] = [];
  for (const target of targets) {
    results.push(await installManagedCli({ target }));
  }
  return results;
}

export async function uninstallManagedCliBatch(targets: ManagedCliInstallTarget[]): Promise<ManagedCliInstallResult[]> {
  const results: ManagedCliInstallResult[] = [];
  for (const target of targets) {
    results.push(await uninstallManagedCli(target));
  }
  return results;
}

export type CliAvailabilityReport = {
  all: boolean;
  missing: string[];
  details: Record<string, { installed: boolean; reason: string }>;
};

export async function verifyAllClisAvailable(): Promise<CliAvailabilityReport> {
  const targets: ManagedCliInstallTarget[] = ['hermes', 'openclaw', 'claude', 'opencode'];
  const missing: string[] = [];
  const details: CliAvailabilityReport['details'] = {};

  for (const target of targets) {
    const descriptor = DESCRIPTORS[target];
    const installed = await isManagedCliInstalled(descriptor);
    details[target] = {
      installed,
      reason: installed ? 'OK' : 'CLI not found on PATH',
    };
    if (!installed) missing.push(target);
  }

  return { all: missing.length === 0, missing, details };
}

export function initManagedCliInstallerBridge(): void {
  ensureManagedOpencodeShim();
  ipcBridge.managedCliInstaller.install.provider(async (input) => installManagedCli(input));
  ipcBridge.managedCliInstaller.uninstall.provider(async (target: ManagedCliInstallTarget) =>
    uninstallManagedCli(target)
  );
  ipcBridge.managedCliInstaller.isInstalled.provider(async ({ target }) => {
    const descriptor = DESCRIPTORS[target];
    if (!descriptor) return false;
    return isManagedCliInstalled(descriptor);
  });
}
