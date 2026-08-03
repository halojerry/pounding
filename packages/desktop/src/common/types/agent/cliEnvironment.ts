/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** CLI targets managed by the Runtime Environment self-service panel. */
export type CliEnvironmentTarget = 'claude' | 'hermes' | 'openclaw';

export type CliSource = 'nvm' | 'homebrew' | 'bun' | 'pip' | 'system' | 'managed';

export type CliInstallation = {
  binary: CliEnvironmentTarget;
  /** Absolute path to the executable. */
  path: string;
  /** First line of `--version` output, or null when not runnable. */
  version: string | null;
  /** `--version` exited 0 with non-empty output. */
  runnable: boolean;
  source: CliSource;
  /** True only for the first PATH hit (PATH takes precedence). */
  isDefault: boolean;
};

export type CliTargetStatus = {
  target: CliEnvironmentTarget;
  installations: CliInstallation[];
  /** First PATH hit, or null when the CLI is only present in managed dirs. */
  defaultPath: string | null;
  /** Multiple installs with divergent sources/versions, or multiple PATH hits. */
  conflict: boolean;
};

/** User-configured CLI path overrides persisted to ~/.pounding/cli-paths.json. */
export type CliPathOverrides = Partial<Record<CliEnvironmentTarget, string>>;
