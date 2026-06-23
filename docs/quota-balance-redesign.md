# Quota Balance Redesign (June 2026)

## Problem

旧余额卡片未使用 `used_quota` 字段，进度条总是 100%，且不支持订阅模式。

## Solution

三层重构：

### Data Layer — `calcBalance()` / `calcSubscription()`

`packages/desktop/src/renderer/utils/quotaUtils.ts`

纯函数，输入 API 返回的原始数字，输出组件需要的衍生值：

```ts
calcBalance(remainQuota, usedQuota);
// → { remainRmb, remainPct, isLow, isUnlimited, ... }

calcSubscription(sub, plan, totalUsedQuota);
// → { dailyTotal, dailyRemain, dailyPct, totalPct, ... }
```

### UI Layer — BalanceCard / SubscriptionCard

| Component          | File                                           | When               |
| ------------------ | ---------------------------------------------- | ------------------ |
| `BalanceCard`      | `components/layout/Sider/BalanceCard.tsx`      | 普通用户（无订阅） |
| `SubscriptionCard` | `components/layout/Sider/SubscriptionCard.tsx` | 订阅用户           |

**BalanceCard 三种状态**：

```
正常 (>10%):    余额 ¥1060.4万  [充值]    绿色进度条
低余额 (<10%):  余额 ¥3.2万    [充值]    红色进度条
无限制:         无限制           [充值]    全宽进度条
```

**SubscriptionCard 双进度条**：

```
今日进度：今日 ¥6.8万  73%  (6px 高度)
总额进度：总额 ¥68万   00:00 重置 (4px 高度)
```

### Data Flow

```
/api/user/self          → quota, used_quota → calcBalance()  → BalanceCard
/api/user/subscription/self → sub + plan    → calcSubscription() → SubscriptionCard
                                            (fallback to BalanceCard)
```

Subscription fetch is **non-fatal** — if it fails, balance card still works.

## Files Changed

| File                                                     | Change                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `renderer/utils/quotaUtils.ts`                           | New: calcBalance, calcSubscription, formatRmb, formatWan                   |
| `renderer/components/layout/Sider/BalanceCard.tsx`       | New: balance card component                                                |
| `renderer/components/layout/Sider/SubscriptionCard.tsx`  | New: subscription card component                                           |
| `renderer/components/layout/Sider/SiderFooter.tsx`       | Replace inline balance JSX with BalanceCard/SubscriptionCard               |
| `common/types/newApiAccount.ts`                          | Add `NewApiSubscription` type, `subscription` field on `NewApiDesktopUser` |
| `process/bridge/services/NewApiDesktopAccountService.ts` | Fetch `/api/user/subscription/self` in `refreshStatus()`                   |
