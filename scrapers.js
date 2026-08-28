/* Grocery Deals scraper playbook  —  https://github.com/wneill3333/grocery-deals
 *
 * WHAT THIS IS
 *   A recipe book for the twice-weekly digital-coupon pull. Each store entry knows its
 *   page URL, how many cards to expect, how to get rows out of the DOM, and how to get
 *   those rows into Supabase. The recurring scheduled task fetches this file and sends
 *   the relevant function bodies into the retailer page via javascript_tool.
 *
 * HOW TO RUN ONE STORE (see SCRAPERS.md for the full runbook)
 *   1. navigate to GD_SCRAPERS[key].url  (confirm with a location.href read; navigate
 *      silently no-ops sometimes)
 *   2. paste this file's contents into the page, then:  GD.reset()
 *   3. loop, up to `maxRounds`:  GD.add(GD_SCRAPERS[key].extract().rows)
 *      - between rounds run GD_SCRAPERS[key].advance() (returns true if there may be
 *        more) and, for stores with scroll:"real", a real computer-tool scroll tick.
 *      - stop when the accumulated count stops growing for 2 rounds.
 *   4. upsert GD.rows() from the browser side using the store's `transfer` technique.
 *      NEVER return the rows themselves through the tool channel (truncation+redaction).
 *
 * ROW CONTRACT (do not deviate — this is what protects the shopping list)
 *   Every row object contains ONLY:
 *     store, item, description, savings, clip_url, image_url, date_pulled, expires_on
 *   NEVER include: id, dedup_key (generated), intending_to_buy, intending_to_buy_by, clipped.
 *   Insert with:  .upsert(rows, { onConflict: 'dedup_key' })
 */

