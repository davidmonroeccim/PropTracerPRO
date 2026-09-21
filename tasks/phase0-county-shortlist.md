# Phase 0 county shortlist (2026-09-21)

Counts only. Built for David to pick from. Stage 1 filtered `property-registry/docs/registry-inventory/county-searchable-coverage.csv`
(1,854 counties): not IN or FL; not a primary-metro core county; not a county already tested in tasks/research-test/
(AL Mobile; CA Contra Costa, Napa, Placer, Sacramento; OH Allen, Butler, Clark, Cuyahoga, Medina, Montgomery, Richland, Stark;
UT Carbon, Davis, Iron, Salt Lake); 30k to 350k parcels; owner >= 95%; property type >= 95%; site address >= 80%;
parcel_uid OK. That left 179 counties in 33 states; the 2 largest per state are below (53), plus 4 break-risk counties
added OUTSIDE the filter (UT Washington, UT Cache, LA Jefferson, NY Broome).

**Stage 2 is a 3,000-row sample per county in STORAGE ORDER, not random.** It is biased: Onondaga samples at 100% no city
where the full count is 49% (89,754 of 181,909). City, ZIP and owner percentages here are indicative only; the counties David
picks get FULL counts before sampling. Property type columns are % of the 3,000 rows.

Name order (the A3 / D18 measurement) reads individual-looking owner names (entity words excluded by regex): LFM = "SMITH JOHN T"
(LAST FIRST MI), FML = "JOHN T SMITH", comma = "SMITH, JOHN". Today `splitPersonName` reads a two-word name as FIRST LAST and
does not strip a comma.

