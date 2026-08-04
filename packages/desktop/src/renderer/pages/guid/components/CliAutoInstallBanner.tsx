/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Spin } from '@arco-design/web-react';
import type { CliOnDemandInstallState } from '@/renderer/hooks/cli/useCliOnDemandInstall';

type CliAutoInstallBannerProps = Pick<CliOnDemandInstallState, 'status' | 'error' | 'target'> & {
  onCancel: () => void;
  onRetry: () => void;
};

/**
 * Inline banner shown while a CLI runtime auto-installs on demand (the user
 * selected an assistant whose runtime is missing). Cancelable; on failure it
 * offers retry. After success the banner switches to a "ready" state and the
 * agent catalogs refresh, so the assistant becomes usable immediately.
 */
const CliAutoInstallBanner: React.FC<CliAutoInstallBannerProps> = ({ status, error, target, onCancel, onRetry }) => {
  const { t } = useTranslation();
  if (!target || status === 'idle') return null;

  const title =
    status === 'done'
      ? t('settings.runtimeEnvironment.autoInstallDone', { defaultValue: 'Runtime environment ready' })
      : status === 'error'
        ? t('settings.runtimeEnvironment.autoInstallFailed', { defaultValue: 'Failed to install runtime' })
        : t('settings.runtimeEnvironment.autoInstallTitle', { defaultValue: 'Installing runtime environment…' });

  return (
    <div
      data-testid='cli-auto-install-banner'
      className='mx-auto mb-10px flex w-full max-w-800px items-center justify-between gap-12px rounded-12px border border-solid border-warning-6/30 bg-warning-6/10 px-14px py-10px'
    >
      <div className='flex min-w-0 items-center gap-10px'>
        {status === 'installing' ? <Spin size={16} /> : null}
        <div className='min-w-0'>
          <p className='m-0 truncate text-13px font-600 text-t-primary'>{title}</p>
          <p className='m-0 truncate text-12px text-t-secondary'>
            {status === 'error' && error
              ? error
              : t('settings.runtimeEnvironment.autoInstallDesc', {
                  cli: target,
                  defaultValue: `First use of this assistant requires the ${target} runtime.`,
                })}
          </p>
        </div>
      </div>
      <div className='flex shrink-0 items-center gap-8px'>
        {status === 'error' ? (
          <Button size='mini' type='primary' onClick={onRetry}>
            {t('common.retry', { defaultValue: 'Retry' })}
          </Button>
        ) : null}
        <Button size='mini' type='text' onClick={onCancel}>
          {t('common.cancel', { defaultValue: 'Cancel' })}
        </Button>
      </div>
    </div>
  );
};

export default CliAutoInstallBanner;
