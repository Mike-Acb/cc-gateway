import { useState } from 'react'
import { Segmented } from '../../ui'
import PlanTab from './_plans/PlanTab'
import PricingTab from './_plans/PricingTab'
import SubscriptionsTab from './_plans/SubscriptionsTab'

type TabValue = 'plans' | 'pricing' | 'subs'

const TAB_OPTIONS: { value: TabValue; label: string }[] = [
  { value: 'plans', label: '套餐' },
  { value: 'pricing', label: '模型定价' },
  { value: 'subs', label: '订阅' },
]

export default function AdminPlansPage() {
  const [tab, setTab] = useState<TabValue>('plans')

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <header>
        <h1 className="text-[26px] font-serif text-[var(--ink)]">套餐与价格</h1>
        <p className="text-[12px] font-mono text-[var(--ink-3)] mt-1">
          Plans · Model Pricing · Subscriptions
        </p>
      </header>

      <Segmented<TabValue>
        value={tab}
        options={TAB_OPTIONS}
        onChange={setTab}
      />

      {tab === 'plans' && <PlanTab />}
      {tab === 'pricing' && <PricingTab />}
      {tab === 'subs' && <SubscriptionsTab />}
    </div>
  )
}
