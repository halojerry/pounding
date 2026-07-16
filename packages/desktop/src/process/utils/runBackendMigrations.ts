/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { migrateConfigStorage, migrateLegacyMcpConfigToDb, migrateProviders } from '@/common/config/configMigration';
import { httpRequest } from '@/common/adapter/httpBridge';
import { mcpService } from '@/common/adapter/ipcBridge';
import type { ImageGenerationModelSetting } from '@/common/config/clientSettings';
import {
  removeImageGenerationEnvKeys,
  resolveImageGenerationMcpEnv,
  type ImageGenerationMcpEnvResolveResult,
} from '@/common/config/imageGenerationMcpEnv';
import { BUILTIN_IMAGE_GEN_NAME, type IMcpServer, type IProvider } from '@/common/config/storage';
import { getBuiltinMcpScriptPath, type ProcessConfig as ProcessConfigType } from './initStorage';
import { getDataPath } from './utils';
import { migrateAssistantsToBackend } from './migrateAssistants';

type ConfigFile = typeof ProcessConfigType;
type MigrationStepResult = boolean;
type McpImportServer = Partial<IMcpServer> & Pick<IMcpServer, 'name' | 'transport'>;
type BackendClientPreferences = Record<string, unknown>;
const BUILTIN_CHROME_DEVTOOLS_NAME = 'chrome-devtools';

const LEGACY_BACKEND_CLIENT_PREFERENCE_KEYS = [
  'assistants',
  'migration.assistantEnabledFixed',
  'migration.coworkDefaultSkillsAdded',
  'migration.builtinDefaultSkillsAdded_v2',
  'migration.promptsI18nAdded',
  'migration.assistantsSplitCustom',
] as const;

async function cleanupLegacyClientPreferences(): Promise<void> {
  const payloadEntries = LEGACY_BACKEND_CLIENT_PREFERENCE_KEYS.map((key): [string, null] => [key, null]);
  const payload = Object.fromEntries(payloadEntries);
  await httpRequest<void>('PUT', '/api/settings/client', payload);
}

const CLEANUP_STEPS: Array<{
  name: string;
  run: () => Promise<void>;
}> = [{ name: 'cleanupLegacyClientPreferences', run: async () => cleanupLegacyClientPreferences() }];

async function fetchBackendClientPreferences(): Promise<BackendClientPreferences> {
  try {
    return (await httpRequest<BackendClientPreferences>('GET', '/api/settings/client')) || {};
  } catch {
    return {};
  }
}

