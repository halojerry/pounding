import { useCallback, useEffect, useState } from 'react';
import { ipcBridge } from '@/common';

interface DealerConfig {
  aff: string;
}

const REGISTER_BASE_URL = 'https://api.mxou.cn/sign-up';

const isDesktopRuntime = typeof window !== 'undefined' && Boolean(window.electronAPI);

export function useDealerConfig(): {
  dealerConfig: DealerConfig | null;
  loading: boolean;
  openRegisterUrl: () => Promise<void>;
} {
  const [dealerConfig, setDealerConfig] = useState<DealerConfig | null>(null);
  const [loading, setLoading] = useState(isDesktopRuntime);

  useEffect(() => {
    if (!isDesktopRuntime) {
      setLoading(false);
      return;
    }
    console.log('[useDealerConfig] Fetching dealer config...');
    ipcBridge.application.getDealerConfig
      .invoke()
      .then((result: any) => {
        console.log('[useDealerConfig] IPC result:', result);
        if (result.success && result.data) {
          console.log('[useDealerConfig] Setting dealer config:', result.data);
          setDealerConfig(result.data);
        } else {
          console.log('[useDealerConfig] No dealer config data');
        }
      })
      .catch((err: any) => {
        console.error('[useDealerConfig] IPC error:', err);
      })
      .finally(() => setLoading(false));
  }, []);

  const openRegisterUrl = useCallback(async () => {
    const aff = dealerConfig?.aff;
    const url = aff ? `${REGISTER_BASE_URL}?aff=${encodeURIComponent(aff)}` : REGISTER_BASE_URL;
    console.log('[useDealerConfig] Opening register URL:', url);
    console.log('[useDealerConfig] Dealer config:', dealerConfig);
    await ipcBridge.shell.openExternal.invoke(url);
  }, [dealerConfig]);

  return { dealerConfig, loading, openRegisterUrl };
}
