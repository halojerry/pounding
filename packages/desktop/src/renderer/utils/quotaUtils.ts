const QUOTA_PER_RMB = 73259; // 1 CNY ≈ 73259 积分

// ---- Balance -----------------------------------------------------------

export interface QuotaBalance {
  remainQuota: number;
  usedQuota: number;
  totalQuota: number;
  remainWan: number;
  remainRmb: number;
  remainPct: number;
  isLow: boolean;
  isUnlimited: boolean;
}

export function calcBalance(remainQuota: number, usedQuota: number): QuotaBalance {
  const total = remainQuota + usedQuota;
  const remainPct = total > 0 ? (remainQuota / total) * 100 : 100;
  const remainRmb = remainQuota / QUOTA_PER_RMB;
  const remainWan = remainQuota / 10000;
  const isLow = remainPct < 10;

  return {
    remainQuota,
    usedQuota,
    totalQuota: total,
    remainWan,
    remainRmb,
    remainPct,
    isLow,
    isUnlimited: total === 0,
  };
}

// ---- Subscription -----------------------------------------------------

export interface QuotaSubscription {
  dailyTotal: number;
  dailyUsed: number;
  dailyRemain: number;
  dailyPct: number;
  totalTotal: number;
  totalRemain: number;
  totalPct: number;
  nextReset: number;
  isDaily: boolean;
  isTotal: boolean;
}

export function calcSubscription(
  sub: { amount_total: number; amount_used: number; next_reset_time?: number },
  plan: { total_amount: number },
  totalUsedQuota: number
): QuotaSubscription {
  const dailyTotal = sub.amount_total;
  const dailyUsed = sub.amount_used;
  const dailyRemain = dailyTotal - dailyUsed;
  const dailyPct = dailyTotal > 0 ? (dailyRemain / dailyTotal) * 100 : 0;

  const totalTotal = plan.total_amount;
  const totalRemain = totalTotal - totalUsedQuota;
  const totalPct = totalTotal > 0 ? (totalRemain / totalTotal) * 100 : 0;

  return {
    dailyTotal,
    dailyUsed,
    dailyRemain,
    dailyPct,
    totalTotal,
    totalRemain,
    totalPct,
    nextReset: sub.next_reset_time ?? 0,
    isDaily: dailyPct < 10,
    isTotal: totalPct < 10,
  };
}

// ---- Formatting helpers ------------------------------------------------

export function formatRmb(n: number): string {
  if (n >= 10000) return '¥' + (n / 10000).toFixed(1) + '万';
  return '¥' + n.toFixed(0);
}

export function formatWan(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
  return n.toLocaleString();
}
