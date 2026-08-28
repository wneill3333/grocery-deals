# Store scraping runbook

Companion to `scrapers.js`. One section per store: where the coupons live, what a healthy
run looks like, how the rows get into Supabase, and what it looks like when the store
breaks. **Last full live validation: 2026-08-28.**

If a store's count comes back far below its expected range, the selectors have moved.
Fix them here and in `scrapers.js` in the same change — a future run reads only these
two files.

## How a run works

1. `navigate` to the store's `url`. The navigate tool silently no-ops sometimes — confirm
   with a `location.href` read, never with the tool's own success message.
2. Paste `scrapers.js` into the page (it defines `GD` and `GD_SCRAPERS`), then `GD.reset()`.
3. Loop up to `maxRounds`: `GD.add(GD_SCRAPERS[key].extract().rows)`, then
   `GD_SCRAPERS[key].advance()` between rounds. Stop when the count stops growing twice.
   - `scroll: "real"` means JS scrolling does not work — send real `computer` scroll ticks.
   - Keep any in-page click/wait loop to **4 iterations per `javascript_tool` call**; more
     than that hits the 45-second CDP timeout (the loop still runs, but you lose the result).
4. Upsert `GD.rows()` from the browser side using the store's `transfer` technique.
5. Report `GD.summary(key)` — counts and warnings only. **Never return rows through the
   tool channel**: output truncates at ~900 characters and URLs/query strings get redacted.

`transfer` values:
- **inject** — load supabase-js on the retailer tab, `setSession` with tokens read from the
  app tab, `.upsert()` from there. Best when it works: no data relay at all.
- **windowname** — `window.name = JSON.stringify(rows)`, navigate that same tab to the app,
  read it back and upsert there. For sites whose CSP blocks fetch to supabase.co.
- **either** — try inject, fall back to windowname.

Upsert contract, every store, no exceptions:

```js
await client.from('digital_coupons').upsert(rows, { onConflict: 'dedup_key' })
```

Row objects carry ONLY `store, item, description, savings, clip_url, image_url,
date_pulled, expires_on`. Never `id`, `dedup_key`, `intending_to_buy`,
`intending_to_buy_by`, or `clipped` — leaving those out is what keeps the shopping list
alive across pulls.

**Read-only, always.** Never click Clip / Add to Card / Get this offer. Never sign in,
sign up, or answer a CAPTCHA.

### Two hard-won rules about the upsert itself (2026-08-28)

1. **Deduplicate the rows in the browser before upserting.** Postgres rejects a batch
   containing two rows with the same `dedup_key`: *"ON CONFLICT DO UPDATE command cannot
   affect row a second time."* Retailers really do list the same offer twice (WinCo 106
   cards → 105 unique; Vons 359 → 330; Albertsons 377 → 346). Collapse on
   `store|item|savings`, lowercased, keeping the first.
2. **Upsert in batches of 200**, not one giant call.

### Supabase returns at most 1000 rows per request

Any read that can exceed 1000 rows has to be paged with `.range(from, from + 999)` until a
short page comes back. The app does this in its `fetchAll()` helper — it was capped at
1000 and silently hiding 333 coupons until this was fixed. Remember it for any ad-hoc
verification query too.

### Sprouts cannot currently be inserted by an agent

`window.name` does not survive shop.sprouts.com (confirmed a third time on 2026-08-28,
including with an immediate `location.replace()` in the same tick), and the "inject"
alternative needs the app's Supabase **access token**, which the browser tool now redacts
from its output as a JWT. So the token cannot be carried to the retailer tab. Until
there's another route, Sprouts' 53 coupons have to come from an earlier pull, or the
scrape has to happen on a tab that can reach Supabase directly. Do not try to work around
the redaction.

---

## WinCo — healthy
- `https://www.wincofoods.com/coupons/`
- **106 rows** on 2026-08-28. Expect 80–140.
- All cards in the DOM at once; no pagination, no scrolling.
- `<mct-coupon>` elements, light DOM. `.coupon__brand`, `.coupon__description` (already
  begins with the brand — do not prepend it again), `.coupon__save-text`,
  `.coupon__validity` ("Valid: August 9 – September 5, 2026" → take the *later* date).
