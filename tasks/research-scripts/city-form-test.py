"""City-form test, 2026-10-02. Does the vendor's named lookup find the owner when the city is the
county's MUNICIPAL / TOWNSHIP / PLACE name instead of the USPS mailing city?

David's design: per test address, run the non-mailing name FIRST, then the mailing city as the
validation. No dossier. Both runs WITHOUT ZIP so the city is the only locality signal; a
municipal-name miss whose mailing-city run hits is retried ONCE with the ZIP, to see whether the
ZIP rescues it in production (PTP sends a ZIP whenever it has one).

A pair COUNTS only when the mailing-city run hits. If both miss, the vendor has nothing for that
person at that address, the pair says nothing about city form, and the next candidate in the same
county is tried. Misses cost 0 credits.

Endpoint: POST /v1/api/trace/lookup/, find_owner:false, first_name + last_name -- the named person
lookup PTP uses in production (lib/tracerfy/client.ts:715-727). 5 credits per hit, 0 on miss,
$0.02 per credit (tasks/research-scripts/tracerfy-individual.ts).

Sample: tasks/research-test/city-form-2026-10-02/final_sample.json, built READ-ONLY from the
property registry with the audit's own owner-occupancy test (select_sample.py beside it).
Outputs go to the same gitignored directory: raw responses hold purchased PII.

    python3 city-form-test.py --sandbox                  # mock.tracerfy.com, nothing billed
    python3 city-form-test.py --live --max-dollars 10    # spends; stops before any call that could cross the cap
"""
import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

DIR = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/city-form-2026-10-02'
SAMPLE = f'{DIR}/final_sample.json'
CREDIT_USD = 0.02
HIT_CREDITS = 5
ALLOWED = {'tracerfy.com', 'mock.tracerfy.com'}

args = sys.argv[1:]
sandbox, live = '--sandbox' in args, '--live' in args
if sandbox == live:
    sys.exit('pass exactly one of --sandbox or --live')
if live:
    if '--max-dollars' not in args:
        sys.exit('REFUSING: --live needs --max-dollars')
    cap_credits = int(round(float(args[args.index('--max-dollars') + 1]) / CREDIT_USD))
    key = None
    for line in open('/Users/davidmonroe/PropTracerPRO/.env.local'):
        m = re.match(r'^\s*TRACERFY_API_KEY\s*=\s*"?([^"\n]+)"?\s*$', line)
        if m: key = m.group(1).strip()
    if not key:
        sys.exit('no TRACERFY_API_KEY')
    BASE, OUT = 'https://tracerfy.com', f'{DIR}/live'
else:
    cap_credits, key, BASE, OUT = 10**9, 'sandbox', 'https://mock.tracerfy.com', f'{DIR}/sandbox'
os.makedirs(OUT, exist_ok=True)

spent = 0
n_calls = 0


class Abort(Exception):
    pass


