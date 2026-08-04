/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { ManagedCliInstallTarget } from '@/common/types/agent/managedCliInstaller';
import { DETECTED_AGENTS_SWR_KEY, MANAGED_AGENTS_SWR_KEY } from '@/renderer/utils/model/agentTypes';
import { mutate as mutateSWR } from 'swr';

/**
 * Map an assistant runtime key (agent.acp_backend || agent.type) to a
 * POUNDING-managed CLI target. Only the CLIs POUNDING can install are
 * eligible for on-demand auto-install.
 */
export function runtimeKeyToCliTarget(runtimeKey: string | null | undefined): ManagedCliInstallTarget | null {
  if (!runtimeKey) return null;
  if (runtimeKey === 'claude') return 'claude';
  if (runtimeKey === 'hermes') return 'hermes';
  if (runtimeKey === 'openclaw') return 'openclaw';
  return null;
}

export type CliOnDemandInstallState = {
  target: ManagedCliInstallTarget | null;
  status: 'idle' | 'installing' | 'done' | 'error';
  error?: string;
  /** Start (or restart) an install for the given CLI. */
  requestInstall: (target: ManagedCliInstallTarget) => void;
  /** Dismiss the banner / stop auto-installing. In-flight install continues. */
  cancel: () => void;
  /** Retry a failed install. */
  retry: () => void;
};

/**
 * On-demand CLI auto-install for "assistant needs a runtime that is not
 * installed" — used from the assistant picker / conversation entry. The user
 * picking an assistant is treated as intent to use it, so the required CLI
 * installs automatically with a visible, cancelable progress banner.
 */
export function useCliOnDemandInstall(): CliOnDemandInstallState {
  const [target, setTarget] = useState<ManagedCliInstallTarget | null>(null);
  const [status, setStatus] = useState<CliOnDemandInstallState['status']>('idle');
  const [error, setError] = useState<string>();
  const inFlightRef = useRef(false);

  const start = useCallback(async (cliTarget: ManagedCliInstallTarget) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setTarget(cliTarget);
    setStatus('installing');
    setError(undefined);
    try {
      const result = await ipcBridge.managedCliInstaller.install.invoke({ target: cliTarget });
      if (result.success) {
        setStatus('done');
        // Refresh agent catalogs so the assistant becomes available right away.
        void mutateSWR(DETECTED_AGENTS_SWR_KEY);
        void mutateSWR(MANAGED_AGENTS_SWR_KEY);
      } else {
        setStatus('error');
        setError(result.message || 'install failed');
      }
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const requestInstall = useCallback(
    (cliTarget: ManagedCliInstallTarget) => {
      void start(cliTarget);
    },
    [start]
  );

  const cancel = useCallback(() => {
    setTarget(null);
    setStatus('idle');
    setError(undefined);
  }, []);

  const retry = useCallback(() => {
    if (target) void start(target);
  }, [target, start]);

  return { target, status, error, requestInstall, cancel, retry };
}
