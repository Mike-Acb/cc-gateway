import { strict as assert } from 'assert'
import { normalizeCacheControlTtlOrder } from '../src/cc-disguise.js'

// ── 全 5m,啥都不动 ──
{
  const body = {
    system: [{ type:'text', text:'s', cache_control:{ type:'ephemeral' } }],
    messages: [{ role:'user', content:[{ type:'text', text:'x', cache_control:{ type:'ephemeral' } }] }],
  }
  const n = normalizeCacheControlTtlOrder(body)
  assert.equal(n, 0)
  assert.equal(body.system[0].cache_control.ttl, undefined)
  assert.equal(body.messages[0].content[0].cache_control.ttl, undefined)
  console.log('✓ all 5m: no-op')
}

// ── 全 1h,啥都不动 ──
{
  const body = {
    system: [{ type:'text', cache_control:{ ttl:'1h' } }],
    messages: [{ role:'user', content:[{ type:'text', cache_control:{ ttl:'1h' } }] }],
  }
  const n = normalizeCacheControlTtlOrder(body)
  assert.equal(n, 0)
  console.log('✓ all 1h: no-op')
}

// ── 1h 在前 5m 在后(合规),不动 ──
{
  const body = {
    system: [
      { type:'text', cache_control:{ ttl:'1h' } },
      { type:'text', cache_control:{ type:'ephemeral' } },
    ],
  }
  const n = normalizeCacheControlTtlOrder(body)
  assert.equal(n, 0)
  console.log('✓ 1h then 5m (already valid): no-op')
}

// ── 实战案例:gwbk ccg-mp4twdvx
//     template[scope:'global', default-ephemeral] + messages[ttl:'1h']
//     scope:'global' 不带显式 ttl='1h' → 按 5m 处理
//     所以两个 system 都要升级 ──
{
  const body = {
    tools: [{ name:'X' }],
    system: [
      { type:'text', text:'billing' },  // 无 cc
      { type:'text', text:'cc-prompt' },  // 无 cc
      { type:'text', text:'template-1', cache_control:{ type:'ephemeral', scope:'global' } },  // 5m (无 ttl)
      { type:'text', text:'template-2', cache_control:{ type:'ephemeral' } },                  // 5m
    ],
    messages: [{
      role:'user',
      content: [
        { type:'text', text:'msg', cache_control:{ ttl:'1h', type:'ephemeral' } },              // 1h
      ],
    }],
  }
  const n = normalizeCacheControlTtlOrder(body)
  assert.equal(n, 2, 'both system 5m → 1h promotion')
  assert.equal(body.system[2].cache_control.scope, 'global', 'system[2] keeps scope')
  assert.equal(body.system[2].cache_control.ttl, '1h', 'system[2] 5m promoted to 1h')
  assert.equal(body.system[3].cache_control.ttl, '1h', 'system[3] 5m promoted to 1h')
  assert.equal(body.messages[0].content[0].cache_control.ttl, '1h', 'msg unchanged')
  console.log('✓ promotes ALL 5m before last 1h (scope:global counts as 5m)')
}

// ── scope:'global' 是 cache 共享维度,不影响 ttl(实测 gwbk ccg-mp4we9vn) ──
// {scope:'global'} 没有显式 ttl='1h' 时仍按 5m 处理。
{
  const body = {
    system: [
      { type:'text', cache_control:{ scope:'global' } },              // 5m
      { type:'text', cache_control:{ ttl:'1h' } },                    // 1h
    ],
  }
  const n = normalizeCacheControlTtlOrder(body)
  assert.equal(n, 1, 'scope:global treated as 5m → must be promoted')
  assert.equal(body.system[0].cache_control.ttl, '1h')
  assert.equal(body.system[0].cache_control.scope, 'global', 'scope preserved')
  console.log('✓ scope:global without ttl=1h is treated as 5m, gets promoted')
}

// ── tools 1h → system 5m → messages 1h(三段都参与排序) ──
{
  const body = {
    tools: [{ name:'X', cache_control:{ ttl:'1h' } }],
    system: [{ type:'text', cache_control:{} }],   // 5m
    messages: [{ role:'user', content:[{ type:'text', cache_control:{ ttl:'1h' } }] }],
  }
  const n = normalizeCacheControlTtlOrder(body)
  assert.equal(n, 1)
  assert.equal(body.system[0].cache_control.ttl, '1h')
  console.log('✓ tool 1h + system 5m + msg 1h → system promoted')
}

// ── 无 cache_control 完全空 body ──
{
  assert.equal(normalizeCacheControlTtlOrder({}), 0)
  assert.equal(normalizeCacheControlTtlOrder(null), 0)
  assert.equal(normalizeCacheControlTtlOrder({ messages: [] }), 0)
  console.log('✓ empty / null body safe')
}

// ── 末尾 1h 的位置之后还有更多 5m,只升级前面的 5m ──
{
  const body = {
    system: [
      { type:'text', cache_control:{} },                  // [0] 5m
      { type:'text', cache_control:{ ttl:'1h' } },        // [1] 1h
      { type:'text', cache_control:{} },                  // [2] 5m  ← 本来允许,1h 后续可以接 5m
    ],
  }
  const n = normalizeCacheControlTtlOrder(body)
  assert.equal(n, 1)
  assert.equal(body.system[0].cache_control.ttl, '1h')   // 升级
  assert.equal(body.system[1].cache_control.ttl, '1h')   // 不动
  assert.equal(body.system[2].cache_control.ttl, undefined) // 不动(在最后一个 1h 之后)
  console.log('✓ only promotes 5m blocks before last 1h')
}

console.log('\n✅ cache-control-ttl-order tests passed')