def lookup(tag, cand, city, with_zip):
    """One named lookup. Returns a compact result dict; the raw response is saved verbatim."""
    global spent, n_calls
    if spent + HIT_CREDITS > cap_credits:
        raise Abort(f'cap: spent {spent} credits, next call could cost {HIT_CREDITS}, cap {cap_credits}')
    body = {'address': cand['address'], 'city': city, 'state': cand['state'], 'find_owner': False,
            'first_name': cand['first_name'], 'last_name': cand['last_name']}
    if with_zip:
        body['zip'] = cand['zip']
    url = f'{BASE}/v1/api/trace/lookup/'
    assert urllib.parse.urlparse(url).hostname in ALLOWED
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers={
        'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'Accept': 'application/json',
        # Cloudflare bans the default 'Python-urllib' agent (error 1010); name ourselves instead.
        'User-Agent': 'PropTracerPRO-research/2026-10-02'})
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                status, raw = r.status, json.loads(r.read().decode())
            break
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read().decode(errors='replace')[:800]
            if status == 429 and attempt == 1:
                time.sleep(20); continue
            if status in (401, 402, 403) or status >= 500:
                raise Abort(f'HTTP {status} on {tag}: {text}')
            raw = {'http_error': status, 'body': text}
            break
    n_calls += 1
    one = raw[0] if isinstance(raw, list) else raw
    if isinstance(one, dict) and isinstance(one.get('results'), list) and one['results']:
        one = one['results'][0]
    credits = int(one.get('credits_deducted') or 0) if isinstance(one, dict) else 0
    spent += credits
    persons = one.get('persons') or [] if isinstance(one, dict) else []
    want = cand['last_name'].upper()
    named = [p for p in persons if (p.get('last_name') or '').upper() == want]
    res = dict(tag=tag, city_sent=city, zip_sent=with_zip, http=status if 'http_error' in one else 200,
               hit=bool(one.get('hit')) if isinstance(one, dict) else False, credits=credits,
               persons=len(persons), last_name_match=len(named),
               owner_flag=sum(1 for p in persons if p.get('property_owner')),
               phones=sum(len(p.get('phones') or []) for p in named or persons),
               emails=sum(len(p.get('emails') or []) for p in named or persons),
               vendor_mail_cities=sorted({(p.get('mailing_address') or {}).get('city', '') for p in persons} - {''}))
    with open(f"{OUT}/{cand['state']}-{cand['county_fips']}-{re.sub(r'[^A-Za-z0-9]', '', cand['parcel_uid'])[:16]}-{tag}.json", 'w') as fh:
        json.dump({'request': body, 'response': raw}, fh, indent=1)
    time.sleep(0.4)
    return res


# Sandbox-only override so the miss and abort branches can be exercised with the mock's sentinels.
sample = json.load(open(os.environ['CITY_FORM_SAMPLE'] if sandbox and os.environ.get('CITY_FORM_SAMPLE') else SAMPLE))
rows = []
try:
    for county in sample:
        outcome = None
        for i, cand in enumerate(county['candidates']):
            muni = lookup('A_municipal_nozip', cand, cand['municipal_city'], False)
            postal = lookup('B_postal_nozip', cand, cand['postal_city'], False)
            rescue = None
            if postal['hit'] and not muni['hit']:
                rescue = lookup('C_municipal_zip', cand, cand['municipal_city'], True)
            valid = postal['hit']
            outcome = dict(state=cand['state'], county_fips=cand['county_fips'], candidate_index=i,
                           municipal_city=cand['municipal_city'], postal_city=cand['postal_city'],
                           address=cand['address'], zip=cand['zip'], valid_pair=valid,
                           municipal=muni, postal=postal, municipal_with_zip=rescue)
            rows.append(outcome)
            print(f"{cand['state']} {cand['county_fips']} #{i} {cand['municipal_city']!r:20} A={'HIT ' if muni['hit'] else 'miss'}"
                  f" | {cand['postal_city']!r:18} B={'HIT ' if postal['hit'] else 'miss'}"
                  f"{' | C(zip)=' + ('HIT' if rescue['hit'] else 'miss') if rescue else ''}"
                  f" | spent {spent} cr = ${spent * CREDIT_USD:.2f}", flush=True)
            if valid:
                break
except Abort as e:
    print(f'\nSTOPPED: {e}', flush=True)

valid = [r for r in rows if r['valid_pair']]
summary = dict(
    mode='live' if live else 'sandbox', calls=n_calls, credits=spent, dollars=round(spent * CREDIT_USD, 2),
    counties_attempted=len({(r['state'], r['county_fips']) for r in rows}),
    valid_pairs=len(valid),
    municipal_hit_on_valid=sum(1 for r in valid if r['municipal']['hit']),
    municipal_miss_on_valid=sum(1 for r in valid if not r['municipal']['hit']),
    zip_rescued=sum(1 for r in valid if r['municipal_with_zip'] and r['municipal_with_zip']['hit']),
    invalid_pairs_both_missed=sum(1 for r in rows if not r['valid_pair'] and not r['municipal']['hit']),
    municipal_only_hit=sum(1 for r in rows if not r['valid_pair'] and r['municipal']['hit']),
)
json.dump({'summary': summary, 'rows': rows}, open(f'{OUT}/results.json', 'w'), indent=1)
print('\n' + json.dumps(summary, indent=1))
