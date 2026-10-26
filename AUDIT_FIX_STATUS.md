# Audit fix verification — 26 October 2026

Branch `fix/audit-security-and-navigation`, based on main `e214b0226d6b88647c2ad76ad97b2a7bfe9dcfe2`. The original fixes were prepared on 21 October 2026 (commit `68a2f0b`). This file records an independent re-review and re-test on 26 October 2026. Nothing on this branch has been merged, published to GitHub Pages, or applied to production Supabase.

## State checked before review (26 October)

- `origin/main` was still `e214b02`, so no newer work needed merging. The handoff patch, Git bundle and source archive contained the same changes (the archive differed only in CRLF line endings).
- The deployed `brawl` Edge Function (version 21, `verify_jwt=false`) was byte-identical to `supabase/functions/brawl/index.ts` on main.
- Production had 15 migrations, the last being `explore_cache_usage_claim_slot`. Neither `redeem_device_link` nor `create_device_link` existed. `device_keys` and `device_links` matched the columns the migration expects, and all public tables had RLS enabled.
- The one stored push subscription used `web.push.apple.com` with well-formed keys, so it passes the new validation.

## Changes made during re-review

- **Push endpoints must already be canonical.** The 21 October version stored `new URL(endpoint).href`, while `push_prefs`, `push_unsubscribe` and `push_test` match the raw endpoint the device sends. Any endpoint that URL parsing changes (for example an uppercase host) would have been saved but could never be updated or removed. Such endpoints are now rejected. 6 assertions were added to `tests/fn_audit.js`.
- **Long player names wrap in the head-to-head header at ≤420px**, instead of being cut off with an ellipsis.
- **The service-worker cache is now `brawl-stats-v3`** because a shell file (`index.html`) changed again. `tests/sw_release.js` was updated to match.

## Findings

| # | Finding | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Single-use link redeemed twice | **Pass (local)**; production pending | Real PostgreSQL 16.15, separate sessions: 17/17. Handler tests: 35/35 audit checks. Not yet applied in production. |
| 2 | Arbitrary notification destinations | **Pass (handler)**; real delivery **blocked** | Unsafe or non-canonical endpoints and malformed keys are rejected. Stored legacy subscriptions are revalidated, and requests time out after 10s (`web-push@3.6.7` supports `timeout`). No real push was sent: that needs controlled devices and the deployed function. |
| 3 | Explore focus escape | **Pass (browser, local preview)** | At 1440/390/320, 60 Tab and 60 Shift+Tab presses stayed inside Explore. Privacy over Explore kept focus inside. Escape closed Privacy, then Explore, with inert state restored. |
| 4 | Wrong section after reload | **Pass (browser, local preview)** | Club → Me → reload → Back → Forward kept the visible section and URL in step at all three sizes. |
| 5 | Misleading tracking status | **Pass (browser, local preview)** | Tracked, paused and untracked lookups each showed their own message. |
| 6 | Cramped 320px comparison | **Pass (browser, local preview)** | At ≤420px the four categories sit in 2 rows (1 row at 1440). No value is clipped or overflows in any category at 320, 390 or 1440, including the long-name case. |
| 7 | Missing CSP/framing protection | **Pass for CSP and the JS guard; header protection blocked** | CSP blocked inline scripts, inline handlers, eval, and foreign fetch, script and frame loads. Normal use caused no violations, and a framed copy refused to start. A real `frame-ancestors`/`X-Frame-Options` header needs a host or proxy with header control. |
| 8 | Slow cached lookups | **Pass (logic)**; speedup **not measured** | Parallel reads, background counters and `Server-Timing` pass `fn_performance.js`. Production has had no Explore lookups since 21 October (usage counters show 28 lookups in total, 3 cache hits). This environment cannot reach the live function, and the updated function is not deployed, so no fresh-versus-cached timings exist yet. |

## Automated checks (26 October)

- `fn_security.js` 38/38, `fn_limits.js` 35/35, `fn_explore.js` 32/32, `fn_audit.js` 35/35 (29 earlier plus 6 new), `fn_performance.js` pass.
- `frontend_audit.js` 13/13 and `sw_release.js` pass.
- `node --check app.js`, `node --check sw.js` and `git diff --check` are clean.
- `tests/db_link.js` 17/17 ran against a new, empty local PostgreSQL 16.15 cluster on port 55439. It did not touch production.

## Browser checks (local preview, Chromium via Playwright)

The Pages site, Supabase and the art CDNs are blocked by this environment's network policy. The branch was therefore served locally over HTTPS, and Supabase was replaced with a read-only snapshot of public tables plus stubbed Explore responses. Server write actions were refused by the stub, and none were attempted. These checks cover layout, keyboard behaviour, CSP and the service worker. They do not cover live backend behaviour.

- Navigation, keyboard, status and comparison checks: 69/69 across 1440×900, 390×844 and 320×740.
- Lifecycle, CSP, image and welcome checks: 15/15.
  - The full shell, including `app.js`, installs together and works offline.
  - When the next release is published, an open tab keeps the old release; reloading it does not mix old and new files. The new release activates with its own `app.js` once the tabs close.
  - Upgrading from main's v1 worker works online and offline.
  - The welcome screen and 4-step tour complete.
  - Failed game art leaves no broken images.
  - No console errors occurred.
- Frame guard: a cross-origin frame shows only "Open Brawl Stats in its own tab".

Observations, not failures:
- Pressing browser Back while Privacy is open over Explore closes Explore underneath and leaves Privacy open. After Privacy closes, nothing is left inert.
- During the v1 → v3 upgrade, a tab that stays open can receive the new HTML from the old worker. When offline, it then loads `app.js` from the browser's HTTP cache (Pages sends `max-age=600`). An offline reload of such a long-lived tab more than about 10 minutes after the upgrade could fail until the tab is closed. Once the tabs close, v3 serves a complete, consistent shell.

## Remaining limitations

- **The framing header is not deployed.** See DEPLOYMENT.md for the proposed proxy.
- **Real push delivery is unverified.** It needs controlled test devices after deployment.
- **Production performance is unmeasured.** Profile after deployment as described in DEPLOYMENT.md. Region pinning is not enabled.
- **One pre-existing race is outside this fix.** A goal, alert or tracking-slot write that resolves the device owner just before a concurrent merge can still be saved under the former owner. The link RPCs fix issuance and redemption only.
- **Shell updates now ship only when the cache name changes.** The service worker no longer revalidates shell files, so any later change to `index.html`, `app.js`, fonts or icons must bump `CACHE` in `sw.js`. Otherwise installed clients keep the old release.