async function fetchProviders(): Promise<IProvider[]> {
  try {
    return (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
  } catch (error) {
    console.warn('[Migration] MCP bootstrap could not load providers for image generation env resolution', error);
    return [];
  }
}

export function resolveImageGenerationMigrationConfig(
  backendPrefs: BackendClientPreferences,
  fileConfig?: ImageGenerationModelSetting
): ImageGenerationModelSetting | undefined {
  const backendConfig = backendPrefs['tools.imageGenerationModel'];
  if (backendConfig && typeof backendConfig === 'object') {
    return backendConfig as ImageGenerationModelSetting;
  }
  return fileConfig;
}

function resolveImageGenerationMigrationConfigSource(
  backendPrefs: BackendClientPreferences,
  fileConfig?: ImageGenerationModelSetting
): 'backend' | 'file' | 'none' {
  const backendConfig = backendPrefs['tools.imageGenerationModel'];
  if (backendConfig && typeof backendConfig === 'object') {
    return 'backend';
  }
  return fileConfig ? 'file' : 'none';
}

function logImageGenerationEnvResolution(
  result: ImageGenerationMcpEnvResolveResult,
  context: 'bootstrap' | 'update'
): void {
  if (result.ok === true) {
    console.info(
      '[Migration] image MCP env resolved via %s during %s, provider id: %s, platform: %s, model: %s, api key present: %s',
      result.source,
      context,
      result.provider.id,
      result.provider.platform,
      result.model,
      result.provider.api_key ? 'yes' : 'no'
    );
    return;
  }

  console.warn(
    '[Migration] image MCP env resolution failed during %s, reason: %s, message: %s, candidates: %s',
    context,
    result.reason,
    result.message,
    result.candidates?.join(',') || 'none'
  );
}

function buildBuiltinImageGenerationServer(
  resolution: ImageGenerationMcpEnvResolveResult,
  config?: ImageGenerationModelSetting
): McpImportServer {
  const scriptPath = getBuiltinMcpScriptPath('builtin-mcp-image-gen');
  const env = resolution.ok ? resolution.env : {};
  const serverConfig = {
    command: 'node',
    args: [scriptPath],
    env,
  };

  return {
    name: BUILTIN_IMAGE_GEN_NAME,
    description: 'Built-in image generation tool powered by AI models. Configure the model in Settings > Tools.',
    enabled: resolution.ok,
    builtin: true,
    transport: {
      type: 'stdio',
      command: 'node',
      args: [scriptPath],
      env,
    },
    original_json: JSON.stringify({ mcpServers: { [BUILTIN_IMAGE_GEN_NAME]: serverConfig } }, null, 2),
  };
}

function areStringArraysEqual(left?: string[], right?: string[]): boolean {
  const leftValue = left || [];
  const rightValue = right || [];
  return leftValue.length === rightValue.length && leftValue.every((item, index) => item === rightValue[index]);
}

function areStringRecordsEqual(left?: Record<string, string>, right?: Record<string, string>): boolean {
  const leftValue = left || {};
  const rightValue = right || {};
  const leftKeys = Object.keys(leftValue).toSorted();
  const rightKeys = Object.keys(rightValue).toSorted();
  return areStringArraysEqual(leftKeys, rightKeys) && leftKeys.every((key) => leftValue[key] === rightValue[key]);
}

function isSameStdioTransport(left: IMcpServer['transport'], right: IMcpServer['transport']): boolean {
  return (
    left.type === 'stdio' &&
    right.type === 'stdio' &&
    left.command === right.command &&
    areStringArraysEqual(left.args, right.args) &&
    areStringRecordsEqual(left.env, right.env)
  );
}

/** Recursively copy a directory. Creates target directory if needed. */
function copyDirectorySync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(srcPath), destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function resolveManagedNodeRoot(): string {
  // Uses the same managed node runtime as AionCore — probed via 'node' binary
  // in the managed runtime directory. Falls back to system node.
  // Use getDataPath() to correctly resolve the data directory in both dev
  // (~/.pounding-dev) and production (~/.pounding) environments.
  const dataPath = getDataPath();
  const managedRoot = path.join(dataPath, 'runtime', 'node');
  if (fs.existsSync(managedRoot)) {
    const versions = fs.readdirSync(managedRoot).filter((d) => d.startsWith('node-v'));
    if (versions.length > 0) {
      return path.join(managedRoot, versions[0]);
    }
  }
  return ''; // fall back to system PATH
}

function resolveManagedNodeCommand(): string {
  const root = resolveManagedNodeRoot();
  if (!root) return 'node';
  const isWin = process.platform === 'win32';
  // Windows Node.js distribution: node.exe is at the root level
  // Unix Node.js distribution: bin/node
  return isWin ? path.join(root, 'node.exe') : path.join(root, 'bin', 'node');
}

function resolveManagedNodeModule(pkgName: string, entry: string): string {
  const root = resolveManagedNodeRoot();
  if (!root) return ''; // fall back to npx download

  // Managed Node's global modules are installed to {root}/tools/global/lib/node_modules/
  // (npm prefix = root/tools/global). Also check the legacy {root}/lib/node_modules/ path.
  const candidates = [
    path.join(root, 'tools', 'global', 'lib', 'node_modules', pkgName, entry),
    path.join(root, 'lib', 'node_modules', pkgName, entry),
  ];
  for (const pkgPath of candidates) {
    if (fs.existsSync(pkgPath)) return pkgPath;
  }
  return '';
}

/** Copy a compiled builtin MCP script from the build output to the data
 *  directory so the Rust ACP injection path can find it. */
function materializeBuiltinMcpScript(scriptName: string, targetName: string): void {
  try {
    const src = getBuiltinMcpScriptPath(scriptName);
    if (!fs.existsSync(src)) {
      console.warn(`[POUNDING] Builtin MCP script not found: ${src}`);
      return;
    }
    const destDir = path.join(getDataPath(), 'builtin-mcp');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, targetName);
    // Skip if already up-to-date (same size)
    if (fs.existsSync(dest)) {
      const srcStat = fs.statSync(src);
      const destStat = fs.statSync(dest);
      if (srcStat.size === destStat.size) return;
    }
    fs.copyFileSync(src, dest);
    console.log(`[POUNDING] Materialized builtin MCP script: ${dest}`);
  } catch (err) {
    console.warn(`[POUNDING] Failed to materialize builtin MCP script ${scriptName}:`, err);
  }
}

