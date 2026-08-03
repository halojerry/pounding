/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RuntimeEnvironmentPanel from '@/renderer/components/settings/RuntimeEnvironmentPanel';
import { ipcBridge } from '@/common';

vi.mock('@/common/adapter/ipcBridge', () => ({
  managedCliInstaller: {
    detectAll: { invoke: vi.fn() },
    install: { invoke: vi.fn() },
    uninstall: { invoke: vi.fn() },
    isInstalled: { invoke: vi.fn() },
  },
  dialog: {
    showOpen: { invoke: vi.fn() },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Modal: {
      confirm: vi.fn((options: { onOk?: () => void | Promise<void> }) => {
        void options.onOk?.();
      }),
    },
  };
});

const detectAllMock = vi.mocked(ipcBridge.managedCliInstaller.detectAll.invoke);
const installMock = vi.mocked(ipcBridge.managedCliInstaller.install.invoke);
const uninstallMock = vi.mocked(ipcBridge.managedCliInstaller.uninstall.invoke);

const THREE_ROWS = [
  {
    target: 'claude',
    installations: [
      {
        binary: 'claude',
        path: '/usr/local/bin/claude',
        version: '2.1.215',
        runnable: true,
        source: 'system',
        isDefault: true,
      },
    ],
    defaultPath: '/usr/local/bin/claude',
    conflict: false,
  },
  {
    target: 'hermes',
    installations: [],
    defaultPath: null,
    conflict: false,
  },
  {
    target: 'openclaw',
    installations: [
      {
        binary: 'openclaw',
        path: '/opt/openclaw/bin/openclaw',
        version: null,
        runnable: false,
        source: 'managed',
        isDefault: false,
      },
    ],
    defaultPath: null,
    conflict: true,
  },
];

describe('RuntimeEnvironmentPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectAllMock.mockResolvedValue(THREE_ROWS as never);
    installMock.mockResolvedValue({ success: true, status: 'installed' } as never);
    uninstallMock.mockResolvedValue({ success: true, status: 'not_installed' } as never);
  });

  it('renders one row per CLI target with status, path and version', async () => {
    render(<RuntimeEnvironmentPanel />);

    await waitFor(() => {
      expect(detectAllMock).toHaveBeenCalled();
    });

    expect(screen.getByText('claude')).toBeTruthy();
    expect(screen.getByText('hermes')).toBeTruthy();
    expect(screen.getByText('openclaw')).toBeTruthy();
    // Installed CLI shows its path and version
    expect(screen.getByText('/usr/local/bin/claude')).toBeTruthy();
    expect(screen.getByText('2.1.215')).toBeTruthy();
    // Not-installed CLI shows an Install action, installed shows Uninstall
    expect(screen.getByRole('button', { name: 'install-hermes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'uninstall-claude' })).toBeTruthy();
  });

  it('calls install.invoke with the target when Install is clicked', async () => {
    const user = userEvent.setup();
    render(<RuntimeEnvironmentPanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'install-hermes' })).toBeTruthy();
    });
    await user.click(screen.getByRole('button', { name: 'install-hermes' }));

    expect(installMock).toHaveBeenCalledWith({ target: 'hermes' });
  });

  it('calls uninstall.invoke with the target when Uninstall is clicked', async () => {
    const user = userEvent.setup();
    render(<RuntimeEnvironmentPanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'uninstall-claude' })).toBeTruthy();
    });
    await user.click(screen.getByRole('button', { name: 'uninstall-claude' }));

    expect(uninstallMock).toHaveBeenCalledWith('claude');
  });
});