| State | County | no city % | no ZIP % | no owner % | com | ind | MF | land | mixed | Name order | LFM | FML | comma | 2-word / indiv |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AK | Anchorage Municipality | 100 | 100 | 0 | 3 | 1 | 8 | 8 | 0 | LAST FIRST | 516 | 1 | 0 | 325 / 2334 |
| AL | Jefferson County | 68 | 67 | 30 | 4 | 1 | 2 | 64 | 0 | LAST FIRST | 153 | 5 | 8 | 172 / 1143 |
| AR | Pulaski County | 100 | 100 | 0 | 2 | 0 | 0 | 19 | 0 | LAST FIRST | 407 | 10 | 0 | 595 / 2250 |
| AR | Benton County | 100 | 100 | 0 | 6 | 0 | 0 | 13 | 0 | LAST FIRST | 278 | 12 | 1930 | 327 / 1972 |
| AZ | Pinal County | 100 | 96 | 11 | 1 | 1 | 0 | 68 | 0 | LAST FIRST | 141 | 3 | 1 | 184 / 830 |
| CA | Ventura County | 100 | 100 | 0 | 5 | 4 | 1 | 3 | 0 | LAST FIRST | 352 | 57 | 0 | 440 / 1322 |
| CA | Santa Cruz County | 73 | 75 | 0 | 0 | 0 | 0 | 63 | 0 | LAST FIRST | 433 | 7 | 0 | 402 / 2293 |
| CO | Arapahoe County | 100 | 100 | 26 | 0 | 0 | 0 | 7 | 0 | LAST FIRST | 287 | 2 | 426 | 544 / 1581 |
| CO | Adams County | 100 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | LAST FIRST | 429 | 4 | 0 | 292 / 2408 |
| CT | New Haven County | 100 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | LAST FIRST | 1032 | 2 | 0 | 1113 / 2838 |
| DE | New Castle County | 100 | 100 | 0 | 6 | 0 | 2 | 0 | 0 | LAST FIRST | 619 | 3 | 6 | 452 / 2388 |
| DE | Kent County | 100 | 100 | 0 | 4 | 2 | 2 | 13 | 1 | LAST FIRST | 1132 | 17 | 17 | 556 / 2274 |
| HI | Honolulu County | 100 | 100 | 0 | 5 | 1 | 0 | 1 | 0 | LAST FIRST | 149 | 194 | 1412 | 993 / 1571 |
| ID | Kootenai County | 100 | 100 | 0 | 2 | 0 | 0 | 23 | 0 | LAST FIRST | 943 | 2 | 1808 | 683 / 1864 |
| ID | Twin Falls County | 100 | 100 | 0 | 2 | 0 | 0 | 35 | 0 | LAST FIRST | 851 | 13 | 2214 | 695 / 2364 |
| IL | Lake County | 0 | 0 | 0 | 2 | 0 | 0 | 32 | 0 | LAST FIRST | 167 | 339 | 775 | 516 / 2383 |
| IL | Kane County | 0 | 0 | 0 | 3 | 3 | 0 | 5 | 0 | LAST FIRST | 291 | 2 | 2205 | 328 / 2255 |
| KY | Jefferson County | 100 | 100 | 0 | 3 | 0 | 0 | 5 | 0 | LAST FIRST | 760 | 12 | 0 | 589 / 2440 |
| LA | East Baton Rouge Parish | 100 | 100 | 1 | 7 | 1 | 15 | 19 | 0 | LAST FIRST | 381 | 1 | 1834 | 449 / 1857 |
| MA | Worcester County | 100 | 100 | 0 | 3 | 1 | 9 | 7 | 0 | LAST FIRST | 801 | 28 | 966 | 593 / 2479 |
| MA | Essex County | 100 | 100 | 4 | 5 | 3 | 1 | 37 | 0 | LAST FIRST | 416 | 7 | 84 | 399 / 1838 |
| MI | Kent County | 0 | 0 | 0 | 2 | 0 | 0 | 12 | 0 | LAST FIRST | 585 | 1 | 1 | 509 / 2526 |
| MN | Ramsey County | 100 | 8 | 8 | 2 | 1 | 6 | 1 | 0 | FIRST LAST | 0 | 1078 | 0 | 788 / 2287 |
| MN | Dakota County | 100 | 71 | 22 | 3 | 2 | 1 | 0 | 0 | LAST FIRST | 333 | 5 | 0 | 286 / 1372 |
| MO | Jackson County | 21 | 8 | 0 | 3 | 4 | 5 | 7 | 0 | LAST FIRST | 353 | 31 | 0 | 369 / 2038 |
| MS | Washington County | 74 | 0 | 0 | 0 | 0 | 0 | 41 | 0 | LAST FIRST | 228 | 9 | 1188 | 284 / 1376 |
| NC | Forsyth County | 12 | 12 | 12 | 5 | 0 | 6 | 21 | 0 | LAST FIRST | 228 | 5 | 1256 | 194 / 1349 |
| NC | Buncombe County | 100 | 100 | 0 | 2 | 0 | 1 | 2 | 0 | LAST FIRST | 318 | 7 | 0 | 245 / 2328 |
| ND | Grand Forks County | 100 | 100 | 0 | 15 | 0 | 0 | 0 | 0 | LAST FIRST | 433 | 2 | 2315 | 408 / 2440 |
| NM | Bernalillo County | 100 | 100 | 0 | 7 | 0 | 0 | 8 | 0 | LAST FIRST | 536 | 6 | 0 | 451 / 2565 |
| NM | Doña Ana County | 100 | 100 | 0 | 0 | 0 | 0 | 18 | 0 | LAST FIRST | 447 | 15 | 5 | 670 / 2629 |
| NV | Washoe County | 100 | 100 | 0 | 5 | 0 | 11 | 3 | 0 | LAST FIRST | 417 | 0 | 1423 | 254 / 1463 |
| NY | Monroe County | 0 | 0 | 0 | 6 | 1 | 1 | 21 | 0 | LAST FIRST | 1044 | 13 | 1835 | 896 / 2449 |
| NY | Onondaga County | 100 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | LAST FIRST | 1576 | 0 | 2070 | 890 / 2733 |
| OH | Summit County | 100 | 100 | 0 | 11 | 2 | 19 | 11 | 0 | LAST FIRST | 1035 | 10 | 0 | 392 / 1724 |
| OH | Muskingum County | 100 | 100 | 0 | 12 | 1 | 1 | 19 | 0 | LAST FIRST | 652 | 5 | 0 | 230 / 2268 |
| OK | Oklahoma County | 100 | 100 | 0 | 0 | 0 | 0 | 3 | 0 | LAST FIRST | 524 | 4 | 0 | 405 / 2594 |
| OK | Tulsa County | 100 | 100 | 0 | 2 | 1 | 1 | 26 | 0 | LAST FIRST | 314 | 6 | 1632 | 286 / 1740 |
| OR | Washington County | 100 | 100 | 0 | 2 | 0 | 5 | 4 | 0 | LAST FIRST | 254 | 2 | 0 | 218 / 1958 |
| OR | Clackamas County | 100 | 100 | 0 | 1 | 1 | 4 | 2 | 0 | LAST FIRST | 477 | 1 | 0 | 350 / 2355 |
| SC | Greenville County | 100 | 42 | 0 | 12 | 2 | 2 | 38 | 0 | LAST FIRST | 535 | 13 | 0 | 362 / 1964 |
| SC | Charleston County | 0 | 5 | 0 | 1 | 0 | 0 | 43 | 0 | LAST FIRST | 830 | 21 | 0 | 600 / 2250 |
| TN | Shelby County | 100 | 100 | 0 | 1 | 0 | 1 | 9 | 0 | LAST FIRST | 697 | 6 | 0 | 422 / 2414 |
| TN | Hamilton County | 100 | 100 | 0 | 5 | 0 | 3 | 0 | 0 | LAST FIRST | 590 | 9 | 0 | 533 / 2546 |
| TX | Hidalgo County | 100 | 100 | 48 | 2 | 0 | 1 | 4 | 0 | LAST FIRST | 30 | 0 | 0 | 93 / 1434 |
| TX | Cameron County | 94 | 97 | 1 | 8 | 0 | 3 | 34 | 0 | LAST FIRST | 161 | 9 | 5 | 565 / 1893 |
| VA | Virginia Beach city | 100 | 100 | 20 | 1 | 0 | 5 | 16 | 0 | LAST FIRST | 328 | 1 | 0 | 113 / 1748 |
| VA | Chesterfield County | 100 | 100 | 0 | 1 | 0 | 0 | 21 | 0 | LAST FIRST | 264 | 9 | 0 | 164 / 2321 |
| VT | Rutland County | 100 | 100 | 17 | 5 | 0 | 0 | 12 | 0 | LAST FIRST | 704 | 8 | 0 | 561 / 2159 |
| WI | Milwaukee County | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | FIRST LAST | 0 | 1251 | 2 | 998 / 2542 |
| WI | Dane County | 100 | 100 | 0 | 2 | 0 | 0 | 8 | 0 | FIRST LAST | 0 | 1040 | 38 | 645 / 1828 |
| WV | Kanawha County | 97 | 97 | 0 | 6 | 0 | 2 | 69 | 0 | LAST FIRST | 446 | 50 | 0 | 249 / 1887 |
| WV | Berkeley County | 4 | 4 | 0 | 1 | 0 | 2 | 1 | 0 | LAST FIRST | 700 | 10 | 0 | 224 / 2805 |
| UT | Washington County (break-risk add) | 100 | 100 | 100 | 9 | 0 | 3 | 6 | 0 | mixed/unclear | 0 | 0 | 0 | 0 / 0 |
| UT | Cache County (break-risk add) | 100 | 100 | 100 | 0 | 0 | 0 | 55 | 0 | mixed/unclear | 0 | 0 | 0 | 0 / 0 |
| LA | Jefferson Parish (break-risk add) | 100 | 100 | 0 | 1 | 0 | 1 | 3 | 0 | LAST FIRST | 28 | 286 | 2713 | 1460 / 2759 |
| NY | Broome County (break-risk add) | 51 | 50 | 0 | 9 | 2 | 13 | 40 | 0 | LAST FIRST | 1124 | 2 | 2049 | 875 / 2371 |
