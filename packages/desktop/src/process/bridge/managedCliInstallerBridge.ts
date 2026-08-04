/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type {
  ManagedCliInstallOptions,
  ManagedCliInstallResult,
  ManagedCliInstallTarget,
} from '@/common/types/agent/managedCliInstaller';
import type { CliPathOverrides } from '@/common/types/agent/cliEnvironment';
import { detectCliInstallations } from '../services/cliDetection';
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

type ExecCommandOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Hard kill timeout in ms (default: no timeout). */
  timeoutMs?: number;
};

// ── Pinned CLI versions (single source of truth: scripts/vendor-versions.env) ──
// Keep in sync with vendor-versions.env — scripts/check-version-consistency.sh
// enforces this in CI. Verified against upstream registries 2026-08-01.
const CLAUDE_CLI_VERSION = '2.1.215';
const OPENCLAW_VERSION = '2026.6.33';
const HERMES_VERSION = '0.19.0';
// Per-step timeouts so a blocked network degrades to the bundled fallback
// instead of stalling the first-launch OOBE forever.
const NPM_INSTALL_TIMEOUT_MS = 300_000;
const PIP_INSTALL_TIMEOUT_MS = 600_000;
const VENV_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

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
// Resolve the user home from $HOME first (same pattern as backend-launcher's
// buildSpawnEnv and resolveNodeForShim): tests and dev tooling override HOME
// to isolate installs, and Node's os.homedir() caches on first call.
function getCliUserHome(): string {
  return process.env.HOME || os.homedir();
}

const HERMES_HOME_DIR = path.join(getCliUserHome(), '.hermes');
const HERMES_VENV_DIR = path.join(HERMES_HOME_DIR, 'hermes-agent', 'venv');
const HERMES_BIN_DIR = path.join(getCliUserHome(), '.local', 'bin');
const HERMES_SHIM_PATH = path.join(HERMES_BIN_DIR, process.platform === 'win32' ? 'hermes.cmd' : 'hermes');
const OPENCODE_CONFIG_ENV_NAME = 'OPENCODE_CONFIG';
const XDG_CONFIG_HOME_ENV_NAME = 'XDG_CONFIG_HOME';
const BUN_HOME_DIR = process.env.BUN_INSTALL?.trim() || path.join(getCliUserHome(), '.bun');

function getPOUNDINGDevDir(): string {
  try {
    const { app } = require('electron');
    if (app && app.isReady()) {
      return path.join(app.getPath('userData'), 'pounding');
    }
  } catch {
    /* not in Electron context */
  }
  return path.join(getCliUserHome(), getEnvAwareName('.pounding'));
}

function cliPathsFile(): string {
  return path.join(getCliUserHome(), '.pounding', 'cli-paths.json');
}

function writeCliPaths(overrides: CliPathOverrides): void {
  ensureDir(path.dirname(cliPathsFile()));
  fs.writeFileSync(cliPathsFile(), JSON.stringify(overrides, null, 2), 'utf8');
}

function getManagedOpencodeConfigPath(): string {
  return path.join(getPOUNDINGDevDir(), 'managed-opencode', 'opencode.json');
}

function getManagedOpencodeXdgHome(): string {
  return path.join(getPOUNDINGDevDir(), 'xdg-config');
}

const BUN_BIN_DIR = path.join(BUN_HOME_DIR, 'bin');
const BUN_GLOBAL_NODE_MODULES_DIR = path.join(BUN_HOME_DIR, 'install', 'global', 'node_modules');
// Self-contained npm global prefix for POUNDING-managed CLIs (claude /
// openclaw). `npm install -g` / `npm uninstall -g` are pinned here so they
// never write into — or delete — the user's system npm prefix (/usr/local).
const MANAGED_NPM_GLOBAL_PREFIX = path.join(BUN_HOME_DIR, 'install', 'global');
const BUN_BIN_PATH = path.join(BUN_BIN_DIR, process.platform === 'win32' ? 'bun.exe' : 'bun');
const BUN_SHIM_PATH = path.join(BUN_BIN_DIR, process.platform === 'win32' ? 'bun.cmd' : 'bun');

const LEGACY_OPENCODE_XDG_HOME = path.join(getCliUserHome(), getEnvAwareName('.pounding'), 'xdg-config');
const LEGACY_OPENCODE_CONFIG_PATH = path.join(
  getCliUserHome(),
  getEnvAwareName('.pounding'),
  'managed-opencode',
  'opencode.json'
);