- Images lazy-load: when `img.src` ends in `loading.svg`, use `img.dataset.src`.
- **Breaks like:** zero `<mct-coupon>` elements → they migrated off the MyCouponTools widget.

## Vons — healthy
- `https://www.vons.com/loyalty/coupons-deals`
- **360 cards → 331 unique rows** on 2026-08-28. Expect 250–450.
- `.coupon-card`. Item `.cpn-title`; savings `.coupon-card__card-body__card-title`
  ("$3.19 Each"); size/detail `.cpn-details` (skip the one starting "In-store:");
  expiry `.expiration.text-nowrap`.
- "Load more" adds 30 at a time and cards **accumulate** — about 11 clicks to exhaust.
  Four clicks per tool call.
- **Breaks like:** `.cpn-title` empty → Albertsons-platform redesign; check Albertsons too,
  they share the markup.

## Albertsons — healthy, and much bigger than the app currently shows
- `https://www.albertsons.com/loyalty/coupons-deals` (`/foru` redirects here)
- **378 cards → 347 unique rows** on 2026-08-28, versus 20 rows in the database. Expect 250–450.
- Identical markup to Vons — both use `__albertsonsFamily()`.
- Note: the account's selected store read as an out-of-area address on 2026-08-28, so a
  few offers may not be local. Harmless, but worth a look if prices seem wrong.

## Walgreens — healthy, with a known truncation
- `https://www.walgreens.com/offers/offers.jsp`
- **112 cards → 101 rows** on 2026-08-28. Expect 80–200.
- All cards in the DOM; **no longer virtualized** (the old scroll-accumulate dance is
  no longer needed).
- `.wag-do-couponlist-box`. **`<strong>` is the SAVINGS** ("$3 off 1");
  **`.coupon__descp` is the PRODUCT**; expiry `.text-danger` ("Expires 08/29/26").
- 11 generic "Earn $X W Cash rewards…" cards have no product name and are dropped.
- ~95% of descriptions are truncated by Walgreens' own markup. The full text exists only
  in a per-card modal, which is far too expensive for a recurring run. The brand always
  survives, so want-list matching still works. **Accepted — do not "fix" this.**
- Almost no product images on this page. Zero `image_url` is normal here.

## Smart & Final — healthy
- `https://www.smartandfinal.com/sm/planning/rsid/426/coupon-gallery`
- **150 unique rows** across 5 numbered pages on 2026-08-28. Expect 120–180.
- First load shows Cloudflare's "Just a moment…" and hops through `/silent-signin/` for
  10–20 seconds. **Wait it out**; do not re-navigate.
- `[class*="CouponCard--"]`, with `[class*="CouponCardBrand--"]`,
  `…Description--`, `…Savings--`, `…Expiry--` ("End Date: Tue, Sep 1, 2026").
- Pagination: click the numbered buttons 2…5, or go by URL (`?page=N&skip=(N-1)*30`).
- **Breaks like:** zero cards after 30 seconds → still on the Cloudflare interstitial.

## Sprouts — healthy
- `https://shop.sprouts.com/store/sprouts/pages/in-store-deals`
- **53 rows** on 2026-08-28; the page prints its own coupon count — compare against it.
  Expect 40–90.
- Class names are emotion-generated hashes that change on every deploy. **Never select on
  them.** Find the "Clip" buttons and walk up to their `<li>`; each card has exactly four
  leaf texts: savings badge, description, "Expires on Sep 30", and the Clip button.
- Descriptions read "Save $1.25 on Stonyfield Organic" — the money prefix is stripped so
  the item reads like a product.
- **JS scrolling does not load more.** Send real `computer` scroll ticks (one batch of ~10
  took it from 30 to all 53).
- A "Lettuce Know" preferences modal can appear mid-scroll. Dismiss with its ✕ —
  never submit it; that would change the account's preferences.