/** Pre-install chrome-devtools-mcp into the managed Node runtime's global
 *  modules so it is available offline without `npx` downloading at runtime.
 *
 *  Tries bundled resources first (shipped with the app), then falls back
 *  to `npm install -g` for dev/network environments. */
function preinstallChromeDevtoolsMcp(): void {
  const root = resolveManagedNodeRoot();
  if (!root) {
    console.warn('[POUNDING] Managed Node runtime not found; skipping chrome-devtools-mcp preinstall');
    return;
  }
  const isWin = process.platform === 'win32';
  // Windows Node.js distribution: node.exe, npm.cmd at root level (no bin/)
  // Unix Node.js distribution: bin/node, bin/npm
  const nodeBin = isWin ? path.join(root, 'node.exe') : path.join(root, 'bin', 'node');
  const npmBin = isWin ? path.join(root, 'npm.cmd') : path.join(root, 'bin', 'npm');
  if (!fs.existsSync(nodeBin) || !fs.existsSync(npmBin)) {
    console.warn('[POUNDING] Managed node/npm binaries not found; skipping chrome-devtools-mcp preinstall');
    return;
  }
  // Check if already installed
  const installedPath = path.join(root, 'tools', 'global', 'lib', 'node_modules', 'chrome-devtools-mcp');
  if (fs.existsSync(installedPath)) {
    return; // already installed
  }

  // Try bundled resources first (offline path from vendor-managed-resources.sh)
  const platformKey = `${process.platform}-${process.arch}`;
  const bundledMCP =
    process.resourcesPath &&
    path.join(process.resourcesPath, 'bundled-poundingcore', platformKey, 'managed-resources', 'mcp');
  if (bundledMCP && fs.existsSync(bundledMCP)) {
    const versions = fs.readdirSync(bundledMCP).filter((d) => d.startsWith('chrome-devtools-mcp'));
    if (versions.length > 0) {
      // Find the right platform subdirectory
      for (const ver of versions) {
        const platDirs = fs
          .readdirSync(path.join(bundledMCP, ver))
          .filter((d) => d.includes(process.platform) && d.includes(process.arch));
        for (const platDir of platDirs) {
          const srcDir = path.join(bundledMCP, ver, platDir);
          if (fs.existsSync(path.join(srcDir, 'manifest.json'))) {
            try {
              const destDir = path.join(root, 'tools', 'global', 'lib', 'node_modules');
              fs.mkdirSync(destDir, { recursive: true });
              const dest = path.join(destDir, 'chrome-devtools-mcp');
              if (!fs.existsSync(dest)) {
                copyDirectorySync(srcDir, dest);
                console.log('[POUNDING] chrome-devtools-mcp materialized from bundled resources');
              }
              return;
            } catch (err) {
              console.warn('[POUNDING] Failed to materialize chrome-devtools-mcp from bundle:', err);
            }
          }
        }
      }
    }
  }

  // Fallback: npm install (needs network)
  console.log('[POUNDING] Pre-installing chrome-devtools-mcp to managed Node runtime...');
  try {
    const npmPrefix = path.join(root, 'tools', 'global');
    execFileSync(nodeBin, [npmBin, 'install', '-g', 'chrome-devtools-mcp'], {
      stdio: 'pipe',
      timeout: 120_000,
      env: {
        ...process.env,
        npm_config_prefix: npmPrefix,
        npm_config_userconfig: path.join(root, 'blank_user_npmrc'),
        npm_config_globalconfig: path.join(root, 'blank_global_npmrc'),
      },
    });
    console.log('[POUNDING] chrome-devtools-mcp installed successfully');
  } catch (err) {
    console.warn('[POUNDING] Failed to preinstall chrome-devtools-mcp:', err);
  }
}

