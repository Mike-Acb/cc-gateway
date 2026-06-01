// Requires DATABASE_URL; not run in local dev
import { strict as assert } from 'assert'
import { query } from '../server/src/db.js'
import {
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  getDefaultGroupId,
  setAccountGroup,
  setClientGroup,
} from '../server/src/services/groups.js'

async function main() {
  // default group exists
  const defId = await getDefaultGroupId()
  assert.ok(defId, 'default group must exist')

  // create
  const g = await createGroup({
    name: 'test-g-' + Date.now(),
    description: 'x',
  })
  assert.equal(g.is_default, false)

  // update
  const g2 = await updateGroup(g.id, { description: 'y' })
  assert.equal(g2.description, 'y')

  // list
  const all = await listGroups()
  assert.ok(all.find((x) => x.id === g.id))
  assert.ok(all[0].is_default === true, 'default group should sort first')

  // touching setAccountGroup / setClientGroup should not blow up on no-op
  // (we don't have a real account/client id here; just verify the functions are importable)
  assert.equal(typeof setAccountGroup, 'function')
  assert.equal(typeof setClientGroup, 'function')

  // refuse delete default
  await assert.rejects(deleteGroup(defId), /default/)

  // delete non-default OK
  await deleteGroup(g.id)
  const after = await listGroups()
  assert.equal(after.find((x) => x.id === g.id), undefined)

  console.log('OK')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
