/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { AcpModelInfo } from '@/common/types/platform/acpTypes';
import { useAcpModelInfo } from '@/renderer/hooks/agent/useAcpModelInfo';

const {
  getModelInvokeMock,
  setModelInvokeMock,
  configServiceSetMock,
  fetchDetectedAgentsMock,
  responseStreamHandlers,
} = vi.hoisted(() => ({
  getModelInvokeMock: vi.fn(),
  setModelInvokeMock: vi.fn(),
  configServiceSetMock: vi.fn(),
  fetchDetectedAgentsMock: vi.fn(),
  responseStreamHandlers: [] as Array<(message: IResponseMessage) => void>,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      getModel: { invoke: getModelInvokeMock },
      setModel: { invoke: setModelInvokeMock },
      responseStream: {
        on: vi.fn().mockImplementation((handler: (message: IResponseMessage) => void) => {
          responseStreamHandlers.push(handler);
          return () => {
            const index = responseStreamHandlers.indexOf(handler);
            if (index >= 0) responseStreamHandlers.splice(index, 1);
          };
        }),
      },
    },
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: vi.fn().mockReturnValue({}),
    set: configServiceSetMock,
  },
}));

vi.mock('@/renderer/utils/model/agentTypes', () => ({
  DETECTED_AGENTS_SWR_KEY: 'detected-agents',
  fetchDetectedAgents: fetchDetectedAgentsMock,
}));

const buildModelInfo = (currentModelId = 'sonnet-4'): AcpModelInfo => ({
  current_model_id: currentModelId,
  current_model_label: currentModelId === 'sonnet-4' ? 'Claude Sonnet 4' : 'Claude Opus 4',
  available_models: [
    { id: 'sonnet-4', label: 'Claude Sonnet 4' },
    { id: 'opus-4', label: 'Claude Opus 4' },
  ],
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const emitStream = (message: IResponseMessage) => {
  for (const handler of responseStreamHandlers) {
    handler(message);
  }
};

const createSwrWrapper = () => {
  const cache = new Map();

  return function SwrTestWrapper({ children }: PropsWithChildren) {
    return createElement(
      SWRConfig,
      {
        value: {
          provider: () => cache,
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        },
      },
      children
    );
  };
};

const renderUseAcpModelInfo = (params: Parameters<typeof useAcpModelInfo>[0]) =>
  renderHook(() => useAcpModelInfo(params), { wrapper: createSwrWrapper() });

describe('useAcpModelInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responseStreamHandlers.length = 0;
    getModelInvokeMock.mockReset();
    setModelInvokeMock.mockReset();
    configServiceSetMock.mockReset();
    getModelInvokeMock.mockResolvedValue({ model_info: buildModelInfo() });
    setModelInvokeMock.mockResolvedValue({ model_info: buildModelInfo('opus-4') });
    configServiceSetMock.mockResolvedValue(undefined);
    fetchDetectedAgentsMock.mockResolvedValue([]);
  });

  it('derives model info from the dedicated model endpoint', async () => {
    getModelInvokeMock.mockResolvedValue({
      model_info: buildModelInfo('opus-4'),
    });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('opus-4');
    });
    expect(result.current.model_info?.available_models.map((model) => model.id)).toEqual(['sonnet-4', 'opus-4']);
    expect(result.current.canSwitch).toBe(true);
  });

  it('selects model via setModel and saves preference', async () => {
    const onSelectModelSuccess = vi.fn();
    const onSelectModelFailed = vi.fn();

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
      onSelectModelSuccess,
      onSelectModelFailed,
    });

    await waitFor(() => {
      expect(result.current.canSwitch).toBe(true);
    });

    act(() => {
      result.current.selectModel('opus-4');
    });

    await waitFor(() => {
      expect(setModelInvokeMock).toHaveBeenCalledWith({
        conversation_id: 'conv-1',
        model_id: 'opus-4',
      });
      expect(result.current.model_info?.current_model_id).toBe('opus-4');
    });

    expect(onSelectModelSuccess).toHaveBeenCalledWith('opus-4');
    expect(onSelectModelFailed).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(configServiceSetMock).toHaveBeenCalledWith('acp.config', { claude: { preferredModelId: 'opus-4' } });
    });
  });

  it('reports failure when setModel returns null model_info', async () => {
    const onSelectModelSuccess = vi.fn();
    const onSelectModelFailed = vi.fn();
    setModelInvokeMock.mockResolvedValue({ model_info: null });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
      onSelectModelSuccess,
      onSelectModelFailed,
    });

    await waitFor(() => {
      expect(result.current.canSwitch).toBe(true);
    });

    act(() => {
      result.current.selectModel('opus-4');
    });

    await waitFor(() => {
      expect(onSelectModelFailed).toHaveBeenCalledWith('opus-4', expect.any(Error));
    });
    expect(result.current.model_info?.current_model_id).toBe('sonnet-4');
    expect(onSelectModelSuccess).not.toHaveBeenCalled();
    expect(configServiceSetMock).not.toHaveBeenCalled();
  });

  it('shares observed model snapshots across hook instances for the same conversation', async () => {
    const wrapper = createSwrWrapper();
    const first = renderHook(
      () => useAcpModelInfo({ conversation_id: 'conv-1', backend: 'claude', initialModelId: 'sonnet-4' }),
      { wrapper }
    );
    const second = renderHook(
      () => useAcpModelInfo({ conversation_id: 'conv-1', backend: 'claude', initialModelId: 'sonnet-4' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(first.result.current.canSwitch).toBe(true);
      expect(second.result.current.canSwitch).toBe(true);
    });

    act(() => {
      first.result.current.selectModel('opus-4');
    });

    await waitFor(() => {
      expect(first.result.current.model_info?.current_model_id).toBe('opus-4');
      expect(second.result.current.model_info?.current_model_id).toBe('opus-4');
    });
  });

  it('uses legacy acp_model_info stream when model endpoint returns null', async () => {
    getModelInvokeMock.mockResolvedValue({ model_info: null });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
    });

    await waitFor(() => {
      expect(responseStreamHandlers.length).toBeGreaterThan(0);
    });

    act(() => {
      emitStream({
        type: 'acp_model_info',
        conversation_id: 'conv-1',
        data: buildModelInfo('opus-4'),
      } as unknown as IResponseMessage);
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('opus-4');
    });
    expect(result.current.canSwitch).toBe(false);
  });
});
