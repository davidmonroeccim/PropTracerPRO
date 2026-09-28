#!/usr/bin/env python3
"""Phase 0 sample selector. READ-ONLY against the property registry. MPS is not used (spec D17).

Refuses to run until tasks/research-test/phase0/gate-a.json holds an explicit answer from David to EVERY
GATE A question (there are no defaults), and refuses any county that is not in the registry inventory, is
in IN or FL, or was already tested.

Then, before touching a county, it counts other non-idle sessions in pg_stat_activity and STOPS if
there is any (the registry is a 4GB box: one workstream at a time). It prints the count only, never
another session's SQL. Per county, one at a time:
  1. ONE scan of the county returning flags only, no names or addresses: the FULL count of city,
     ZIP, owner, APN and numeric-address fill per property type (the shortlist's figures were a
     storage-order sample and are not reliable);
  2. seeded random pools per property type (the six, or every type if GATE A question 8 is (b)), and
     for G1 per city / no-city; G2 trusts need an APN and a numeric address unless question 9 is (b);
  3. the pooled rows fetched by parcel_uid = any(...), scoped on county_fips. Never a range scan
     or LIKE on parcel_uid (collation returns another county's rows).
Writes county-counts.json (counts only) and candidates.json (names and addresses, gitignored).

Run: python3 tasks/research-scripts/phase0/select_samples.py
Exit 5: a county scan passed statement_timeout (STOP, ask David).
"""
import csv, json, os, random, re, sys, time
import psycopg2, psycopg2.extras

sys.path.insert(0, '/Users/davidmonroe/property-registry/worker/scripts')
import audit_city_key_is_postal as A  # env() only

OUT = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0'
INVENTORY = '/Users/davidmonroe/property-registry/docs/registry-inventory/county-searchable-coverage.csv'
TYPES = ['residential', 'commercial', 'industrial', 'multifamily', 'land', 'mixed_use']
STREET_FORMATS = ('first_comma', 'whole', 'strip_city')
EXCLUDED_STATES = {'IN', 'FL'}
# Every county with a parcel in tasks/research-test/ (L-023: a parcel that already passed is spent evidence).
TESTED = {('AL', 'MOBILE'), ('CA', 'CONTRA COSTA'), ('CA', 'NAPA'), ('CA', 'PLACER'), ('CA', 'SACRAMENTO'),
          ('OH', 'ALLEN'), ('OH', 'BUTLER'), ('OH', 'CLARK'), ('OH', 'CUYAHOGA'), ('OH', 'MEDINA'),
          ('OH', 'MONTGOMERY'), ('OH', 'RICHLAND'), ('OH', 'STARK'),
          ('UT', 'CARBON'), ('UT', 'DAVIS'), ('UT', 'IRON'), ('UT', 'SALT LAKE')}
POOL = 20        # random candidates per stratum: G1 (property type, city or not), G3 (property type)
TRUST_POOL = 10  # G1 counties: random trust-marked candidates per property type (feeds G2)
NUMERIC_RE = r'^\s*[0-9]'
# Mirrors TRUST_MARKER in lib/routing/ownerRoute.ts:158 (LIVING TRUST and FAMILY TRUST contain TRUST).
# A pre-filter only: build-sample.ts decides with the production classifyOwnerName.
TRUST_RE = r'\m(TRUST|TTEE|TRUSTEE|TRS|ESTATE OF)\M'

FLAGS_SQL = """
select parcel_uid,
       coalesce(property_type, '(null)'),
       nullif(btrim(situs_city), '') is not null,
       nullif(btrim(situs_zip), '') is not null,
       nullif(btrim(owner_name), '') is not null,
       nullif(btrim(parcel_id_local), '') is not null,
       coalesce(site_address ~ %s, false),
       coalesce(owner_name ~* %s, false)
  from public.{part}
 where county_fips = %s
"""
ROWS_SQL = """
select parcel_uid, owner_name, site_address, situs_city, situs_zip, parcel_id_local,
       coalesce(property_type, '(null)') as property_type
  from public.{part}
 where county_fips = %s and parcel_uid = any(%s)
"""
# A COUNT only: other sessions' SQL can carry owner names or addresses, so it is never read or printed.
BUSY_SQL = """
select count(*)
  from pg_stat_activity
 where state <> 'idle' and pid <> pg_backend_pid() and datname = 'postgres'
"""


def die(code, msg):
    print(msg, flush=True)
    sys.exit(code)


