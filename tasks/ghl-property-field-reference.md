# GHL Property Object Field Reference

PropTracerPRO dossier enrichment, GoHighLevel custom object `custom_objects.property`.

**Applied and verified 2026-09-17** against location `jeq20bcKOgy7XQ3AAgHD` (030 - Suite Gateway Connector).
Everything in this document was read back from the live schema after the change, not copied from a plan.

---

## Status

| | |
|---|---|
| Location | `jeq20bcKOgy7XQ3AAgHD` |
| Object key | `custom_objects.property` |
| Fields before | 51 |
| Fields after | **104** |
| Created this pass | 53 |
| Failed | 0 |
| `MONETORY` fields on object | **0** |
| Field folder | `Yok7M7FBnypBpjVUFhfe` ("Property") |

---

## Correction to the original plan

The source plan said **54 new fields**. The real number was **53**.

`last_sale_price` already existed on this location as `TEXT`, created 2026-09-07. The plan listed it
as a new field to create as Number. Running the plan unmodified would have duplicated or errored on it.

It was empty on both existing Property records, so it was deleted and recreated as `NUMERICAL` to stay
consistent with `prior_sale_price`, `price_per_sqft` and `mls_listing_price`, and with its own partner
`last_sale_date` which was already a proper `DATE`.

**Breaking change:** the field ID for `last_sale_price` changed. The old ID `Cg7VYLMzJzu3kNsJ5fEY` no
longer exists. The merge tag `{{custom_objects.property.last_sale_price}}` is unchanged and still
resolves. Anything that references this field by raw ID needs repointing.

---

## The three rules

### 1. Never use the Money type

GoHighLevel `MONETORY` fields cannot be written. This is confirmed at the API level: the create
endpoint's own enum is

```
TEXT, LARGE_TEXT, NUMERICAL, PHONE, MONETORY, CHECKBOX, SINGLE_OPTIONS, MULTIPLE_OPTIONS,
DATE, TEXTBOX_LIST, FILE_UPLOAD, RADIO, EMAIL, URL, TIME, DATE_TIME, USER, RICH_TEXT,
FORMULA, ROLLUP, DURATION
```

Note the spelling. `MONETORY`, not `MONETARY`. That is GoHighLevel's spelling, not a typo in this doc.

Every money-bearing field is `NUMERICAL`. All nine of them:

- Last Sale Price
- Sale Price Per Sqft
- Assessed Value
- Area Median Income
- Open Mortgage Balance
- Estimated Mortgage Payment
- Portfolio Assessed Value
- Prior Sale Price
- Listing Price

`current_upb` and `original_upb` were already `NUMERICAL` on this location and are **confirmed writable**
as of this pass. They were verified by writing real values and reading them back.

### 2. Yes/no fields are Single line, not Checkbox

They carry the literal strings `Yes` and `No`. This matches what the object already did for
`owner_is_individual` and `owner_out_of_state`. A live record was confirmed holding `"Yes"` as a string.

The 25 yes/no fields: Air Conditioning, Garage, Pool, Basement, Deck, Absentee Owner, Owner Occupied, Vacant, Pre-Foreclosure, Foreclosure, Tax Delinquent, Tax Lien, Inherited, Death Of Owner, Judgment, HOA, Cash Buyer, Quit Claim Deed, MLS Active, MLS Pending, MLS Cancelled, MLS Sold, MLS Failed, Adjustable Rate, Investor Buyer

### 3. Assessed Value is a county assessment, never a market valuation

`assessed_value` is what the county assesses. It is not a market value and must never be labelled or
presented as one. On measured parcels it matched the vendor's own estimate exactly, and against real
sale prices it ran from 7 to 59 percent of what the property actually sold for.

`total_portfolio_value` ("Portfolio Assessed Value") is the same number summed across the owner's
holdings, so it carries the same caveat. It measures how much they own, not what it is worth.

---

## Dossier keys that map to existing fields

These 4 have a different name on each side. **Map them, do not create them.**

| Dossier key | GHL field key | GHL type |
|---|---|---|
| `zip_code` | `zip` | `TEXT` |
| `apn` | `parcel_number_1` | `TEXT` |
| `units_count` | `units` | `NUMERICAL` |
| `years_owned` | `years_held` | `NUMERICAL` |

These 8 match by name and already exist: `address`, `city`, `state`, `county`, `property_type`,
`year_built`, `last_sale_date`, plus `last_sale_price` (see the correction above).

---

## API contract

Base `https://services.leadconnectorhq.com`, header `Version: 2021-07-28`.
Auth is a sub-account Private Integration Token as `Authorization: Bearer pit-...`.

### Creating a field

`POST /custom-fields/`

