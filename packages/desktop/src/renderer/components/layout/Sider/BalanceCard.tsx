import { Button } from '@arco-design/web-react';
import React from 'react';
import { calcBalance } from '@renderer/utils/quotaUtils';

interface BalanceCardProps {
  remainQuota: number;
  usedQuota: number;
  onRecharge?: () => void;
}

const BalanceCard: React.FC<BalanceCardProps> = ({ remainQuota, usedQuota, onRecharge }) => {
  const bal = calcBalance(remainQuota, usedQuota);

  if (bal.isUnlimited) {
    return (
      <div>
        <div className='flex items-center justify-between mb-10px'>
          <span className='text-16px font-bold text-t-primary'>无限制</span>
          <Button size='mini' type='primary' onClick={onRecharge}>
            充值
          </Button>
        </div>
        <div className='h-8px rd-999px bg-fill-2 overflow-hidden'>
          <div className='h-full bg-[rgb(var(--primary-6))]' style={{ width: '100%' }} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className='flex items-center justify-between mb-10px'>
        <span className='text-16px font-bold text-t-primary'>
          余额{' '}
          {bal.remainRmb >= 10000 ? '¥' + (bal.remainRmb / 10000).toFixed(1) + '万' : '¥' + bal.remainRmb.toFixed(0)}
        </span>
        <Button size='mini' type='primary' onClick={onRecharge}>
          充值
        </Button>
      </div>

      <div className='h-8px rd-999px bg-fill-2 overflow-hidden'>
        <div
          className='h-full transition-all duration-500'
          style={{
            width: `${bal.remainPct.toFixed(1)}%`,
            background: bal.isLow ? 'rgb(var(--danger-5))' : 'rgb(var(--primary-6))',
          }}
        />
      </div>

      <div className='mt-8px flex justify-between text-12px text-t-secondary'>
        <span>积分 {bal.remainWan >= 1 ? bal.remainWan.toFixed(1) + ' 万' : bal.remainQuota.toLocaleString()}</span>
        <span>剩余 {bal.remainPct.toFixed(1)}%</span>
      </div>
    </div>
  );
};

export default BalanceCard;