def load_gate():
    path = f'{OUT}/gate-a.json'
    if not os.path.exists(path):
        die(2, f'REFUSING: {path} does not exist. GATE A: David names the counties first; there is no default.')
    g = json.load(open(path))
    if g.get('records_per_county') not in (4, 8):
        die(2, 'REFUSING: gate-a.json records_per_county must be 4 or 8')
    if not g.get('g1_counties') or not g.get('g3_counties'):
        die(2, 'REFUSING: gate-a.json needs g1_counties and g3_counties (questions 1 and 2)')
    if any(c.get('name_order') not in ('LAST FIRST', 'FIRST LAST', 'unclear') for c in g['g1_counties']):
        die(2, 'REFUSING: every G1 county needs name_order from tasks/phase0-county-shortlist.md')
    cap = g.get('name_order_addon_cap')
    if cap != 'all' and not (type(cap) is int and cap >= 0):
        die(2, 'REFUSING: gate-a.json name_order_addon_cap must be 0, a whole number, or "all" (question 4)')
    n = g.get('g1_no_city_per_county')
    # The brief requires no-city parcels wherever a county has them, so 0 is not an answer.
    if type(n) is not int or not 1 <= n <= g['records_per_county']:
        die(2, 'REFUSING: gate-a.json g1_no_city_per_county must be a whole number from 1 to records_per_county (question 5)')
    if g.get('street_format') not in STREET_FORMATS:
        die(2, 'REFUSING: gate-a.json street_format must be first_comma, whole or strip_city (question 6)')
    for k, q in (('g3_trust_ladder', 7), ('extra_property_types', 8), ('g2_trusts_without_apn', 9), ('stop_after_three_failures', 11)):
        if type(g.get(k)) is not bool:
            die(2, f'REFUSING: gate-a.json {k} must be true or false (question {q})')
    if g.get('g2_estate_of') not in ('include', 'exclude'):
        die(2, 'REFUSING: gate-a.json g2_estate_of must be include or exclude (question 10)')
    if not all(str(g.get(k) or '').strip() for k in ('answered_by', 'answered_at', 'david_words')):
        die(2, 'REFUSING: gate-a.json needs answered_by, answered_at and david_words')
    return g


def inventory():
    with open(INVENTORY, newline='') as f:
        return {(r['state'], r['county_fips']): r for r in csv.DictReader(f)}


def bare(name):
    return re.sub(r'\s+(County|Parish|Borough|Municipality)$', '', name.strip(), flags=re.I)


def check_county(c, inv):
    st, fips, county = c['state'], c['fips'], c['county']
    row = inv.get((st, fips))
    if row is None:
        die(2, f'REFUSING: {st} {fips} is not in the registry inventory ({INVENTORY})')
    if bare(row['county_name']).upper() != county.strip().upper():
        die(2, f'REFUSING: {st} {fips} is "{row["county_name"]}" in the inventory; gate-a.json must name it '
               f'"{bare(row["county_name"])}" (bare, as Tracerfy wants it), not "{county}"')
    if st in EXCLUDED_STATES:
        die(2, f'REFUSING: {st} is excluded from Phase 0 (David, 2026-09-21)')
    if (st, county.strip().upper()) in TESTED:
        die(2, f'REFUSING: {st} {county} was already tested (tasks/research-test/)')
    return int(row['parcels'])


def registry():
    e = A.env()
    c = psycopg2.connect(host=f"db.{e['PROJECT_REF']}.supabase.co", port=5432, dbname='postgres',
                         user='postgres', password=e['SUPABASE_DB_PASSWORD'], connect_timeout=60,
                         sslmode='require')
    c.set_session(readonly=True, autocommit=True)
    cur = c.cursor()
    cur.execute("set default_transaction_read_only = on")
    cur.execute("set statement_timeout = '300s'")
    return c


def stop_if_busy(cur, where):
    cur.execute(BUSY_SQL)
    busy = cur.fetchone()[0]
    if busy:
        die(3, f'STOP ({where}): {busy} other non-idle session(s) on the registry. Ask David; do not wait them out.')


def pct(n, d):
    return f'{100.0 * n / d:.1f}%' if d else 'n/a'


