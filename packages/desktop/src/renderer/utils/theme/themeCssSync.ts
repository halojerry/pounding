import type { Theme } from '@/common/theme/types';

export interface CssSyncDecision {
  shouldSync: boolean;
  reason?: string;
}

export function computeCssSyncDecision(_theme: Theme | null): CssSyncDecision {
  return { shouldSync: false };
}

export function resolveCssByActiveTheme(_theme: Theme | null): string {
  return '';
}
