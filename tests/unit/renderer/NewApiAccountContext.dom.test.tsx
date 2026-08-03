/**
 * @license
 * Copyright 2025 POUNDING (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import { NewApiAccountProvider, useNewApiAccount } from '@/renderer/hooks/context/NewApiAccountContext';

vi.mock('@/common/adapter/ipcBridge', () => ({
  newApiAccount: {
    getStatus: { invoke: vi.fn() },
    refreshStatus: { invoke: vi.fn() },
    login: { invoke: vi.fn() },
    logout: { invoke: vi.fn() },
  },
  managedCliInstaller: {
    install: { invoke: vi.fn() },
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    setLocal: vi.fn(),
  },
}));

const STATUS = {
  loggedIn: false,
  baseUrl: 'https://api.mxou.cn',
  models: [],
  updatedAt: 0,
};

const LoginProbe: React.FC = () => {
  const { login } = useNewApiAccount();
  return (
    <button type='button' onClick={() => void login({ username: 'user', password: 'pass' })}>
      do-login
    </button>
  );
};

describe('NewApiAccountContext — CLI 自助安装（手动触发，登录不自动安装）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipcBridge.newApiAccount.getStatus.invoke).mockResolvedValue({
      success: true,
      data: STATUS,
    });
  });

  it('login 成功后不会自动调用 managedCliInstaller.install', async () => {
    vi.mocked(ipcBridge.newApiAccount.login.invoke).mockResolvedValue({
      success: true,
      data: { status: { ...STATUS, loggedIn: true } },
    });

    render(
      <NewApiAccountProvider>
        <LoginProbe />
      </NewApiAccountProvider>
    );

    await userEvent.click(screen.getByText('do-login'));

    await waitFor(() => expect(ipcBridge.newApiAccount.login.invoke).toHaveBeenCalledTimes(1));
    expect(ipcBridge.managedCliInstaller.install.invoke).not.toHaveBeenCalled();
  });
});
