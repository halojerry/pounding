/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  resolveBootGateState,
  isBackendStartupFailureDialogRelevant,
  type BootGateState,
} from '@/renderer/services/bootGate';
import type { BackendStartupFailureInfo } from '@/common/types/platform/electron';

const RELEVANT_REASONS = [
  'backend_incompatible_runtime',
  'backend_incomplete_installation',
  'backend_package_architecture_mismatch',
  'backend_data_migration_failed',
  'backend_local_data_repair_failed',
  'backend_recoverable_database_corruption',
  'backend_transient_concurrent_startup',
  'backend_startup_failed',
] as const;

describe('resolveBootGateState', () => {
  it('shows the splash while the backend port is not yet available', () => {
    expect(resolveBootGateState(0, undefined)).toBe<BootGateState>('splash');
  });

  it('mounts the app once the backend port is available', () => {
    expect(resolveBootGateState(13400, undefined)).toBe<BootGateState>('app');
  });

  it('shows the failure dialog when a relevant startup failure is present, even with a port', () => {
    const failure: BackendStartupFailureInfo = { reason: 'backend_incompatible_runtime' };
    expect(resolveBootGateState(0, failure)).toBe<BootGateState>('failure');
    expect(resolveBootGateState(13400, failure)).toBe<BootGateState>('failure');
  });

  it('mounts the app when the failure reason is not dialog-relevant', () => {
    const failure: BackendStartupFailureInfo = { reason: 'some_unknown_reason' };
    expect(resolveBootGateState(13400, failure)).toBe<BootGateState>('app');
  });
});

describe('isBackendStartupFailureDialogRelevant', () => {
  it('classifies every existing dialog reason as relevant', () => {
    for (const reason of RELEVANT_REASONS) {
      expect(isBackendStartupFailureDialogRelevant({ reason } as BackendStartupFailureInfo)).toBe(true);
    }
  });

  it('treats unknown reasons and null as not relevant', () => {
    expect(isBackendStartupFailureDialogRelevant({ reason: 'backend_unknown' } as BackendStartupFailureInfo)).toBe(
      false
    );
    expect(isBackendStartupFailureDialogRelevant(null)).toBe(false);
  });
});
