import { Button } from '@arco-design/web-react';
import React from 'react';
import type { QuotaSubscription } from '@renderer/utils/quotaUtils';
import { formatRmb } from '@renderer/utils/quotaUtils';

const QUOTA_PER_RMB = 73259;

interface SubscriptionCardProps {
  sub: QuotaSubscription;
  onRecharge?: () => void;
}

const SubscriptionCard: React.FC<SubscriptionCardProps> = ({ sub, onRecharge }) => {
  const nextReset = new Date(sub.nextReset * 1000);

  return (
    <div>
      {/* 标题 + 充值 */}
      <div className='flex items-center justify-between mb-10px'>
        <span className='text-16px font-bold text-t-primary'>订阅卡</span>
        <Button size='mini' type='primary' onClick={onRecharge}>
          充值
        </Button>
      </div>

      {/* 今日进度 */}
      <div className='mb-12px'>
        <div className='flex justify-between text-13px mb-4px'>
          <span className='font-medium'>
            今日 {formatRmb(sub.dailyRemain / QUOTA_PER_RMB)}
          </span>
          <span className={sub.isDaily ? 'text-[rgb(var(--danger-5))]' : 'text-t-secondary'}>
            {sub.dailyPct.toFixed(1)}%
          </span>
        </div>
        <div className='h-6px rd-999px bg-fill-2 overflow-hidden'>
          <div
            className='h-full transition-all duration-500'
            style={{
              width: `${sub.dailyPct.toFixed(1)}%`,
              background: sub.isDaily
                ? 'rgb(var(--danger-5))'
                : 'rgb(var(--primary-6))',
            }}
          />
        </div>
      </div>

      {/* 总额进度 + 重置时间 */}
      <div>
        <div className='flex justify-between text-12px text-t-secondary mb-4px'>
          <span>总额 {formatRmb(sub.totalRemain / QUOTA_PER_RMB)}</span>
          <span>
            {nextReset.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 重置
          </span>
        </div>
        <div className='h-4px rd-999px bg-fill-2 overflow-hidden'>
          <div
            className='h-full transition-all duration-500'
            style={{
              width: `${sub.totalPct.toFixed(1)}%`,
              background: 'rgb(var(--text-3))',
            }}
          />
        </div>
      </div>
    </div>
  );
};

export default SubscriptionCard;