```json
{
  "locationId": "jeq20bcKOgy7XQ3AAgHD",
  "name": "Latitude",
  "dataType": "NUMERICAL",
  "fieldKey": "latitude",
  "objectKey": "custom_objects.property",
  "parentId": "Yok7M7FBnypBpjVUFhfe",
  "showInForms": false
}
```

Send the **short** `fieldKey` (`latitude`). The API prefixes the object key itself and stores it as
`custom_objects.property.latitude`.

### Writing a record

`POST /objects/custom_objects.property/records`

The `properties` object takes **short keys**, not the dotted merge-tag path:

```json
{
  "locationId": "jeq20bcKOgy7XQ3AAgHD",
  "properties": {
    "property_id": "FL_12086_0132190130010",
    "latitude": 30.694355,
    "last_sale_price": 4250000,
    "absentee_owner": "Yes",
    "prior_sale_date": "2019-06-14"
  }
}
```

Dates are `YYYY-MM-DD`. `property_id` is the object's required property.

### Gotchas that cost real time

1. **`dataType` is immutable.** `PUT /custom-fields/{id}` rejects it with
   `"property dataType should not exist"`. Changing a field's type requires delete and recreate.
2. **Record DELETE takes no `locationId`.** `DELETE /objects/custom_objects.property/records/{id}`
   returns 422 `"property locationId should not exist"` if you pass it, unlike nearly every other
   endpoint which requires it.
3. **Field create needs `parentId`.** It is not optional. Without it you get a 422.
4. **The MCP OAuth flow is unreliable.** As of this date the connector flow fails at the callback with
   "Authorization state is missing" and no `state` param reaches the redirect URL. Use a Private
   Integration Token against the REST API instead. HighLevel's own MCP docs still describe PIT as the
   only supported auth, so this is the well-trodden path.

---

## Field list

All 54 dossier fields, verified present on the live object with the exact types shown.

