import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DOCS = readFileSync(join(process.cwd(), 'app/(dashboard)/settings/api-keys/docs/page.tsx'), 'utf8')

describe('the API docs describe the synchronous single-trace contract (spec D1, D26)', () => {
  it('no longer tells anyone to poll a trace where the owner was supplied', () => {
    // MUTATION: put the old "Response when you supplied the owner (poll for it)" block back and this goes red.
    expect(DOCS).not.toContain('tracerfyJobId')
    expect(DOCS).not.toMatch(/supplied the owner \(poll/i)
    expect(DOCS).not.toContain('Poll for Results')
    expect(DOCS).not.toContain('then poll if you need to')
  })

  it('documents the new fields, the parcel id input and the busy answer', () => {
    for (const s of ['outcomeCode', 'foundBy', 'skipReason', 'busy_try_again', 'no_lookup_key', '"apn"', '"county"', 'Retry-After']) {
      expect(DOCS, s).toContain(s)
    }
    // D32: the dossier's own contacts are never returned, so there is no name_verified label to document.
    expect(DOCS).not.toContain('name_verified')
  })

  it('states the charge rule, the D16 lookup and the busy status truthfully (D31)', () => {
    // MUTATION: delete the 503 row and this goes red. So does putting back "This is the one to retry".
    for (const s of ['You are charged only when at least one phone or email came back', 'Smith Family Trust', 'Service Unavailable', '503']) {
      expect(DOCS, s).toContain(s)
    }
    expect(DOCS).not.toContain('a person matching the owner name came back')
    expect(DOCS).not.toContain('This is the one to retry')
  })

  it('says what a resubmit costs now that the cache is owner-aware (D37)', () => {
    // MUTATION: put the old two sentences back and this goes red.
    expect(DOCS).toContain('with the same owner name')
    expect(DOCS).not.toContain('traced returns your stored result and costs nothing. Polling')
  })
})