- `window.name` does **not** survive this site. Use `transfer: "inject"`.

## Walmart — healthy (permission came back mid-session)
- `https://www.walmart.com/offer/all-offers?department=grocery&instore=N`
- **43 cards on page 1 of 6 numbered pages → roughly 250 offers.** The database has 43.
  Expect 40–300 across the full pagination.
- `.ld_AJ` cards. Parse the card's `innerText` **by line role**, not by `img.alt`:
  line 1 `"$X.XX Walmart Cash"` (savings), line 2 the product name, then
  "See N items" / "Get this offer" / "Manufacturer offer" which are all dropped.
- No expiry is shown on these cards; `expires_on` stays null and the 21-day purge covers them.
- Walmart's markup carries U+FFFD where ® belongs — replaced inline by the extractor.
- Walmart's CSP blocks page-initiated fetch to supabase.co → `transfer: "windowname"`.
- **Known non-code failure:** `javascript_tool` can answer "Permission denied for
  JavaScript execution on this domain". That is the Chrome extension's per-site
  permission lapsing, not a broken selector. Screenshots and `get_page_text` keep working
  when it happens. Note it and move on; it came back on its own within an hour on
  2026-08-28.

## Ralphs — BLOCKED (signed out)
- `https://www.ralphs.com/savings/cl/coupons/`
- 2026-08-28: page rendered signed out ("Sign In" in the header) and Kroger shows no
  coupon grid to guests. Zero rows.
- **Fix:** Bill signs in to ralphs.com in his own Chrome profile. Selectors in
  `scrapers.js` are from the last successful pull and are unverified since — re-check and
  update this section on the first logged-in run.

## Not attempted, by standing decision
- **CVS** — no active login in this profile. Needs Bill.
- **Grocery Outlet** — "WOW! Crowd" signup needs a phone number, a password and a
  reCAPTCHA. Needs Bill.
- **Stater Bros** — Bill is logged in and Cloudflare clears itself, but the savings area
  renders empty with zero API calls. Looks like a site-side bug. Recheck briefly once per
  run, then move on.

---

## Weekly ads (best effort, time permitting)

| Store | Weekly ad |
|---|---|
| Albertsons | https://www.albertsons.com/weeklyad |
| Vons | https://www.vons.com/weeklyad |
| Ralphs | https://www.ralphs.com/weeklyad |
| Stater Bros | https://www.staterbros.com/weeklyad/flyerview |
| CVS | https://www.cvs.com/weeklyad/pageview |
| Walgreens | https://www.walgreens.com/offers/offers.jsp |
| Smart & Final | https://www.smartandfinal.com/circular |
| Sprouts | https://www.sprouts.com/weekly-ad/ |
| Grocery Outlet | https://www.groceryoutlet.com/circulars |
| WinCo | https://www.wincofoods.com/weekly-ad |
| Walmart | https://www.walmart.com/ (no real weekly ad — everyday pricing) |

`weekly_deals` rows carry `store, category, item, price, unit, sale_start, sale_end,
notable, notes, source='Weekly Ad', source_url, date_pulled`, upserted on `dedup_key` the
same way. Categories: Produce, Meat & Seafood, Dairy & Eggs, Bakery, Frozen,
Pantry/Canned & Dry Goods, Beverages, Snacks, Household & Cleaning, Health & Beauty,
Baby & Kids, Pet Supplies, Other. Mark `notable` only for a true BOGO, a stated ~40%+
discount, or a clearly below-normal price — aim for 10–15% of rows.

## Cleanup at the end of every run

```sql
delete from digital_coupons where intending_to_buy = false
  and (expires_on < current_date or (expires_on is null and date_pulled < current_date - 21));
delete from weekly_deals where intending_to_buy = false and sale_end < current_date - 3;
update digital_coupons set item = replace(item, '�', '®') where item like '%�%';
```

The `intending_to_buy = false` guard is not optional — it is what stops a purge from
deleting something off the shopping list.
