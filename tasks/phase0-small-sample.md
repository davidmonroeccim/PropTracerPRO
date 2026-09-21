# Phase 0 small sample report

Date: 2026-09-21
Approved: $2.00
Spent: $0.90
Tracerfy balance before: 10649, after: 10609

## t1_address_tracerfy (tracerfy_address, NY, Broome, commercial)

- endpoint instant, HTTP 200, hit true, people 1, credits_deducted 5, 1264ms
- name test: natural
- matched person property_owner: false
- matched person phones: 4, emails: 0
- production parser (falls back to persons[0], client.ts:602) phones: 4, emails: 0
- cost: $0.10

Result: works.

## t1_address_fastappend (fastappend, NY, Monroe, commercial)

- endpoint fastappend, HTTP 404, hit false, people n/a, credits_deducted 0, 4299ms
- miss
- people returned: 0
- production parser phones: 0, emails: 0
- cost: free

Result: did not find the owner.

## t1_apn_tracerfy (tracerfy_apn, LA, East Baton Rouge, multifamily)

- endpoint apn, HTTP 200, hit true, people 1, credits_deducted 5, 1004ms
- name test: natural
- matched person property_owner: true
- matched person phones: 9, emails: 2
- production parser (falls back to persons[0], client.ts:602) phones: 8, emails: 2
- cost: $0.10

Result: works.

## t1_apn_fastappend (fastappend, OH, Summit, multifamily)

- endpoint fastappend, HTTP 404, hit false, people n/a, credits_deducted 0, 653ms
- miss
- people returned: 0
- production parser phones: 0, emails: 0
- cost: free

Result: did not find the owner.

## t1_nothing_found (apn_probe, MN, Ramsey, (probe))

- HTTP 200
- body keys: parcel_id, county, state, hit, persons_count, credits_deducted, persons, meta
- hit: false
- credits_deducted: 0
- cost: free

Result: works.

## dossier_commercial (dossier, MD, Wicomico, commercial)

- dossier step hit: DOSSIER_ADDRESS
- ownerFound: true
- ownerType: individual
- exchange: endpoint dossier, HTTP 200, hit false, people n/a, credits_deducted 0, 291ms
- exchange: endpoint dossier, HTTP 200, hit true, people n/a, credits_deducted 10, 1961ms
- exchange: endpoint instant, HTTP 200, hit false, people 0, credits_deducted 0, 20419ms
- second-lookup vendor: tracerfy, outcome: miss
- pass-2 name test against result.ownerName: none
- production-parser contacts phones: 0, emails: 0
- needsManualReview: false
- success: true
- cost: $0.20

Result: did not find the owner.

## dossier_multifamily (dossier, UT, Washington, multifamily)

- dossier step hit: DOSSIER_APN
- ownerFound: true
- ownerType: entity
- exchange: endpoint dossier, HTTP 200, hit true, people n/a, credits_deducted 10, 1443ms
- exchange: endpoint fastappend, HTTP 200, hit true, people 3, credits_deducted 1, 5218ms
- second-lookup vendor: fastappend, outcome: hit
- production-parser contacts phones: 6, emails: 3
- needsManualReview: false
- success: true
- cost: $0.30

Result: works.

## dossier_land (dossier, CA, Shasta, land)

- dossier step hit: DOSSIER_APN
- ownerFound: true
- ownerType: individual
- exchange: endpoint dossier, HTTP 200, hit true, people n/a, credits_deducted 10, 1831ms
- exchange: endpoint apn, HTTP 200, hit false, people 0, credits_deducted 0, 242ms
- second-lookup vendor: tracerfy, outcome: miss
- pass-2 name test against result.ownerName: none
- production-parser contacts phones: 0, emails: 0
- needsManualReview: false
- success: true
- cost: $0.20

Result: did not find the owner.
