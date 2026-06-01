import { useState } from 'react'
import {
  Button, Checkbox, Radio, Switch, Segmented, Field, Input, Select, FilterBar,
  Pill, Chip, Table, StatGrid, Modal, Drawer, Tooltip,
  SparkLine, Bars, StackedBars, MultiLine,
} from '../ui'

export default function DevKit() {
  const [drawer, setDrawer] = useState(false)
  const [modal, setModal] = useState(false)
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('a')

  return (
    <div className="p-8 space-y-8 max-w-4xl">
      <h1 className="font-serif text-4xl">UI Kit</h1>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Buttons</h2>
        <div className="flex gap-2">
          <Button>Default</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Form controls</h2>
        <div className="flex gap-4 items-center">
          <Checkbox label="勾选" />
          <Radio name="r" label="Radio A" />
          <Radio name="r" label="Radio B" defaultChecked />
          <Switch label="开关" />
        </div>
        <Segmented<'a' | 'b' | 'c'> options={[{value:'a',label:'A'},{value:'b',label:'B'},{value:'c',label:'C'}]} value={seg} onChange={setSeg} />
        <div className="grid grid-cols-2 gap-3 max-w-lg">
          <Field label="Input"><Input placeholder="hello" /></Field>
          <Field label="Select"><Select defaultValue="1"><option value="1">One</option><option value="2">Two</option></Select></Field>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Pill / Chip</h2>
        <div className="flex gap-2">
          <Pill tone="ok">ok</Pill>
          <Pill tone="warn">warn</Pill>
          <Pill tone="err">err</Pill>
          <Pill tone="info">info</Pill>
          <Pill tone="mute">mute</Pill>
          <Chip>chip</Chip>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">StatGrid</h2>
        <StatGrid items={[
          { label: '账号', value: '12' },
          { label: 'QPS', value: '38.4' },
          { label: '可用', value: '98.7%', tone: 'ok' },
          { label: '错误', value: '0.3%', tone: 'err' },
        ]} />
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Charts</h2>
        <SparkLine points={[1,3,2,5,4,7,6,9]} />
        <Bars points={[2,4,6,3,5,8,7,9]} color="var(--info)" />
        <StackedBars
          labels={['Mo','Tu','We','Th','Fr','Sa','Su']}
          series={[
            { label: 'opus',   color: 'var(--ink)',    values: [5,7,8,6,9,4,10] },
            { label: 'sonnet', color: 'var(--info)',   values: [3,4,6,5,7,3,6] },
            { label: 'haiku',  color: 'var(--ink-3)',  values: [2,1,3,2,2,1,2] },
          ]}
        />
        <MultiLine series={[
          { label: 'p50', color: 'var(--ok)',     points: [100,110,90,120,115,108] },
          { label: 'p99', color: 'var(--accent)', points: [220,300,250,340,400,310] },
        ]} />
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Overlays</h2>
        <Button onClick={() => setDrawer(true)}>Open Drawer</Button>
        <Button onClick={() => setModal(true)}>Open Modal</Button>
        <Tooltip content="hello tip"><Button variant="ghost">hover me</Button></Tooltip>
        <Drawer open={drawer} title="Drawer" onClose={() => setDrawer(false)}>Drawer body.</Drawer>
        <Modal  open={modal}  title="Modal"  onClose={() => setModal(false)}>Modal body.</Modal>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Table</h2>
        <FilterBar>
          <Input placeholder="搜索..." />
          <Button variant="primary">查询</Button>
        </FilterBar>
        <div className="bg-white border border-[var(--rule)]">
          <Table
            rows={[{id:1,name:'a',v:10},{id:2,name:'b',v:20}]}
            columns={[
              { key: 'name', header: 'Name', render: r => r.name },
              { key: 'v',    header: 'Value', render: r => <span className="font-mono">{r.v}</span> },
            ]}
          />
        </div>
      </section>
    </div>
  )
}