(function () {
  var TODAY = new Date();
  function iso(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
           String(d.getDate()).padStart(2, "0");
  }

  var GD = {
    today: iso(TODAY),
    acc: new Map(),
    reset: function () { this.acc = new Map(); return 0; },
    key: function (r) {
      return ((r.store || "") + "|" + (r.item || "") + "|" + (r.savings || "")).toLowerCase();
    },
    add: function (rows) {
      var self = this;
      (rows || []).forEach(function (r) {
        if (!r || !r.item) return;
        var k = self.key(r);
        if (!self.acc.has(k)) self.acc.set(k, r);
      });
      return this.acc.size;
    },
    rows: function () { return Array.from(this.acc.values()); },

    /* text helpers ------------------------------------------------------- */
    txt: function (el, sel) {
      var n = sel ? el.querySelector(sel) : el;
      return n ? (n.textContent || "").replace(/\s+/g, " ").trim() : "";
    },
    clean: function (s) { return (s || "").replace(/\s+/g, " ").trim() || null; },
    img: function (el) {
      var i = el.querySelector("img");
      if (!i) return null;
      var s = i.getAttribute("src") || "";
      if (!s || /loading\.svg|placeholder|data:image/i.test(s)) s = i.dataset ? (i.dataset.src || i.dataset.lazySrc || "") : "";
      return s || null;
    },

    /* Any date-ish text -> ISO. Ranges ("Valid: August 9 - September 5, 2026",
       "8/9 - 9/5") resolve to the LATEST date found, which is the expiry. */
    expiry: function (text) {
      if (!text) return null;
      var t = String(text), found = [], m;
      var re1 = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
      while ((m = re1.exec(t))) found.push([+m[1], +m[2], +m[3]]);
      var re2 = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g;
      while ((m = re2.exec(t))) {
        var yr = m[3] ? (+m[3] < 100 ? +m[3] + 2000 : +m[3]) : null;
        found.push([yr, +m[1], +m[2]]);
      }
      var MON = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
      var re3 = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/g;
      while ((m = re3.exec(t))) {
        var i = MON.indexOf(m[1].slice(0, 3).toLowerCase());
        if (i < 0) continue;
        found.push([m[3] ? +m[3] : null, i + 1, +m[2]]);
      }
      var floor = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - 30);
      var nums = found.map(function (f) {
        var y = f[0];
        if (y === null) {
          y = TODAY.getFullYear();
          if (new Date(y, f[1] - 1, f[2]) < floor) y += 1;
        }
        return y * 10000 + f[1] * 100 + f[2];
      }).filter(function (v) {
        var mo = Math.floor(v / 100) % 100, da = v % 100;
        return mo >= 1 && mo <= 12 && da >= 1 && da <= 31;
      });
      if (!nums.length) return null;
      var mx = Math.max.apply(null, nums);
      return Math.floor(mx / 10000) + "-" + String(Math.floor(mx / 100) % 100).padStart(2, "0") +
             "-" + String(mx % 100).padStart(2, "0");
    },

    /* returns a compact, tool-channel-safe summary (never raw rows/urls) */
    summary: function (key) {
      var s = window.GD_SCRAPERS[key], rows = this.rows(), w = [];
      if (rows.length < s.expect[0]) w.push("LOW: expected >= " + s.expect[0] + ", saw " + rows.length);
      var noImg = rows.filter(function (r) { return !r.image_url; }).length;
      var noExp = rows.filter(function (r) { return !r.expires_on; }).length;
      return { store: key, n: rows.length, expect: s.expect, noImg: noImg, noExp: noExp,
               sample: rows.slice(0, 2).map(function (r) { return (r.item || "").slice(0, 45); }), warnings: w };
    }
  };

  function base(store, clip) {
    return { store: store, clip_url: clip, date_pulled: GD.today };
  }

  var GD_SCRAPERS = {

    /* Albertsons-family platform (Vons, Albertsons, Safeway...) share this card markup.
       Verified live 2026-08-28 on vons.com: 360 cards -> 331 unique rows. */
    __albertsonsFamily: function (store, clip) {
      var out = [], warn = [];
      var cards = document.querySelectorAll(".coupon-card");
      if (!cards.length) warn.push("no .coupon-card elements");
      cards.forEach(function (c) {
        var item = GD.txt(c, ".cpn-title");
        if (!item) return;
        var det = Array.prototype.map.call(c.querySelectorAll(".cpn-details"), function (e) {
          return (e.textContent || "").replace(/\s+/g, " ").trim();
        }).filter(function (x) { return x && !/^In-store/i.test(x); })[0] || "";
        var r = base(store, clip);
        r.item = item.replace(/\.$/, "");
        r.description = GD.clean(det);
        r.savings = GD.clean(GD.txt(c, ".coupon-card__card-body__card-title"));
        r.image_url = GD.img(c);
        r.expires_on = GD.expiry(GD.txt(c, ".expiration.text-nowrap"));
        out.push(r);
      });
      return { rows: out, warnings: warn };
    },

    /* Clicks "Load more" (cards accumulate; NOT virtualized). Keep to <= 4 clicks per
       javascript_tool call - more than that hits the 45s CDP timeout. */
    __loadMore: function () {
      var b = Array.prototype.slice.call(document.querySelectorAll("button, a")).filter(function (x) {
        return /^load more$/i.test((x.textContent || "").replace(/\s+/g, " ").trim()) && x.offsetParent !== null;
      })[0];
      if (!b) return false;
      b.click();
      return true;
    },

    /* ------------------------------------------------------------------ WinCo */
    winco: {
      url: "https://www.wincofoods.com/coupons/",
      store: "WinCo", transfer: "either", scroll: "none", maxRounds: 1, expect: [80, 140],
      extract: function () {
        var out = [], warn = [];
        var cards = document.querySelectorAll("mct-coupon");
        if (!cards.length) warn.push("no <mct-coupon> elements");
        cards.forEach(function (c) {
          var root = c.shadowRoot || c;
          var brand = GD.txt(root, ".coupon__brand");
          var desc = GD.txt(root, ".coupon__description");
          var save = GD.txt(root, ".coupon__save-text");
          var valid = GD.txt(root, ".coupon__validity");
          /* .coupon__description usually already begins with the brand */
          var item = desc || brand;
          if (brand && desc && desc.toLowerCase().indexOf(brand.toLowerCase()) !== 0) {
            item = brand + " " + desc;
          }
          item = item.trim();
          if (!item) return;
          var r = base("WinCo", "https://www.wincofoods.com/coupons/");
          r.item = item; r.description = null; r.savings = GD.clean(save);
          r.image_url = GD.img(c); r.expires_on = GD.expiry(valid);
          out.push(r);
        });
        return { rows: out, warnings: warn };
      },
      advance: function () { return false; }
    },

    /* ------------------------------------------------------------------- Vons */
    vons: {
      url: "https://www.vons.com/loyalty/coupons-deals",
      store: "Vons", transfer: "either", scroll: "none", maxRounds: 40, expect: [250, 450],
      extract: function () { return window.GD_SCRAPERS.__albertsonsFamily("Vons", "https://www.vons.com/loyalty/coupons-deals"); },
      /* clicks "Load more"; cards accumulate in the DOM (not virtualized) */
      advance: function () { return window.GD_SCRAPERS.__loadMore(); }
    },

    /* -------------------------------------------------------------- Walgreens */
    /* Verified live 2026-08-28: 112 .wag-do-couponlist-box cards, ALL present in the
       DOM at once (no virtualization today - the old scroll-accumulate dance is no
       longer needed, but advance() still scrolls harmlessly if a future build brings
       it back). 11 generic "Earn $X W Cash" cards carry no product name and are
       dropped -> 101 rows.
       NOTE: <strong> is the SAVINGS ("$3 off 1"); .coupon__descp is the PRODUCT.
       ~95% of descriptions are truncated by Walgreens' own markup; the full text
       exists only in a per-card modal, which costs far more than it is worth on a
       recurring run. The brand always survives the truncation, so want-list matching
       still works. Accepted tradeoff - do not "fix" it with modal cycling. */
    walgreens: {
      url: "https://www.walgreens.com/offers/offers.jsp",
      store: "Walgreens", transfer: "either", scroll: "none", maxRounds: 3, expect: [80, 200],
      extract: function () {
        var out = [], warn = [];
        var cards = document.querySelectorAll(".wag-do-couponlist-box");
        if (!cards.length) warn.push("no .wag-do-couponlist-box elements");
        var generic = 0;
        cards.forEach(function (c) {
          var save = GD.txt(c, "strong");
          if (!save) return;
          if (/^earn \$/i.test(save)) { generic++; return; }   /* no product name on these */
          var item = GD.txt(c, ".coupon__descp") || save;
          var r = base("Walgreens", "https://www.walgreens.com/offers/offers.jsp");
          r.item = GD.clean(item);
          r.description = null;
          r.savings = GD.clean(save);
          r.image_url = GD.img(c);          /* usually null on this page - expected */
          r.expires_on = GD.expiry(GD.txt(c, ".text-danger"));
          out.push(r);
        });
        if (generic) warn.push("skipped " + generic + " generic W Cash cards");
        return { rows: out, warnings: warn };
      },
      advance: function () { window.scrollBy(0, Math.round(window.innerHeight * 0.9)); return false; }
    },

    /* ----------------------------------------------------------------- Walmart */
    /* RE-VERIFIED LIVE 2026-08-28 (after the extension's site permission came back):
       43 .ld_AJ cards on page 1 of 6 numbered pages -> roughly 250 offers available.
       Every card parsed with a name, a savings string and an image.
       Card innerText lines are: "$X.XX Walmart Cash" / "<product name>" /
       "See N item(s)" / "Get this offer" / "Manufacturer offer" - parse by line role,
       NOT by img.alt (alt text is inconsistent).
       .ld_AJ is an obfuscated Tailwind hash and rotates on redesigns - if 0 cards are
       found, screenshot a card and read its classList.
       Walmart markup carries U+FFFD where (R) belongs; replaced inline below.
       Walmart's CSP blocks page-initiated fetch to supabase.co -> windowname transfer.
       If javascript_tool returns "Permission denied for JavaScript execution on this
       domain", that is the Chrome extension's per-site permission, not a code problem:
       note it and move on. */
    walmart: {
      url: "https://www.walmart.com/offer/all-offers?department=grocery&instore=N",
      store: "Walmart", transfer: "windowname", scroll: "none", maxRounds: 7, expect: [40, 300],
      extract: function () {
        var out = [], warn = [];
        var cards = document.querySelectorAll(".ld_AJ");
        if (!cards.length) warn.push("no .ld_AJ cards - obfuscated class rotates; inspect a card's classList");
        cards.forEach(function (c) {
          var lines = (c.innerText || "").split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
          var save = lines.filter(function (x) { return /walmart cash/i.test(x); })[0] || "";
          var item = lines.filter(function (x) {
            return x !== save && !/^see |^get this offer|^manufacturer offer/i.test(x);
          })[0] || "";
          item = item.replace(/\uFFFD/g, "\u00AE");
          if (!item) return;
          var r = base("Walmart", "https://www.walmart.com/offer/all-offers?department=grocery&instore=N");
          r.item = GD.clean(item);
          r.description = null;
          r.savings = GD.clean(save);
          r.image_url = GD.img(c);
          r.expires_on = null;          /* no expiry shown on these cards */
          out.push(r);
        });
        return { rows: out, warnings: warn };
      },
      /* numbered pagination, 6 pages of ~43 */
      advance: function () {
        window.__gdWmPage = (window.__gdWmPage || 1) + 1;
        var target = Array.prototype.slice.call(document.querySelectorAll("button, a")).filter(function (b) {
          return (b.textContent || "").trim() === String(window.__gdWmPage) && b.offsetParent !== null;
        })[0];
        if (!target) return false;
        target.click();
        return true;
      }
    },

    /* ----------------------------------------------------------- Smart & Final */
    /* Verified live 2026-08-28: 5 numbered pages x ~30-32 cards -> 150 unique rows,
       every row with savings, expiry and image. Cloudflare shows "Just a moment..."
       and a /silent-signin/ hop for 10-20s on first load - WAIT it out, do not retry
       the navigate. Pagination also works by URL (?page=N&skip=(N-1)*30) if the
       numbered buttons ever move. */
    smartfinal: {
      url: "https://www.smartandfinal.com/sm/planning/rsid/426/coupon-gallery",
      store: "Smart & Final", transfer: "either", scroll: "none", maxRounds: 6, expect: [120, 180],
      extract: function () {
        var out = [], warn = [];
        var cards = document.querySelectorAll('[class*="CouponCard--"]');
        if (!cards.length) warn.push('no [class*="CouponCard--"] elements (Cloudflare still loading?)');
        cards.forEach(function (c) {
          var brand = GD.txt(c, '[class*="CouponCardBrand--"]');
          var desc  = GD.txt(c, '[class*="CouponCardDescription--"]');
          var item  = brand && desc ? brand + " " + desc : (desc || brand);
          if (!item) return;
          var r = base("Smart & Final", "https://www.smartandfinal.com/sm/planning/rsid/426/coupon-gallery");
          r.item = GD.clean(item);
          r.description = null;
          r.savings = GD.clean(GD.txt(c, '[class*="CouponCardSavings--"]'));
          r.image_url = GD.img(c);
          r.expires_on = GD.expiry(GD.txt(c, '[class*="CouponCardExpiry--"]'));
          out.push(r);
        });
        return { rows: out, warnings: warn };
      },
      /* numbered pagination; clicks page 2, then 3 ... Never matches the Clip button. */
      advance: function () {
        window.__gdPage = (window.__gdPage || 1) + 1;
        var target = Array.prototype.slice.call(document.querySelectorAll("button, a")).filter(function (b) {
          return (b.textContent || "").trim() === String(window.__gdPage) && b.offsetParent !== null;
        })[0];
        if (!target) return false;
        target.click();
        return true;
      }
    },

    /* ---------------------------------------------------------------- Sprouts */
    /* Verified live 2026-08-28: 53 coupons (page states its own count - compare against
       it). Card <li> holds exactly 4 leaf texts: savings badge, full description,
       "Expires on <Mon D>", and the Clip button. Class names are emotion-generated
       (e-uys14m etc.) and change on every deploy - NEVER select on them; find the
       Clip button and walk up to its <li>.
       Two gotchas: (1) JS scrolling does NOT load more - it needs REAL computer-tool
       scroll ticks (one batch of ~10 ticks was enough to go 30 -> 53). (2) A
       "Lettuce Know" preferences modal can appear mid-scroll; dismiss it with its X,
       never submit it (that would change Bill's account preferences).
       window.name relay does NOT survive this site - use transfer "inject". */
    sprouts: {
      url: "https://shop.sprouts.com/store/sprouts/pages/in-store-deals",
      store: "Sprouts Farmers Market", transfer: "inject", scroll: "real", maxRounds: 6, expect: [40, 90],
      extract: function () {
        var out = [], warn = [];
        var lis = [];
        Array.prototype.slice.call(document.querySelectorAll("button")).forEach(function (b) {
          if (!/^clip(ped)?$/i.test((b.textContent || "").trim())) return;
          var li = b.closest("li");
          if (li && lis.indexOf(li) < 0) lis.push(li);
        });
        if (!lis.length) warn.push("no Clip buttons / <li> cards found");
        lis.forEach(function (li) {
          var leaves = Array.prototype.slice.call(li.querySelectorAll("*"))
            .filter(function (e) { return e.children.length === 0 && (e.textContent || "").trim(); })
            .map(function (e) { return (e.textContent || "").replace(/\s+/g, " ").trim(); })
            .filter(function (x) { return !/^clip(ped)?$/i.test(x); });
          var exp = leaves.filter(function (x) { return /expires/i.test(x); })[0] || "";
          var rest = leaves.filter(function (x) { return x !== exp; });
          var item = rest.slice().sort(function (a, b) { return b.length - a.length; })[0] || "";
          var save = rest.filter(function (x) { return x !== item; })[0] || "";
          if (!item) return;
          var r = base("Sprouts Farmers Market", "https://shop.sprouts.com/store/sprouts/pages/in-store-deals");
          /* descriptions read "Save $1.25 on Stonyfield Organic" - drop the redundant
             money prefix so the item reads like a product for want-list matching */
          r.item = GD.clean(item.replace(/^save\s+\$?[\d.]+%?\s+on\s+/i, "")
                                .replace(/^buy\s+\d+,?\s+save\s+\$?[\d.]+%?\s+on\s+/i, ""));
          r.description = null;
          r.savings = GD.clean(save);
          r.image_url = GD.img(li);
          r.expires_on = GD.expiry(exp);
          out.push(r);
        });
        return { rows: out, warnings: warn };
      },
      advance: function () { return true; }   /* caller must send REAL scroll ticks */
    },

    /* ------------------------------------------------------------- Albertsons */
    albertsons: {
      /* /foru redirects here; same card markup as Vons (shared platform).
         Verified live 2026-08-28: 378 cards -> 347 unique rows. */
      url: "https://www.albertsons.com/loyalty/coupons-deals",
      store: "Albertsons", transfer: "either", scroll: "none", maxRounds: 40, expect: [250, 450],
      extract: function () { return window.GD_SCRAPERS.__albertsonsFamily("Albertsons", "https://www.albertsons.com/loyalty/coupons-deals"); },
      advance: function () { return window.GD_SCRAPERS.__loadMore(); }
    },

    /* ----------------------------------------------------------------- Ralphs */
    /* 2026-08-28: page loaded SIGNED OUT (header shows "Sign In") and the coupon grid
       does not render for guests - zero cards. Bill must sign in to ralphs.com in his
       own Chrome profile; until then this store yields nothing and the run should note
       "not logged in" and move on. Selectors below are best-known-guess from the last
       successful pull and are UNVERIFIED since - re-check them on the first logged-in
       run and update this comment. */
    ralphs: {
      url: "https://www.ralphs.com/savings/cl/coupons/",
      store: "Ralphs", transfer: "either", scroll: "js", maxRounds: 20, expect: [10, 200],
      requiresLogin: true,
      extract: function () {
        var out = [], warn = [];
        if (/sign in/i.test(document.body.innerText.slice(0, 400))) {
          warn.push("not logged in - Ralphs renders no coupons for guests");
          return { rows: out, warnings: warn };
        }
        var cards = document.querySelectorAll('[data-testid*="oupon"], [class*="CouponCard"], .kds-Card');
        if (!cards.length) warn.push("no Kroger coupon cards matched - re-inspect selectors");
        cards.forEach(function (c) {
          var t = GD.txt(c);
          if (!t || t.length < 6) return;
          var save = (t.match(/\$[\d.]+\s*off|\d+%\s*off|save\s*\$?[\d.]+%?|buy\s*\d+[^.]{0,25}(?:free|save)/i) || [])[0];
          var item = GD.txt(c, "[data-testid*='brand'], h2, h3, h4") || t.replace(save || "", "").slice(0, 90);
          if (!item) return;
          var r = base("Ralphs", "https://www.ralphs.com/savings/cl/coupons/");
          r.item = GD.clean(item); r.description = null; r.savings = GD.clean(save);
          r.image_url = GD.img(c); r.expires_on = GD.expiry(t);
          out.push(r);
        });
        return { rows: out, warnings: warn };
      },
      advance: function () { window.scrollBy(0, Math.round(window.innerHeight * 0.85)); return true; }
    }
  };

  /* weekly-ad pages, best effort, same 11 stores the app tracks */
  var GD_WEEKLY_ADS = {
    "Albertsons": "https://www.albertsons.com/weeklyad",
    "Vons": "https://www.vons.com/weeklyad",
    "Ralphs": "https://www.ralphs.com/weeklyad",
    "Stater Bros": "https://www.staterbros.com/weeklyad/flyerview",
    "CVS": "https://www.cvs.com/weeklyad/pageview",
    "Walgreens": "https://www.walgreens.com/offers/offers.jsp",
    "Smart & Final": "https://www.smartandfinal.com/circular",
    "Sprouts Farmers Market": "https://www.sprouts.com/weekly-ad/",
    "Grocery Outlet": "https://www.groceryoutlet.com/circulars",
    "WinCo": "https://www.wincofoods.com/weekly-ad",
    "Walmart": "https://www.walmart.com/"
  };

  window.GD = GD;
  window.GD_SCRAPERS = GD_SCRAPERS;
  window.GD_WEEKLY_ADS = GD_WEEKLY_ADS;
})();
