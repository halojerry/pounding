/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Message, Modal, Space, Spin, Tag } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import type { CliEnvironmentTarget, CliSource, CliTargetStatus } from '@/common/types/agent/cliEnvironment';
import styles from './RuntimeEnvironmentPanel.module.css';

const TARGETS: CliEnvironmentTarget[] = ['claude', 'hermes', 'openclaw'];

const SOURCE_COLORS: Record<CliSource | 'unknown', string> = {
  managed: 'blue',
  homebrew: 'orange',
  bun: 'magenta',
  nvm: 'green',
  pip: 'cyan',
  system: 'gray',
  unknown: 'gray',
};

function getStatusKind(status: CliTargetStatus): 'available' | 'notInstalled' | 'broken' | 'conflict' {
  if (status.conflict) return 'conflict';
  if (status.installations.length === 0) return 'notInstalled';
  if (status.installations.some((item) => item.runnable)) return 'available';
  return 'broken';
}

const RuntimeEnvironmentPanel: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [statuses, setStatuses] = useState<CliTargetStatus[]>([]);
  const [busyTarget, setBusyTarget] = useState<CliEnvironmentTarget | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await ipcBridge.managedCliInstaller.detectAll.invoke();
      setStatuses(result ?? []);
    } catch {
      Message.error(t('settings.runtimeEnvironment.detectError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runInstall = useCallback(
    async (target: CliEnvironmentTarget) => {
      setBusyTarget(target);
      try {
        const result = await ipcBridge.managedCliInstaller.install.invoke({ target });
        if (!result.success) {
          Message.error(result.message || t('settings.runtimeEnvironment.installFailed'));
        }
        await reload();
      } finally {
        setBusyTarget(null);
      }
    },
    [reload, t]
  );

  const runUninstall = useCallback(
    (target: CliEnvironmentTarget) => {
      Modal.confirm({
        title: t('settings.runtimeEnvironment.uninstallConfirmTitle'),
        content: t('settings.runtimeEnvironment.uninstallConfirmContent', { name: target }),
        onOk: async () => {
          setBusyTarget(target);
          try {
            const result = await ipcBridge.managedCliInstaller.uninstall.invoke(target);
            if (!result.success) {
              Message.error(result.message || t('settings.runtimeEnvironment.uninstallFailed'));
            }
            await reload();
          } finally {
            setBusyTarget(null);
          }
        },
      });
    },
    [reload, t]
  );

  const selectPath = useCallback(
    async (target: CliEnvironmentTarget) => {
      const picks = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openFile', 'openDirectory'],
      });
      if (!picks || picks.length === 0) return;
      await ipcBridge.managedCliInstaller.setCliPath.invoke({ [target]: picks[0] });
      Message.success(t('settings.runtimeEnvironment.selectPathSuccess'));
      await reload();
    },
    [reload, t]
  );

  return (
    <section className={styles.panel} data-testid='runtime-environment-panel'>
      <header className={styles.header}>
        <h3 className={styles.title}>{t('settings.runtimeEnvironment.title')}</h3>
        <p className={styles.description}>{t('settings.runtimeEnvironment.description')}</p>
      </header>

      <Spin loading={loading}>
        <div className={compact ? styles.rowsCompact : styles.rows}>
          {TARGETS.map((target) => {
            const status = statuses.find((item) => item.target === target);
            const first = status?.installations[0];
            const kind = status ? getStatusKind(status) : 'unknown';
            const busy = busyTarget === target;

            return (
              <div className={styles.row} key={target}>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    <span className={styles.targetName}>{target}</span>
                    <Tag color={SOURCE_COLORS[first?.source ?? 'unknown']}>
                      {t(`settings.runtimeEnvironment.source.${first?.source ?? 'unknown'}`)}
                    </Tag>
                    <Tag color={kind === 'available' ? 'green' : kind === 'conflict' ? 'red' : 'gray'}>
                      {t(`settings.runtimeEnvironment.status.${kind}`)}
                    </Tag>
                  </div>
                  <div className={styles.rowMeta}>
                    <span className={styles.path}>
                      {status?.defaultPath || first?.path || t('settings.runtimeEnvironment.notInstalled')}
                    </span>
                    <span className={styles.version}>{first?.version ?? '—'}</span>
                  </div>
                </div>

                <Space className={styles.actions}>
                  {kind === 'notInstalled' || kind === 'unknown' ? (
                    <Button
                      size='small'
                      type='primary'
                      loading={busy}
                      aria-label={`install-${target}`}
                      onClick={() => void runInstall(target)}
                    >
                      {t('settings.runtimeEnvironment.action.install')}
                    </Button>
                  ) : (
                    <>
                      <Button
                        size='small'
                        loading={busy}
                        aria-label={`upgrade-${target}`}
                        onClick={() => void runInstall(target)}
                      >
                        {t('settings.runtimeEnvironment.action.upgrade')}
                      </Button>
                      <Button
                        size='small'
                        status='danger'
                        aria-label={`uninstall-${target}`}
                        onClick={() => runUninstall(target)}
                      >
                        {t('settings.runtimeEnvironment.action.uninstall')}
                      </Button>
                    </>
                  )}
                  <Button size='small' aria-label={`diagnose-${target}`} onClick={() => void reload()}>
                    {t('settings.runtimeEnvironment.action.diagnose')}
                  </Button>
                  <Button size='small' aria-label={`select-path-${target}`} onClick={() => void selectPath(target)}>
                    {t('settings.runtimeEnvironment.action.selectPath')}
                  </Button>
                </Space>
              </div>
            );
          })}
        </div>
      </Spin>
    </section>
  );
};

export default RuntimeEnvironmentPanel;