def main():
    gate = load_gate()
    inv = inventory()
    jobs = [('G1', c) for c in gate['g1_counties']] + [('G3', c) for c in gate['g3_counties']]
    expected = {(g, c['fips']): check_county(c, inv) for g, c in jobs}
    os.makedirs(OUT, exist_ok=True)
    conn = registry()
    cur = conn.cursor()
    counts_out, cands = [], {'g1': [], 'g2': [], 'g3': []}
    for grp, c in jobs:
        st, fips, county = c['state'], c['fips'], c['county']
        part = f'parcels_{st.lower()}'
        stop_if_busy(cur, f'before {st} {county}')

        # 1. One scan, flags only: the full count and the strata.
        try:
            cur.execute(FLAGS_SQL.format(part=part), (NUMERIC_RE, TRUST_RE, fips))
        except psycopg2.errors.QueryCanceled:
            die(5, f'STOP: the {st} {fips} {county} scan passed statement_timeout. Ask David.')
        flags = cur.fetchall()
        if not flags:
            die(4, f'STOP: {st} {fips} {county} returned 0 parcels; the inventory says {expected[(grp, fips)]}. Ask David.')
        by_type, strata, trust_strata = {}, {}, {}
        for uid, ptype, has_city, has_zip, has_owner, has_apn, numeric, trust in flags:
            t = by_type.setdefault(ptype, dict(parcels=0, no_city=0, no_zip=0, no_owner=0, with_apn=0, numeric_address=0,
                                              g1_eligible_city=0, g1_eligible_no_city=0, trust_marked=0,
                                              trust_marked_eligible=0, g3_eligible=0))
            t['parcels'] += 1
            t['no_city'] += not has_city
            t['no_zip'] += not has_zip
            t['no_owner'] += not has_owner
            t['with_apn'] += has_apn
            t['numeric_address'] += numeric
            g1_ok = has_owner and has_apn and numeric
            g2_ok = has_owner and trust and (g1_ok or gate['g2_trusts_without_apn'])
            g3_ok = (not has_owner) and (has_apn or (numeric and has_city))
            if g1_ok:
                t['g1_eligible_city' if has_city else 'g1_eligible_no_city'] += 1
                t['trust_marked_eligible'] += trust
            t['trust_marked'] += has_owner and trust
            t['g3_eligible'] += g3_ok
            if ptype not in TYPES and not gate['extra_property_types']:
                continue
            if grp == 'G1' and g2_ok:
                trust_strata.setdefault(ptype, []).append(uid)
            elif grp == 'G1' and g1_ok:
                strata.setdefault((ptype, has_city), []).append(uid)
            if grp == 'G3' and g3_ok:
                # By type only: city and no-city parcels in their natural proportion.
                strata.setdefault((ptype, 'any'), []).append(uid)
        total = {k: sum(t[k] for t in by_type.values()) for k in next(iter(by_type.values()))}
        counts_out.append(dict(group=grp, state=st, fips=fips, county=county,
                               inventory_parcels=expected[(grp, fips)], totals=total, by_type=by_type))

        # 2. Seeded random pools. The seed names the stratum, so a re-run picks the same parcels.
        g1_pick, g2_pick = [], []
        for key in sorted(strata):
            uids = sorted(strata[key])
            g1_pick += random.Random(f'phase0-{grp}-{fips}-{key[0]}-{key[1]}').sample(uids, min(POOL, len(uids)))
        for ptype in sorted(trust_strata):
            uids = sorted(trust_strata[ptype])
            g2_pick += random.Random(f'phase0-G2-{fips}-{ptype}').sample(uids, min(TRUST_POOL, len(uids)))

        # 3. Rows for the pooled uids only.
        rows = []
        if g1_pick or g2_pick:
            rc = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            rc.execute(ROWS_SQL.format(part=part), (fips, g1_pick + g2_pick))
            rows = [dict(r) for r in rc.fetchall()]
        in_g2 = set(g2_pick)
        for r in rows:
            r.update(state=st, fips=fips, county=county)
            if grp == 'G3':
                cands['g3'].append(r)
            else:
                cands['g2' if r['parcel_uid'] in in_g2 else 'g1'].append(r)

        n = total['parcels']
        print(f"{grp} {st} {fips} {county}: parcels {n:,} (inventory {expected[(grp, fips)]:,}); "
              f"no city {total['no_city']:,} ({pct(total['no_city'], n)}); no ZIP {pct(total['no_zip'], n)}; "
              f"no owner {total['no_owner']:,} ({pct(total['no_owner'], n)}); APN {pct(total['with_apn'], n)}; "
              f"numeric address {pct(total['numeric_address'], n)}", flush=True)
        print(f"   eligible G1 with city {total['g1_eligible_city']:,}, G1 no city {total['g1_eligible_no_city']:,}, "
              f"trust-marked {total['trust_marked']:,} ({total['trust_marked_eligible']:,} with APN and address), "
              f"G3 (no owner) {total['g3_eligible']:,}; "
              f"pooled {len(rows)}", flush=True)
        print('   by type: ' + ' | '.join(f"{p} {t['parcels']:,} (no city {pct(t['no_city'], t['parcels'])}, "
                                          f"no owner {pct(t['no_owner'], t['parcels'])})"
                                          for p, t in sorted(by_type.items())), flush=True)
        time.sleep(2)

    json.dump(counts_out, open(f'{OUT}/county-counts.json', 'w'), indent=1)
    json.dump(cands, open(f'{OUT}/candidates.json', 'w'), indent=1, default=str)
    print(f"candidates: g1 {len(cands['g1'])}, g2 {len(cands['g2'])}, g3 {len(cands['g3'])}")


if __name__ == '__main__':
    main()