function buildDefaultMcpServers(): McpImportServer[] {
  const chromeConfig = {
    // Use managed node binary with locally-installed chrome-devtools-mcp
    command: resolveManagedNodeCommand(),
    args: [
      resolveManagedNodeModule('chrome-devtools-mcp', 'build/src/bin/chrome-devtools-mcp.js'),
      '--browser-url=http://127.0.0.1:9230',
    ],
  };

  const imageGenConfig = {
    command: 'node',
    args: [getBuiltinMcpScriptPath('builtin-mcp-image-gen')],
  };

  return [
    {
      name: BUILTIN_CHROME_DEVTOOLS_NAME,
      description: 'Default MCP server: chrome-devtools',
      enabled: true,
      builtin: true,
      transport: {
        type: 'stdio',
        command: chromeConfig.command,
        args: chromeConfig.args,
      },
      original_json: JSON.stringify({ mcpServers: { [BUILTIN_CHROME_DEVTOOLS_NAME]: chromeConfig } }, null, 2),
    },
    {
      name: BUILTIN_IMAGE_GEN_NAME,
      description: 'Built-in image generation tool powered by AI models. Configure the model in Settings > Tools.',
      enabled: true,
      builtin: true,
      transport: {
        type: 'stdio',
        command: imageGenConfig.command,
        args: imageGenConfig.args,
      },
      original_json: JSON.stringify({ mcpServers: { [BUILTIN_IMAGE_GEN_NAME]: imageGenConfig } }, null, 2),
    },
  ];
}

async function isCommandAvailable(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 3000 }, (error) => {
      if (!error) {
        resolve(true);
        return;
      }

      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        resolve(false);
        return;
      }

      resolve(true);
    });
  });
}

async function ensureBuiltinChromeDevtoolsAvailability(server?: IMcpServer): Promise<void> {
  if (
    !server ||
    server.name !== BUILTIN_CHROME_DEVTOOLS_NAME ||
    server.transport.type !== 'stdio' ||
    server.transport.command !== 'npx'
  ) {
    return;
  }

  const hasNpx = await isCommandAvailable(server.transport.command);
  if (hasNpx) {
    return;
  }

  try {
    await mcpService.testMcpConnection.invoke(server);
  } catch (error) {
    console.warn('[Migration] chrome-devtools MCP preflight failed', error);
  }
}

function buildOriginalJsonFromTransport(server: Pick<IMcpServer, 'name' | 'description' | 'transport'>): string {
  const transport_config =
    server.transport.type === 'stdio'
      ? {
          command: server.transport.command,
          args: server.transport.args || [],
          env: server.transport.env || {},
        }
      : {
          type: server.transport.type,
          url: server.transport.url,
          ...(server.transport.headers ? { headers: server.transport.headers } : {}),
        };

  return JSON.stringify(
    {
      mcpServers: {
        [server.name]: {
          ...(server.description ? { description: server.description } : {}),
          ...transport_config,
        },
      },
    },
    null,
    2
  );
}

