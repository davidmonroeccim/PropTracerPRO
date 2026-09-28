# Owner-name parsing fixes, 2026-09-28

From the commercial coverage test (`tasks/commercial-coverage-test-2026-09-28.md`): 4 of 5 Arm C
owner names were mangled before the request left PTP. David's correction: **all five county strings
are LAST FIRST (assessor order)**; the parser only detects that when a trailing middle initial
happens to be present.

## The constraint that shapes every fix

`ownerNamesFrom` (executeRoute.ts:685) builds dossier names as
`[first_name, last_name].join(' ')` -> **natural order**. Dossier-derived names are the path that
produced all three tier-2 successes today. **So the default must NOT flip to assessor order.**
Widen detection instead.

## Tasks

- [x] 1. `splitOwners` splits on `;` as well as `|`. NC Buncombe published
      `BECK JAMES R;BECK HELEN` and we sent first=BECK last=HELEN, then Tracerfy returned 2 real
      people and we discarded them (`name_not_matched`, $0.10 billed).
- [x] 2. Strip trailing punctuation from name tokens, so `BOTT, RUSSELL L` stops sending the
      surname as `BOTT,`.
- [x] 3. A comma after the first token is an explicit `LAST, FIRST` signal, independent of whether
      a middle initial follows.
- [x] 4. A surname repeated as the leading token of every multi-owner part is the shared surname
      (`BECK JAMES R;BECK HELEN` -> BECK).
- [x] 5. `classifyOwnerName('VALLEY GENERAL CONTRACTING')` returns `entity`, not `individual`.
- [x] 6. Mutation-test every fix: delete the guard, watch the test go red (L-036).

## NOT fixed here, needs David: `GRAY WAYNE`

Two tokens, no comma, no initial, no repetition. **No string-intrinsic signal distinguishes it from
`Gerald Pentland`**, which the existing suite pins as natural order
(`ownerRoute.test.ts:64`). Options, none of them free:
  (a) carry provenance on ParcelInput (`ownerNameOrder: 'natural' | 'assessor'`) and have the
      registry/gateway path mark county-sourced names assessor-ordered;
  (b) retry the swapped order on a name miss -- but NC Buncombe shows `name_not_matched` still
      billed $0.10 and 5 credits, so a retry is NOT free the way a dossier key miss is;
  (c) accept it.

## Review

All five fixed in `lib/routing/ownerRoute.ts`. The five REAL Arm C owner strings now parse:

| county owner of record | before | after |
|---|---|---|
| `BECK JAMES R;BECK HELEN` | first BECK / last HELEN | **first JAMES / last BECK** |
| `VALLEY GENERAL CONTRACTING` | individual | **entity** -> FastAppend, not the person lookup |
| `BOTT, RUSSELL L` | last `BOTT,` | **last BOTT** |
| `WHITE ROBERT B & MARILYN J` | ROBERT / WHITE | unchanged, still correct (it hit) |
| `GRAY WAYNE` | GRAY / WAYNE | **unchanged, see below** |

**Gates, measured:** vitest **2240 passed / 89 files / 0 failed** (2229 before, +11), tsc **exit 0**,
eslint **45 problems, the floor, unmoved**, `next build` **exit 0**.

**MUTATION TESTING CHANGED THE WORK, which is the point of doing it (L-036).** The first pass
reported all guards fenced. It was wrong twice:
- deleting the **shared-surname** branch left all tests GREEN, because `BECK JAMES R;BECK HELEN`
  carries a trailing initial and rule 6 already handles it;
- deleting **stripEdgePunct** left all tests GREEN, because the comma branch slices the comma off
  before any token is read.
Both were real code doing nothing my tests could see. Rather than delete them I found the inputs
only they satisfy and pinned those: `BECK JAMES;BECK HELEN` (no initial anywhere, so only the
repeated leading token identifies the surname) and `RUSSELL BOTT,` (a trailing comma with no
comma-split to remove it). Two further mutations had not applied at all because their anchors did
not match, so their GREEN meant nothing either.

Re-run, all five go RED: M1 ';' separator 3 failed, M2 comma branch 2 failed, M3 shared surname
1 failed, M4 edge punctuation 1 failed, M5 entity widening 1 failed.

**STILL OPEN AND IT IS DAVID'S CALL: `GRAY WAYNE`.** Two tokens, no comma, no initial, no
repetition. It is character-for-character the same shape as `Gerald Pentland`, which the suite has
pinned as natural order since before today (`ownerRoute.test.ts:64`). No parser can separate them
from the string alone, so this needs provenance (the caller saying "this name came from a county
roll") or a swapped-order retry, and the retry is NOT free: NC Buncombe's `name_not_matched` still
billed $0.10 and 5 credits.