function isAbsoluteExecutablePath(command: string): boolean {
  if (!path.isAbsolute(command) || !fs.existsSync(command)) return false;
  if (process.platform !== 'win32') return true;
  // Windows: `.cmd`/`.exe`/`.bat` are the only directly launchable kinds.
  return /\.(cmd|exe|bat)$/i.test(command);
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
        // Hard timeout so a blocked network (npm/pip hang) degrades to the
        // bundled fallback instead of stalling the first-launch OOBE forever.
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = [stderr, stdout, error.message].filter(Boolean).join('\n').trim();
          const suffix =
            (error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || error.killed
              ? ` (timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s)`
              : '';
          reject(new Error(`${detail || `${command} ${args.join(' ')} failed`}${suffix}`));
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
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = [stderr, stdout, error.message].filter(Boolean).join('\n').trim();
          const suffix =
            (error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || error.killed
              ? ` (timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s)`
              : '';
          reject(new Error(`${detail || `${command} ${args.join(' ')} failed`}${suffix}`));
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
    // Global installs stay inside the POUNDING-managed dir (same location
    // materializeFromBundled uses), not the user's system npm prefix.
    npm_config_prefix: MANAGED_NPM_GLOBAL_PREFIX,
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
  // `process.resourcesPath` is undefined outside Electron (unit tests / dev
  // scripts); path.join(undefined, …) would throw.
  if (!process.resourcesPath) return null;
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

/**
 * Resolve the bundled Python 3.12 runtime shipped in managed-resources.
 * Layout: managed-resources/runtimes/python/bin/python3 (unix) /
 *         managed-resources/runtimes/python/python.exe (win32)
 * hermes-agent 0.19.0 requires Python >=3.11,<3.14 — the bundled runtime is
 * the only reliable source (system python3 is often 3.9/3.10 or 3.14+).
 */
export function resolveBundledPythonBinary(): string | null {
  const bundledResourcesDir = resolveBundledResourcesDir();
  if (!bundledResourcesDir) return null;
  const pythonRoot = path.join(bundledResourcesDir, 'runtimes', 'python');
  if (!fs.existsSync(pythonRoot)) return null;
  const candidate =
    process.platform === 'win32' ? path.join(pythonRoot, 'python.exe') : path.join(pythonRoot, 'bin', 'python3');
  return fs.existsSync(candidate) ? candidate : null;
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
    // Copy the binary next to the detect path, then write a launcher shim.
    // Shims with absolute paths break on app update; a copied binary is
    // self-contained and survives updates.
    //
    // Windows: detectPaths[0] is a `.cmd` shim path — we must NOT copy the
    // native binary content into the `.cmd` file (it would never execute).
    // Copy the binary as `claude.exe` beside it and have the `.cmd` shim
    // launch that. Unix: copy the binary straight to the detect path.
    const shimPath = descriptor.detectPaths?.[0];
    if (!shimPath) return;
    if (process.platform === 'win32') {
      const exePath = shimPath.replace(/\.cmd$/i, '.exe');
      ensureDir(path.dirname(shimPath));
      if (!fs.existsSync(exePath)) {
        fs.copyFileSync(entrypointAbs, exePath);
      }
      if (!fs.existsSync(shimPath)) {
        fs.writeFileSync(shimPath, `@echo off\r\n"${exePath}" %*\r\n`, { encoding: 'utf8' });
      }
      return;
    }
    if (!fs.existsSync(shimPath)) {
      ensureDir(path.dirname(shimPath));
      fs.copyFileSync(entrypointAbs, shimPath);
      fs.chmodSync(shimPath, 0o755);
    }
    return;
  }

  // ── Node.js package ──────────────────────────────────────────────
  // Copy node_modules to the global install dir so the CLI can resolve
  // its dependencies. Then create a launcher at the detect path.
  //   Unix: a script with a #!/usr/bin/env node shebang (no absolute-path
  //         shim that breaks on app update).
  //   Windows: a `.cmd` shim that invokes the managed node with the
  //         entrypoint (a shebang script is not executable on Windows).

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

  const shimPath = descriptor.detectPaths?.[0];
  if (!shimPath || fs.existsSync(shimPath)) return;
  ensureDir(path.dirname(shimPath));
  if (process.platform === 'win32') {
    const nodeForShim = resolveNodeForShim();
    fs.writeFileSync(shimPath, `@echo off\r\n"${nodeForShim}" "${entrypointAbs}" %*\r\n`, { encoding: 'utf8' });
    return;
  }
  const content = fs.readFileSync(entrypointAbs, 'utf-8');
  const withShebang = content.startsWith('#!') ? content : `#!/usr/bin/env node\n${content}`;
  fs.writeFileSync(shimPath, withShebang, { encoding: 'utf8', mode: 0o755 });
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
  if (managedNpm && fs.existsSync(managedNpm)) return managedNpm;
  // Dev environment / unmanaged install: fall back to npm_execpath or `npm`.
  return getNpmCommand();
}

async function installNpmPackage(
  packageName: string,
  options: { version?: string; timeoutMs?: number } = {}
): Promise<void> {
  const spec = options.version ? `${packageName}@${options.version}` : packageName;
  // Prefer the bundled npm from managed-resources so packaged installs never
  // depend on the user's system npm (missing on many Windows machines).
  const npmCommand = await getGlobalJsCommand();
  let lastError: unknown;
  for (const registry of [NPM_MIRROR_REGISTRY, NPM_DEFAULT_REGISTRY]) {
    try {
      await runCommand(npmCommand, ['install', '-g', spec], {
        env: getNpmEnv(registry),
        timeoutMs: options.timeoutMs ?? NPM_INSTALL_TIMEOUT_MS,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to install ${spec}`);
}

async function uninstallNpmPackage(packageName: string): Promise<void> {
  try {
    await runCommand(await getGlobalJsCommand(), ['uninstall', '-g', packageName], {
      env: getNpmEnv(NPM_DEFAULT_REGISTRY),
    });
  } catch {
    /* best effort */
  }
}

async function uninstallGlobalPackage(packageName: string): Promise<void> {
  await Promise.allSettled([uninstallNpmPackage(packageName), uninstallNpmPackage(packageName)]);
}

/**
 * Write a POUNDING-managed launcher for a npm-installed CLI at its detect
 * path (~/.local/bin/<name>). The shim invokes the bundled node with the
 * entrypoint installed under the managed npm prefix, so the CLI works even
 * when the managed prefix is not on the user's PATH.
 */
function writeNpmGlobalShim(target: ManagedCliInstallTarget): void {
  const descriptor = DESCRIPTORS[target];
  const shimPath = descriptor?.detectPaths?.[0];
  if (!shimPath) return;
  const isWin = process.platform === 'win32';
  const binName = isWin ? `${target}.cmd` : target;
  // npm's global bin directory differs per platform:
  //   unix:    <prefix>/bin/<name>
  //   win32:   <prefix>/<name>.cmd  (bin lives at the prefix root)
  const entrypoint = path.join(getManagedNpmBinDir(isWin), binName);
  if (!fs.existsSync(entrypoint)) return;
  const nodeForShim = resolveNodeForShim();
  ensureDir(path.dirname(shimPath));
  if (isWin) {
    fs.writeFileSync(shimPath, `@echo off\r\n"${nodeForShim}" "${entrypoint}" %*\r\n`, { encoding: 'utf8' });
    return;
  }
  fs.writeFileSync(shimPath, `#!/usr/bin/env bash\nexec "${nodeForShim}" "${entrypoint}" "$@"\n`, {
    encoding: 'utf8',
    mode: 0o755,
  });
}

export function getManagedNpmBinDir(isWin: boolean): string {
  return isWin ? MANAGED_NPM_GLOBAL_PREFIX : path.join(MANAGED_NPM_GLOBAL_PREFIX, 'bin');
}

function removeCliShim(target: ManagedCliInstallTarget): void {
  const shimPath = DESCRIPTORS[target]?.detectPaths?.[0];
  if (shimPath) safeRm(shimPath);
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

async function installHermes(): Promise<void> {
  // Prefer the bundled Python 3.12 runtime (managed-resources/runtimes/python)
  // so hermes-agent 0.19.0 (Requires-Python >=3.11,<3.14) installs offline and
  // does not depend on the user's system python3 (often 3.9/3.10 or 3.14+).
  // System python3 remains a fallback for environments without the bundle.
  const pythonBinary = resolveBundledPythonBinary() ?? (process.env.PYTHON_BINARY || 'python3');

  // Pin to the same version the vendor bundle ships (vendor-versions.env)
  // so network install and bundled install never drift.
  const packageName = `hermes-agent[acp]==${HERMES_VERSION}`;
  const indexUrls = ['https://pypi.tuna.tsinghua.edu.cn/simple', 'https://pypi.org/simple'];

  ensureDir(path.dirname(HERMES_VENV_DIR));
  await runCommand(pythonBinary, ['-m', 'venv', '--clear', HERMES_VENV_DIR], { timeoutMs: VENV_TIMEOUT_MS });
  const venvPython =
    process.platform === 'win32'
      ? path.join(HERMES_VENV_DIR, 'Scripts', 'python.exe')
      : path.join(HERMES_VENV_DIR, 'bin', 'python3');

  let lastError: unknown;
  for (const indexUrl of indexUrls) {
    try {
      await runCommand(
        venvPython,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '-i', indexUrl, '-U', packageName],
        { timeoutMs: PIP_INSTALL_TIMEOUT_MS }
      );
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
    await runCommand(locator, [command], { timeoutMs: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

// ── COS on-demand fallback ────────────────────────────────────────────
// When the official install (npm/pip) fails — e.g. blocked network — the
// desktop downloads a pre-built bundle from POUNDING COS instead of failing.
// The published artifact at `<target>/<version>/<platform>/bundle.tar.gz`
// contains the same layout the old installer-embedded bundle used:
// `manifest.json` (+ `entrypoint`, optional `node_modules/`), so the existing
// `materializeFromBundled` path writes the managed shim unchanged.
const COS_CLI_BASE_URL = 'https://yss-1256275613.cos.ap-guangzhou.myqcloud.com/pounding/cli';
const COS_DOWNLOAD_TIMEOUT_MS = 300_000;
const COS_EXTRACT_TIMEOUT_MS = 120_000;

export type CosBundleDownloader = (target: ManagedCliInstallTarget, version: string, destDir: string) => Promise<void>;

function getCliVersion(target: ManagedCliInstallTarget): string {
  switch (target) {
    case 'claude':
      return CLAUDE_CLI_VERSION;
    case 'hermes':
      return HERMES_VERSION;
    case 'openclaw':
      return OPENCLAW_VERSION;
    default:
      return 'latest';
  }
}

export function buildCosCliBundleUrl(target: ManagedCliInstallTarget): string {
  const version = getCliVersion(target);
  const platformKey = `${process.platform}-${process.arch}`;
  return `${COS_CLI_BASE_URL}/${target}/${version}/${platformKey}/bundle.tar.gz`;
}

function resolveCliFallbackCacheDir(target: ManagedCliInstallTarget, version: string): string {
  const platformKey = `${process.platform}-${process.arch}`;
  return path.join(getPOUNDINGDevDir(), 'runtime', 'cli', target, version, platformKey);
}

async function downloadToFile(url: string, destFile: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    ensureDir(path.dirname(destFile));
    fs.writeFileSync(destFile, data);
  } finally {
    clearTimeout(timer);
  }
}

async function defaultCosBundleDownloader(
  target: ManagedCliInstallTarget,
  version: string,
  destDir: string
): Promise<void> {
  const url = buildCosCliBundleUrl(target);
  const tarball = path.join(os.tmpdir(), `pounding-cli-${target}-${version}-${process.pid}.tar.gz`);
  try {
    await downloadToFile(url, tarball, COS_DOWNLOAD_TIMEOUT_MS);
    ensureDir(destDir);
    await runCommand('tar', ['-xzf', tarball, '-C', destDir], { timeoutMs: COS_EXTRACT_TIMEOUT_MS });
  } finally {
    safeRm(tarball);
  }
}

export async function installFromCosFallback(
  target: ManagedCliInstallTarget,
  downloader: CosBundleDownloader = defaultCosBundleDownloader
): Promise<boolean> {
  const descriptor = DESCRIPTORS[target];
  if (!descriptor) return false;
  try {
    const version = getCliVersion(target);
    const destDir = resolveCliFallbackCacheDir(target, version);
    safeRm(destDir);
    await downloader(target, version, destDir);
    if (!fs.existsSync(path.join(destDir, 'manifest.json'))) {
      console.warn(`[POUNDING] COS fallback bundle missing manifest.json for ${target}`);
      return false;
    }
    materializeFromBundled(descriptor, destDir);
    console.log(`[POUNDING] ${target} installed from COS fallback bundle`);
    return true;
  } catch (err) {
    console.warn(`[POUNDING] COS fallback install failed for ${target}:`, err);
    return false;
  }
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
      // Pin to the bundled version (vendor-versions.env) so network install
      // and bundle never drift.
      await installNpmPackage('@anthropic-ai/claude-code', { version: CLAUDE_CLI_VERSION });
      writeNpmGlobalShim('claude');
    },
    uninstall: async () => {
      await uninstallGlobalPackage('@anthropic-ai/claude-code');
      removeCliShim('claude');
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
      // Pin to the extended-stable version (vendor-versions.env).
      await installNpmPackage('openclaw', { version: OPENCLAW_VERSION });
      writeNpmGlobalShim('openclaw');
    },
    uninstall: async () => {
      await uninstallGlobalPackage('openclaw');
      removeCliShim('openclaw');
    },
  },
  opencode: {
    target: 'opencode',
    detectCommand: 'opencode',
    detectPaths: [
      path.join(HERMES_BIN_DIR, process.platform === 'win32' ? 'opencode.cmd' : 'opencode'),
      path.join(BUN_BIN_DIR, process.platform === 'win32' ? 'opencode.cmd' : 'opencode'),
    ],
    install: installOpenCode,
    uninstall: uninstallOpenCode,
  },
};

async function isManagedCliInstalled(descriptor: ManagedCliDescriptor): Promise<boolean> {
  // Check the POUNDING-managed install dirs first (they may not be on the
  // user's PATH — e.g. ~/.local/bin on Windows). A stale/corrupt file on
  // disk still counts as "installed"; re-install would overwrite it.
  const pathChecks = descriptor.detectPaths ?? [];
  if (pathChecks.some((candidate) => isAbsoluteExecutablePath(candidate))) return true;
  // Fall back to PATH lookup (which/where).
  return commandExists(descriptor.detectCommand);
}

async function syncAfterInstall(target: ManagedCliInstallTarget): Promise<void> {
  await newApiDesktopAccountService.reconcileManagedRuntimeState({ cliTarget: target });
}

async function syncAfterUninstall(target: ManagedCliInstallTarget): Promise<void> {
  await newApiDesktopAccountService.clearManagedRuntimeForCliTarget(target);
}

const inFlightInstalls = new Map<ManagedCliInstallTarget, Promise<ManagedCliInstallResult>>();

async function installManagedCliInternal(
  descriptor: ManagedCliDescriptor,
  cosDownloader?: CosBundleDownloader
): Promise<ManagedCliInstallResult> {
  try {
    const alreadyInstalled = await isManagedCliInstalled(descriptor);
    if (alreadyInstalled) {
      await syncAfterInstall(descriptor.target);
      return { success: true, status: 'installed' };
    }

    // Official-first: run the CLI's native package manager (npm/pip) with the
    // pinned version and mirror fallbacks. The bundled-first materialization
    // was removed with the installer de-bundling.
    try {
      console.log(`[POUNDING] Installing ${descriptor.target} via official package manager...`);
      await descriptor.install();
      await syncAfterInstall(descriptor.target);
      const installed = await isManagedCliInstalled(descriptor);
      if (installed) {
        return { success: true, status: 'installed' };
      }
      console.warn(`[POUNDING] Official install finished but ${descriptor.target} is not detectable, trying COS...`);
    } catch (err) {
      console.warn(`[POUNDING] Official install failed for ${descriptor.target}, trying COS fallback:`, err);
    }

    // COS fallback: download the pre-built bundle and materialize the shim.
    const cosOk = await installFromCosFallback(descriptor.target, cosDownloader);
    if (cosOk) {
      await syncAfterInstall(descriptor.target);
      const installed = await isManagedCliInstalled(descriptor);
      if (installed) {
        return { success: true, status: 'installed' };
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

export async function installManagedCli(
  input: ManagedCliInstallOptions,
  cosDownloader?: CosBundleDownloader
): Promise<ManagedCliInstallResult> {
  const descriptor = DESCRIPTORS[input.target];
  if (!descriptor) {
    return {
      success: false,
      status: 'failed',
      message: `Unsupported target: ${String(input.target)}`,
    };
  }

  // Serialize concurrent installs of the same target. The settings page and
  // the CLI prep flow can both request the same CLI; running two
  // `npm install -g` / `python -m venv --clear` on the same dirs concurrently
  // corrupts them and looks like a hung install.
  const existing = inFlightInstalls.get(input.target);
  if (existing) return existing;
  const run = installManagedCliInternal(descriptor, cosDownloader);
  inFlightInstalls.set(input.target, run);
  try {
    return await run;
  } finally {
    if (inFlightInstalls.get(input.target) === run) {
      inFlightInstalls.delete(input.target);
    }
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
  ipcBridge.managedCliInstaller.detectAll.provider(async () =>
    detectCliInstallations(['claude', 'hermes', 'openclaw'], {
      managedDirs: [HERMES_BIN_DIR, BUN_BIN_DIR],
    })
  );
  ipcBridge.managedCliInstaller.setCliPath.provider(async (overrides: CliPathOverrides) => {
    writeCliPaths(overrides ?? {});
  });
}