async function ensureBootstrapMcpServersInDb(configFile: ConfigFile): Promise<void> {
  const [backendPrefs, fileImageConfig, providers] = await Promise.all([
    fetchBackendClientPreferences(),
    configFile.get('tools.imageGenerationModel').catch((): undefined => undefined),
    fetchProviders(),
  ]);
  const imageConfig = resolveImageGenerationMigrationConfig(backendPrefs, fileImageConfig);
  const imageConfigSource = resolveImageGenerationMigrationConfigSource(backendPrefs, fileImageConfig);
  const existing = await mcpService.listServers.invoke();
  const existingByName = new Map((existing ?? []).map((server) => [server.name, server]));
  const existingImageServer = existingByName.get(BUILTIN_IMAGE_GEN_NAME);
  const existingImageEnv =
    existingImageServer?.transport.type === 'stdio' ? existingImageServer.transport.env : undefined;
  const imageEnvResolution = resolveImageGenerationMcpEnv(imageConfig, providers, existingImageEnv);
  logImageGenerationEnvResolution(imageEnvResolution, 'bootstrap');
  const imageServer = buildBuiltinImageGenerationServer(imageEnvResolution, imageConfig);
  const defaultServers = buildDefaultMcpServers();

  // Materialize the compiled image-gen MCP script to the data directory so
  // the Rust ACP injection path (factory/acp.rs) can find it at
  // {data_dir}/builtin-mcp/image-gen-server.js.
  materializeBuiltinMcpScript('builtin-mcp-image-gen', 'image-gen-server.js');

  // Pre-install chrome-devtools-mcp into the managed Node runtime so it's
  // available offline (no npx download needed at runtime).
  preinstallChromeDevtoolsMcp();

  const missing = [...defaultServers, imageServer].filter((server) => !existingByName.has(server.name));
  let imageServerUpdated = false;

  if (missing.length > 0) {
    await mcpService.batchImportServers.invoke({ servers: missing });
  }

  // Ensure existing builtin MCP servers are enabled (in case they were
  // previously created with enabled=false by an older migration).
  // Deduplicate — image-gen may appear in both defaultServers and imageServer.
  const seen = new Set<string>();
  const uniqueServers = [...defaultServers, imageServer].filter((server) => {
    if (seen.has(server.name)) return false;
    seen.add(server.name);
    return true;
  });
  // Enable any builtin servers that were previously disabled.
  // Collect promises and run in parallel (each toggle is independent).
  const enableTasks: Promise<unknown>[] = [];
  for (const server of uniqueServers) {
    const match = existingByName.get(server.name);
    if (match && !match.enabled) {
      enableTasks.push(mcpService.toggleServer.invoke({ id: match.id }));
    }
  }
  await Promise.all(enableTasks);

  const existingChromeDevtools = existingByName.get(BUILTIN_CHROME_DEVTOOLS_NAME);
  if (
    existingChromeDevtools &&
    (existingChromeDevtools.builtin !== true ||
      !existingChromeDevtools.original_json ||
      existingChromeDevtools.original_json.trim() === '' ||
      existingChromeDevtools.original_json.trim() === '{}')
  ) {
    await mcpService.updateServer.invoke({
      id: existingChromeDevtools.id,
      data: {
        builtin: true,
        original_json: buildOriginalJsonFromTransport(existingChromeDevtools),
      },
    });
  }

  const refreshedServers = await mcpService.listServers.invoke();
  const chromeDevtoolsServer = refreshedServers.find((server) => server.name === BUILTIN_CHROME_DEVTOOLS_NAME);
  await ensureBuiltinChromeDevtoolsAvailability(chromeDevtoolsServer);

  if (
    imageEnvResolution.ok === true &&
    existingImageServer &&
    existingImageServer.transport.type === 'stdio' &&
    imageServer.transport.type === 'stdio'
  ) {
    const mergedEnv = {
      ...removeImageGenerationEnvKeys(existingImageServer.transport.env || {}),
      ...imageEnvResolution.env,
    };
    const updatedTransport = {
      ...imageServer.transport,
      env: mergedEnv,
    };
    const original_json = JSON.stringify(
      {
        mcpServers: {
          [BUILTIN_IMAGE_GEN_NAME]: {
            command: updatedTransport.command,
            args: updatedTransport.args || [],
            env: mergedEnv,
          },
        },
      },
      null,
      2
    );
    const imageTransportChanged = !isSameStdioTransport(existingImageServer.transport, updatedTransport);
    const imageOriginalJsonChanged = existingImageServer.original_json !== original_json;
    const imageServerChanged = imageTransportChanged || imageOriginalJsonChanged;
    console.info(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, will update: %s',
      existingImageServer.id,
      imageTransportChanged ? 'yes' : 'no',
      imageOriginalJsonChanged ? 'yes' : 'no',
      imageServerChanged ? 'yes' : 'no'
    );
    if (imageServerChanged) {
      await mcpService.updateServer.invoke({
        id: existingImageServer.id,
        data: {
          transport: updatedTransport,
          original_json,
        },
      });
      imageServerUpdated = true;
    }
  } else if (existingImageServer && imageEnvResolution.ok === false) {
    console.warn(
      '[Migration] skipped image MCP env update because provider could not be resolved, server id: %s, reason: %s',
      existingImageServer.id,
      imageEnvResolution.reason
    );
  }

  console.info(
    '[Migration] MCP bootstrap completed, imported %d missing defaults, updated image server: %s, image config source: %s, image enabled: %s',
    missing.length,
    imageServerUpdated ? 'yes' : 'no',
    imageConfigSource,
    imageConfig?.switch === true ? 'yes' : 'no'
  );
}

