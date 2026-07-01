/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Progress } from '@arco-design/web-react';
import PoundingInteractiveLogo from '@/renderer/components/layout/PoundingInteractiveLogo';
import { ipcBridge } from '@/common';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { ManagedCliInstallTarget } from '@/common/types/agent/managedCliInstaller';
import styles from './index.module.css';

const ALL_TARGETS: ManagedCliInstallTarget[] = ['hermes', 'openclaw', 'claude', 'codex', 'opencode'];

type AgentStatus = { name: string; backend: string | null; available: boolean; reason: string | null };

async function diagnose(): Promise<AgentStatus[]> {
  try {
    const report = await httpRequest<{ agents: AgentStatus[] }>('GET', '/api/doctor/diagnose');
    return report?.agents ?? [];
  } catch {
    return [];
  }
}

async function refreshAgents(): Promise<void> {
  try {
    await httpRequest('POST', '/api/agents/refresh');
  } catch {
    // Non-fatal.
  }
}

const CliPrepPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [percent, setPercent] = useState(0);
  const [showPage, setShowPage] = useState(false);
  const doneRef = useRef(false);

  const runPrep = useCallback(async () => {
    // Phase 1: Install all CLIs sequentially.
    let completed = 0;
    for (const target of ALL_TARGETS) {
      try {
        const alreadyInstalled = await ipcBridge.managedCliInstaller.isInstalled.invoke({ target });
        if (!alreadyInstalled) {
          await ipcBridge.managedCliInstaller.install.invoke({ target });
        }
      } catch (error) {
        console.warn(`[CliPrep] ${target} install failed:`, (error as Error)?.message ?? error);
      }
      completed++;
      setPercent(Math.round((completed / ALL_TARGETS.length) * 80));
    }

    // Phase 2: Refresh agent discovery.
    await refreshAgents();

    // Phase 3: Diagnose and repair.
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const agents = await diagnose();
      const unavailable = agents.filter((a) => !a.available);
      if (unavailable.length === 0) break;

      // Try to repair each unavailable agent.
      for (const agent of unavailable) {
        const target = ALL_TARGETS.find(
          (t) => agent.name.toLowerCase().includes(t) || agent.backend?.toLowerCase() === t
        );
        if (target) {
          try {
            await ipcBridge.managedCliInstaller.install.invoke({ target });
          } catch {
            // Will retry next loop.
          }
        }
      }
      await refreshAgents();
      setPercent(80 + Math.round(((attempt + 1) / MAX_RETRIES) * 20));
    }

    setPercent(100);
    doneRef.current = true;
  }, []);

  // Quick skip: if all CLIs are already installed, skip to /guid immediately.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const results = await Promise.all(
          ALL_TARGETS.map((target) => ipcBridge.managedCliInstaller.isInstalled.invoke({ target }))
        );
        if (cancelled) return;
        if (results.every(Boolean)) {
          navigate('/guid', { replace: true });
          return;
        }
      } catch {
        // Fall through to show the prep page.
      }
      if (!cancelled) {
        setShowPage(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  // Start the full prep flow once the page is shown.
  useEffect(() => {
    if (!showPage) return;
    runPrep();
  }, [showPage, runPrep]);

  // Navigate to /guid when done.
  useEffect(() => {
    if (doneRef.current) {
      navigate('/guid', { replace: true });
    }
  }, [percent, navigate]);

  // Don't render anything during the quick skip check to avoid flicker.
  if (!showPage) {
    return null;
  }

  return (
    <div className={styles.container}>
      <div className={styles.logo}>
        <PoundingInteractiveLogo className={styles.logoInner} />
      </div>
      <p className={styles.text}>{t('cli.prepOffice')}</p>
      <div className={styles.progress}>
        <Progress percent={percent} showText={false} />
      </div>
    </div>
  );
};

export default CliPrepPage;
