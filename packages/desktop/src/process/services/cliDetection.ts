/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type {
  CliEnvironmentTarget,
  CliInstallation,
  CliSource,
  CliTargetStatus,
} from '@/common/types/agent/cliEnvironment';

export type CliTargetName = CliEnvironmentTarget;
export type { CliInstallation, CliSource, CliTargetStatus } from '@/common/types/agent/cliEnvironment';

export interface DetectCliOptions {
  /** Extra directories to scan for managed installs (e.g. `~/.local/bin`). */
  managedDirs?: string[];
  /** PATH entries to enumerate. Defaults to `process.env.PATH`. */
  pathEntries?: string[];
}

const VERSION_PROBE_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 16 * 1024 * 1024;

function defaultManagedDirs(home: string): string[] {
  return [path.join(home, '.local', 'bin')];
}

/**
 * Classifies where a CLI executable came from. `managedDirs` wins over
 * substring heuristics; `~/.local/bin` is always treated as managed.
 */
export function classifySource(binaryPath: string, home: string, managedDirs: string[]): CliSource {
  const resolved = path.resolve(binaryPath);
  const normalizedManagedDirs = managedDirs.map((dir) => path.resolve(dir));
  if (normalizedManagedDirs.some((dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`))) {
    return 'managed';
  }

  const localBin = path.join(home, '.local', 'bin');
  if (resolved === localBin || resolved.startsWith(`${localBin}${path.sep}`)) {
    return 'managed';
  }

  if (resolved.includes(`${path.sep}.nvm${path.sep}`)) {
    return 'nvm';
  }

  if (resolved.startsWith('/opt/homebrew/') || resolved.includes(`${path.sep}.linuxbrew${path.sep}`)) {
    return 'homebrew';
  }

  if (resolved.includes(`${path.sep}.bun${path.sep}`)) {
    return 'bun';
  }

  return 'system';
}

/** A `--version` probe is runnable when it produced non-empty, non-error output. */
export function isRunnableVersionOutput(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) {
    return false;
  }
  return !/command not found|no such file|not recognized|is not recognized/i.test(trimmed);
}

function extractVersion(output: string): string | null {
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? null;
}

function runCommandOutput(
  command: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        env: {
          ...process.env,
          ...options.env,
        },
        shell: false,
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
    child.unref?.();
  });
}

async function enumeratePathHits(target: CliTargetName, pathEntries: string[]): Promise<string[]> {
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'where' : 'which';
  const args = isWindows ? [target] : ['-a', target];
  try {
    const output = await runCommandOutput(command, args, {
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      env: { PATH: pathEntries.join(path.delimiter) },
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function scanManagedDirs(target: CliTargetName, managedDirs: string[]): string[] {
  const hits: string[] = [];
  for (const dir of managedDirs) {
    const candidate = path.join(dir, target);
    if (existsSync(candidate)) {
      hits.push(candidate);
    }
  }
  return hits;
}

async function probeBinary(binary: CliTargetName, binaryPath: string, sourceDirs: string[]): Promise<CliInstallation> {
  const source = classifySource(binaryPath, os.homedir(), sourceDirs);
  try {
    const output = await runCommandOutput(binaryPath, ['--version'], {
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    });
    const runnable = isRunnableVersionOutput(output);
    return {
      binary,
      path: binaryPath,
      version: runnable ? extractVersion(output) : null,
      runnable,
      source,
      isDefault: false,
    };
  } catch {
    return {
      binary,
      path: binaryPath,
      version: null,
      runnable: false,
      source,
      isDefault: false,
    };
  }
}

function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Enumerates every known install of each requested CLI (PATH hits first,
 * managed dirs second), probing each for a runnable `--version`.
 */
export async function detectCliInstallations(
  targets: CliTargetName[],
  options: DetectCliOptions = {}
): Promise<CliTargetStatus[]> {
  const home = os.homedir();
  const managedDirs = (options.managedDirs !== undefined ? options.managedDirs : defaultManagedDirs(home)).map((dir) =>
    path.resolve(dir)
  );
  const pathEntries = options.pathEntries ?? (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);

  const statuses: CliTargetStatus[] = [];
  for (const target of targets) {
    const pathHits = await enumeratePathHits(target, pathEntries);
    const managedHits = scanManagedDirs(target, managedDirs);

    const installations: CliInstallation[] = [];
    const seen = new Set<string>();
    let defaultAssigned = false;

    for (const candidate of pathHits) {
      const key = pathKey(candidate);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const installation = await probeBinary(target, candidate, managedDirs);
      if (!defaultAssigned) {
        installation.isDefault = true;
        defaultAssigned = true;
      }
      installations.push(installation);
    }

    for (const candidate of managedHits) {
      const key = pathKey(candidate);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const installation = await probeBinary(target, candidate, managedDirs);
      installations.push(installation);
    }

    const uniqueSources = new Set(installations.map((installation) => installation.source)).size;
    const uniqueVersions = new Set(
      installations.map((installation) => installation.version).filter((version): version is string => version !== null)
    ).size;
    const conflict = installations.length > 1 && (uniqueSources > 1 || uniqueVersions > 1 || pathHits.length > 1);

    statuses.push({
      target,
      installations,
      defaultPath: installations.find((installation) => installation.isDefault)?.path ?? null,
      conflict,
    });
  }
  return statuses;
}
