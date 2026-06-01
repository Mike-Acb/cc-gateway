import { createHash } from 'crypto'
import { log } from './logger.js'

// ── Types ──

export type SessionSlot = {
  derivedId: string
  lastUsed: number
  boundKeys: Set<string>
  boundClients: Map<string, string> // stickyKey -> clientName
  reuseCount: number
  createdAt: number
}

export type AccountSessionTable = {
  slots: SessionSlot[]
  keyToSlot: Map<string, number>
}

export type SlotEvent = {
  accountId: string
  slotIndex: number
  action: 'created' | 'bound' | 'evicted'
  clientName: string
  evictedClient?: string
  idleDurationMs?: number
  reuseNumber?: number
  derivedSessionId?: string
}

// ── State ──

const tables = new Map<string, AccountSessionTable>()
const listeners: Array<(event: SlotEvent) => void> = []

// ── Public API ──

export function onSlotEvent(listener: (event: SlotEvent) => void): void {
  listeners.push(listener)
}

function emit(event: SlotEvent) {
  for (const fn of listeners) {
    try { fn(event) } catch (e) { log('error', 'slot event listener error', { error: String(e) }) }
  }
}

export function deriveSessionId(accountId: string, stickyKey: string): string {
  const hex = createHash('sha256').update(`${accountId}:${stickyKey}`).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-')
}

export function getOrAssignSession(
  accountId: string,
  stickyKey: string,
  clientName: string,
  maxSessions: number,
): string {
  // bypass mode
  if (maxSessions === 0) {
    return deriveSessionId(accountId, stickyKey)
  }

  let table = tables.get(accountId)
  if (!table) {
    table = { slots: [], keyToSlot: new Map() }
    tables.set(accountId, table)
  }

  // Dynamic max reduction: trim excess LRU slots if maxSessions was reduced
  while (table.slots.length > maxSessions) {
    // find LRU among all slots
    let lruIdx = 0
    for (let i = 1; i < table.slots.length; i++) {
      if (table.slots[i].lastUsed < table.slots[lruIdx].lastUsed) lruIdx = i
    }
    const evicted = table.slots[lruIdx]
    // clean up keyToSlot for evicted slot's keys
    for (const key of evicted.boundKeys) {
      table.keyToSlot.delete(key)
    }
    table.slots.splice(lruIdx, 1)
    // reindex keyToSlot after splice
    reindex(table)
  }

  // Check existing mapping
  if (table.keyToSlot.has(stickyKey)) {
    const idx = table.keyToSlot.get(stickyKey)!
    const slot = table.slots[idx]
    slot.lastUsed = Date.now()
    return slot.derivedId
  }

  // Same client on same account: keep one stable outbound session id instead of
  // letting one logical client fan out into multiple upstream sessions.
  const existingClientSlotIdx = findSlotIndexByClient(table, clientName)
  if (existingClientSlotIdx !== -1) {
    const slot = table.slots[existingClientSlotIdx]
    for (const key of slot.boundKeys) {
      table.keyToSlot.delete(key)
    }
    slot.boundKeys.clear()
    slot.boundClients.clear()
    slot.boundKeys.add(stickyKey)
    slot.boundClients.set(stickyKey, clientName)
    slot.lastUsed = Date.now()
    table.keyToSlot.set(stickyKey, existingClientSlotIdx)
    emit({ accountId, slotIndex: existingClientSlotIdx, action: 'bound', clientName, derivedSessionId: slot.derivedId })
    return slot.derivedId
  }

  // Free slot available
  if (table.slots.length < maxSessions) {
    const derivedId = deriveSessionId(accountId, stickyKey)
    const now = Date.now()
    const slotIndex = table.slots.length
    const slot: SessionSlot = {
      derivedId,
      lastUsed: now,
      boundKeys: new Set([stickyKey]),
      boundClients: new Map([[stickyKey, clientName]]),
      reuseCount: 0,
      createdAt: now,
    }
    table.slots.push(slot)
    table.keyToSlot.set(stickyKey, slotIndex)
    emit({ accountId, slotIndex, action: 'created', clientName, derivedSessionId: derivedId })
    return derivedId
  }

  // All slots full → LRU eviction
  let lruIdx = 0
  for (let i = 1; i < table.slots.length; i++) {
    if (table.slots[i].lastUsed < table.slots[lruIdx].lastUsed) lruIdx = i
  }
  const slot = table.slots[lruIdx]
  const idleDurationMs = Date.now() - slot.lastUsed
  const evictedClient = slot.boundClients.values().next().value as string | undefined

  // Clear old bindings
  for (const key of slot.boundKeys) {
    table.keyToSlot.delete(key)
  }
  slot.boundKeys.clear()
  slot.boundClients.clear()

  // Rebind with a fresh derived session id for the new sticky key.
  slot.derivedId = deriveSessionId(accountId, stickyKey)
  slot.boundKeys.add(stickyKey)
  slot.boundClients.set(stickyKey, clientName)
  slot.reuseCount++
  slot.lastUsed = Date.now()
  table.keyToSlot.set(stickyKey, lruIdx)

  emit({ accountId, slotIndex: lruIdx, action: 'evicted', clientName, evictedClient, idleDurationMs, reuseNumber: slot.reuseCount })
  emit({ accountId, slotIndex: lruIdx, action: 'bound', clientName, derivedSessionId: slot.derivedId })

  return slot.derivedId
}

function findSlotIndexByClient(table: AccountSessionTable, clientName: string): number {
  for (let i = 0; i < table.slots.length; i++) {
    if ([...table.slots[i].boundClients.values()].includes(clientName)) {
      return i
    }
  }
  return -1
}


function reindex(table: AccountSessionTable) {
  table.keyToSlot.clear()
  for (let i = 0; i < table.slots.length; i++) {
    for (const key of table.slots[i].boundKeys) {
      table.keyToSlot.set(key, i)
    }
  }
}

export function getSessionTable(accountId: string): AccountSessionTable | undefined {
  return tables.get(accountId)
}

export function getAllSessionTables(): Map<string, AccountSessionTable> {
  return tables
}

export function resetSessionTables(): void {
  tables.clear()
}

export function hydrateFromRows(rows: Array<{
  account_id: string
  sticky_key: string
  client_name: string
  derived_id: string
  last_used: number
  reuse_count: number
  created_at: number
}>): void {
  tables.clear()
  for (const row of rows) {
    let table = tables.get(row.account_id)
    if (!table) {
      table = { slots: [], keyToSlot: new Map() }
      tables.set(row.account_id, table)
    }

    // Check if a slot with this derivedId already exists
    let slotIdx = table.slots.findIndex(s => s.derivedId === row.derived_id)
    if (slotIdx === -1) {
      slotIdx = table.slots.length
      table.slots.push({
        derivedId: row.derived_id,
        lastUsed: row.last_used,
        boundKeys: new Set([row.sticky_key]),
        boundClients: new Map([[row.sticky_key, row.client_name]]),
        reuseCount: row.reuse_count,
        createdAt: row.created_at,
      })
    } else {
      const slot = table.slots[slotIdx]
      slot.boundKeys.add(row.sticky_key)
      slot.boundClients.set(row.sticky_key, row.client_name)
      if (row.last_used > slot.lastUsed) slot.lastUsed = row.last_used
    }
    table.keyToSlot.set(row.sticky_key, slotIdx)
  }
}
