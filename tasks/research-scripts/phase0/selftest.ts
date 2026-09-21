// Run: npx tsx tasks/research-scripts/phase0/selftest.ts
import assert from 'node:assert/strict'
import { personMatchesOwner, stripTrustWords } from './match'
import { affordable } from './guard'

// Name order. splitPersonName reads "LAST FIRST MI" correctly only with a trailing initial.
assert.equal(personMatchesOwner({ first_name: 'John', last_name: 'Smith' }, 'John Smith'), 'natural')
assert.equal(personMatchesOwner({ first_name: 'Marcus', last_name: 'Halloway' }, 'Halloway Marcus T'), 'natural')
assert.equal(personMatchesOwner({ first_name: 'John', last_name: 'Smith' }, 'Smith John'), 'swapped')
assert.equal(personMatchesOwner({ first_name: 'Jingwen', last_name: 'Wu' }, 'Jingwen & Shaolan Wu'), 'natural')
assert.equal(personMatchesOwner({ first_name: 'John', last_name: 'Smith' }, 'John Smith Jr'), 'natural')
// Refusals: the persons[0] fallback is exactly what this prototype must NOT do.
assert.equal(personMatchesOwner({ first_name: 'Mary', last_name: 'Jones' }, 'John Smith'), null)
assert.equal(personMatchesOwner({ first_name: 'Mary', last_name: 'Smith' }, 'John Smith'), null)
assert.equal(personMatchesOwner({ first_name: 'John', last_name: '' }, 'John Smith'), null)
// Trusts.
assert.equal(stripTrustWords('John Smith Revocable Trust U/A Dated Jan 5 2001'), 'JOHN SMITH')
assert.equal(stripTrustWords('The Halloway Living Trust'), 'HALLOWAY')
assert.equal(stripTrustWords('Smith Family Trust'), 'SMITH')
assert.equal(stripTrustWords('Martin Family Trust'), 'MARTIN')
assert.equal(stripTrustWords('Robert May Revocable Trust'), 'ROBERT MAY')
assert.equal(stripTrustWords('Decker Living Trust Dtd May 5 2001'), 'DECKER')
assert.equal(personMatchesOwner({ first_name: 'Ann', last_name: 'Smith' }, stripTrustWords('Smith Family Trust')), 'surname_only')
// Spend guard: the cap is inclusive and never exceeded.
assert.equal(affordable(14.8, 0.2, 15), true)
assert.equal(affordable(14.9, 0.2, 15), false)
assert.equal(affordable(0, 0.3, 0.2), false)
console.log('phase0 selftest OK')