| Field name | Key | GHL UI type | API `dataType` | Merge tag |
|---|---|---|---|---|
| Latitude | `latitude` | Number | `NUMERICAL` | `{{custom_objects.property.latitude}}` |
| Longitude | `longitude` | Number | `NUMERICAL` | `{{custom_objects.property.longitude}}` |
| Subdivision | `subdivision` | Single line | `TEXT` | `{{custom_objects.property.subdivision}}` |
| Property Use | `property_use` | Single line | `TEXT` | `{{custom_objects.property.property_use}}` |
| Land Use | `land_use` | Single line | `TEXT` | `{{custom_objects.property.land_use}}` |
| Bedrooms | `beds` | Number | `NUMERICAL` | `{{custom_objects.property.beds}}` |
| Bathrooms | `baths` | Number | `NUMERICAL` | `{{custom_objects.property.baths}}` |
| Stories | `stories` | Number | `NUMERICAL` | `{{custom_objects.property.stories}}` |
| Building Size Sqft | `building_size_sqft` | Number | `NUMERICAL` | `{{custom_objects.property.building_size_sqft}}` |
| Lot Size Sqft | `lot_size_sqft` | Number | `NUMERICAL` | `{{custom_objects.property.lot_size_sqft}}` |
| Air Conditioning | `has_ac` | Single line | `TEXT` | `{{custom_objects.property.has_ac}}` |
| Garage | `has_garage` | Single line | `TEXT` | `{{custom_objects.property.has_garage}}` |
| Pool | `has_pool` | Single line | `TEXT` | `{{custom_objects.property.has_pool}}` |
| Basement | `has_basement` | Single line | `TEXT` | `{{custom_objects.property.has_basement}}` |
| Deck | `has_deck` | Single line | `TEXT` | `{{custom_objects.property.has_deck}}` |
| Last Sale Price | `last_sale_price` | Number | `NUMERICAL` | `{{custom_objects.property.last_sale_price}}` |
| Absentee Owner | `absentee_owner` | Single line | `TEXT` | `{{custom_objects.property.absentee_owner}}` |
| Owner Occupied | `owner_occupied` | Single line | `TEXT` | `{{custom_objects.property.owner_occupied}}` |
| Vacant | `vacant` | Single line | `TEXT` | `{{custom_objects.property.vacant}}` |
| Pre-Foreclosure | `pre_foreclosure` | Single line | `TEXT` | `{{custom_objects.property.pre_foreclosure}}` |
| Foreclosure | `foreclosure` | Single line | `TEXT` | `{{custom_objects.property.foreclosure}}` |
| Tax Delinquent | `tax_delinquent` | Single line | `TEXT` | `{{custom_objects.property.tax_delinquent}}` |
| Tax Delinquent Since | `tax_delinquent_year` | Number | `NUMERICAL` | `{{custom_objects.property.tax_delinquent_year}}` |
| Tax Lien | `tax_lien` | Single line | `TEXT` | `{{custom_objects.property.tax_lien}}` |
| Inherited | `inherited` | Single line | `TEXT` | `{{custom_objects.property.inherited}}` |
| Death Of Owner | `death` | Single line | `TEXT` | `{{custom_objects.property.death}}` |
| Judgment | `judgment` | Single line | `TEXT` | `{{custom_objects.property.judgment}}` |
| HOA | `hoa` | Single line | `TEXT` | `{{custom_objects.property.hoa}}` |
| Sale Price Per Sqft | `price_per_sqft` | Number | `NUMERICAL` | `{{custom_objects.property.price_per_sqft}}` |
| Assessed Value | `assessed_value` | Number | `NUMERICAL` | `{{custom_objects.property.assessed_value}}` |
| Area Median Income | `area_median_income` | Number | `NUMERICAL` | `{{custom_objects.property.area_median_income}}` |
| Open Mortgage Balance | `open_mortgage_balance` | Number | `NUMERICAL` | `{{custom_objects.property.open_mortgage_balance}}` |
| Lender Name | `lender_name` | Single line | `TEXT` | `{{custom_objects.property.lender_name}}` |
| Estimated Mortgage Payment | `estimated_mortgage_payment` | Number | `NUMERICAL` | `{{custom_objects.property.estimated_mortgage_payment}}` |
| Properties Owned | `total_properties_owned` | Number | `NUMERICAL` | `{{custom_objects.property.total_properties_owned}}` |
| Portfolio Assessed Value | `total_portfolio_value` | Number | `NUMERICAL` | `{{custom_objects.property.total_portfolio_value}}` |
| Cash Buyer | `cash_buyer` | Single line | `TEXT` | `{{custom_objects.property.cash_buyer}}` |
| Roof Material | `roof_material` | Single line | `TEXT` | `{{custom_objects.property.roof_material}}` |
| Roof Construction | `roof_construction` | Single line | `TEXT` | `{{custom_objects.property.roof_construction}}` |
| Flood Zone | `flood_zone` | Single line | `TEXT` | `{{custom_objects.property.flood_zone}}` |
| Prior Sale Price | `prior_sale_price` | Number | `NUMERICAL` | `{{custom_objects.property.prior_sale_price}}` |
| Prior Sale Date | `prior_sale_date` | Date picker | `DATE` | `{{custom_objects.property.prior_sale_date}}` |
| Document Type | `document_type` | Single line | `TEXT` | `{{custom_objects.property.document_type}}` |
| Quit Claim Deed | `quit_claim` | Single line | `TEXT` | `{{custom_objects.property.quit_claim}}` |
| Recording Date | `recording_date` | Date picker | `DATE` | `{{custom_objects.property.recording_date}}` |
| MLS Active | `mls_active` | Single line | `TEXT` | `{{custom_objects.property.mls_active}}` |
| MLS Pending | `mls_pending` | Single line | `TEXT` | `{{custom_objects.property.mls_pending}}` |
| MLS Cancelled | `mls_cancelled` | Single line | `TEXT` | `{{custom_objects.property.mls_cancelled}}` |
| MLS Sold | `mls_sold` | Single line | `TEXT` | `{{custom_objects.property.mls_sold}}` |
| MLS Failed | `mls_failed` | Single line | `TEXT` | `{{custom_objects.property.mls_failed}}` |
| Days On Market | `mls_days_on_market` | Number | `NUMERICAL` | `{{custom_objects.property.mls_days_on_market}}` |
| Listing Price | `mls_listing_price` | Number | `NUMERICAL` | `{{custom_objects.property.mls_listing_price}}` |
| Adjustable Rate | `adjustable_rate` | Single line | `TEXT` | `{{custom_objects.property.adjustable_rate}}` |
| Investor Buyer | `investor_buyer` | Single line | `TEXT` | `{{custom_objects.property.investor_buyer}}` |

---

## Fields expected to be empty

`beds`, `baths`, `tax_delinquent_year`, `mls_days_on_market` and `mls_listing_price` were empty on all
four sample properties. They are created deliberately. The sample was commercial parcels in Ohio,
California and Utah, and what a county publishes varies a great deal by county. An empty field here is
a coverage gap, not a broken one.

---

## Verification performed

A Property record was created with 41 values spanning every category, then read back fresh from the API
rather than trusting the create response. All 41 matched with zero missing and zero mismatches.
Coverage included the `NUMERICAL` money fields, the yes/no `TEXT` fields, both `DATE` pickers, and
plain numerics. The record was deleted afterward, leaving the original 2 records intact.

Re-running the creation script is safe. It re-reads the live schema on each pass and skips anything
already present, so it will not duplicate fields if pointed at another sub-account later.