const MIGRATION_STEPS: Array<{
  name: string;
  run: (configFile: ConfigFile) => Promise<MigrationStepResult>;
}> = [
  {
    name: 'migrateLegacyMcpConfigToDb',
    run: async (configFile) => (await migrateLegacyMcpConfigToDb(configFile), true),
  },
  { name: 'migrateConfigStorage', run: async (configFile) => (await migrateConfigStorage(configFile), true) },
  { name: 'migrateProviders', run: async (configFile) => (await migrateProviders(configFile), true) },
  {
    name: 'ensureBootstrapMcpServersInDb',
    run: async (configFile) => (await ensureBootstrapMcpServersInDb(configFile), true),
  },
  { name: 'migrateAssistantsToBackend', run: async (configFile) => migrateAssistantsToBackend(configFile) },
];

async function syncBuiltinMcpConfig(configFile: ConfigFile): Promise<void> {
  const localMcpConfig = ((await configFile.get('mcp.config').catch((): IMcpServer[] => [])) || []) as IMcpServer[];
  const localBuiltinServers = localMcpConfig.filter((server) => server?.builtin === true);

  if (localBuiltinServers.length === 0) {
    return;
  }

  const backendSettings = (await httpRequest<Record<string, unknown>>('GET', '/api/settings/client')) || {};
  const backendMcpConfig = Array.isArray(backendSettings['mcp.config'])
    ? (backendSettings['mcp.config'] as IMcpServer[])
    : [];

  const mergedMcpConfig = [...backendMcpConfig.filter((server) => server?.builtin !== true), ...localBuiltinServers];

  if (JSON.stringify(backendMcpConfig) === JSON.stringify(mergedMcpConfig)) {
    return;
  }

  await httpRequest<void>('PUT', '/api/settings/client', { 'mcp.config': mergedMcpConfig });
  console.info(
    '[POUNDING] Synced builtin MCP config to backend settings (%d builtin servers)',
    localBuiltinServers.length
  );
}

export async function runBackendMigrations(configFile: ConfigFile): Promise<void> {
  await CLEANUP_STEPS.reduce<Promise<void>>(async (previous, step) => {
    await previous;
    const start = Date.now();
    try {
      await step.run();
      console.info(`[POUNDING] Backend migration step completed: ${step.name} (${Date.now() - start}ms)`);
    } catch (error) {
      console.error(`[POUNDING] Backend migration step failed: ${step.name} (${Date.now() - start}ms)`, error);
    }
  }, Promise.resolve());

  await MIGRATION_STEPS.reduce<Promise<void>>(async (previous, step) => {
    await previous;
    const start = Date.now();
    try {
      const completed = await step.run(configFile);
      const elapsed = Date.now() - start;
      if (!completed) {
        console.warn(`[POUNDING] Backend migration step incomplete: ${step.name} (${elapsed}ms)`);
        return;
      }
      console.info(`[POUNDING] Backend migration step completed: ${step.name} (${elapsed}ms)`);
    } catch (error) {
      const elapsed = Date.now() - start;
      console.error(`[POUNDING] Backend migration step failed: ${step.name} (${elapsed}ms)`, error);
    }
  }, Promise.resolve());

  const syncStart = Date.now();
  try {
    await syncBuiltinMcpConfig(configFile);
    console.info(`[POUNDING] Backend migration step completed: syncBuiltinMcpConfig (${Date.now() - syncStart}ms)`);
  } catch (error) {
    console.error(
      `[POUNDING] Backend migration step failed: syncBuiltinMcpConfig (${Date.now() - syncStart}ms)`,
      error
    );
  }
}
