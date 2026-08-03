/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BackendStartupFailureInfo } from '@/common/types/platform/electron';

export type BootGateState = 'splash' | 'failure' | 'app';

/**
 * Startup failures that warrant the full-screen recovery dialog instead of the
 * normal app boot (mirrors the reasons handled by BackendStartupFailureDialog).
 */
const DIALOG_RELEVANT_REASONS: ReadonlySet<string> = new Set([
  'backend_incompatible_runtime',
  'backend_incomplete_installation',
  'backend_package_architecture_mismatch',
  'backend_data_migration_failed',
  'backend_local_data_repair_failed',
  'backend_recoverable_database_corruption',
  'backend_transient_concurrent_startup',
  'backend_startup_failed',
]);

export function isBackendStartupFailureDialogRelevant(failure: BackendStartupFailureInfo | null | undefined): boolean {
  return !!failure && DIALOG_RELEVANT_REASONS.has(failure.reason);
}

/**
 * Decide what the renderer should mount at boot:
 * - 'splash'  → backend port not known yet (window was created early; wait for
 *               the backend:port-updated broadcast, then reload).
 * - 'failure' → a dialog-relevant startup failure was captured; show recovery UI.
 * - 'app'     → backend is up; mount the real application.
 */
export function resolveBootGateState(
  backendPort: number,
  failure: BackendStartupFailureInfo | null | undefined
): BootGateState {
  if (isBackendStartupFailureDialogRelevant(failure)) {
    return 'failure';
  }
  if (!backendPort || backendPort <= 0) {
    return 'splash';
  }
  return 'app';
}
