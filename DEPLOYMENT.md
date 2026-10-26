# Audit fix release

The frontend and the Supabase backend have separate deployment steps. Applying the SQL alone does not change the old Edge Function's link redemption behavior.

## Order

1. Review this branch. Browser checks at 1440x900, 390x844 and 320x740 passed against a local preview on 26 October 2026 (see AUDIT_FIX_STATUS.md). Repeat the checks below on the published site after step 4.
2. Confirm the target project is `iuukdskmzjglpvtlwldw`, then apply `supabase/migrations/20261021090000_redeem_device_link.sql` as a migration. Do not run `supabase/schema.sql`: it is a full reference, not a repeatable migration. This adds the issuance and redemption functions; it does not migrate existing rows on installation. Both functions are callable only by `service_role` and run with the caller's privileges. They share a transaction lock so issuance resolves the current owner even during a merge.
3. Deploy the updated `supabase/functions/brawl/index.ts`. Preserve the project's existing `verify_jwt` setting and secrets. The inspected project used `verify_jwt=false` with application device-secret checks; this release does not change that authentication model. Link redemption intentionally fails closed if the RPC is missing.
4. Merge/publish the frontend with **both** `index.html` and `app.js`, plus `sw.js`. Do not publish the extracted HTML alone. The new worker installs the complete shell and waits for old tabs to close. Bump `CACHE` in `sw.js` (currently `brawl-stats-v5`) whenever a shell file changes. The worker no longer revalidates shell files in the background, so a shell change without a new cache name never reaches installed clients.
5. Verify ordinary lookups, tracked-history navigation, and device linking with controlled test devices. Confirm anonymous/authenticated roles cannot execute either link RPC and confirm the existing private-table RLS remains in place. Do not use real users' link codes for concurrency testing.

Keep the old Edge Function source for rollback. Reverting the Edge Function reintroduces the old linking race; prefer disabling the link UI/action temporarily if a rollback is necessary. The additive RPCs can remain in the database while investigating.

## Browser checks before release

- Open a tracked player, navigate Club -> Me, reload, then Back/Forward. The visible section and URL must agree.
- Open Explore above stats. Tab and Shift+Tab must not reach controls underneath. Open Privacy, close it, then close Explore. Check Escape and browser Back too, including Back while Privacy is open.
- Test tracked, paused and untracked player pages. The hero must describe the corresponding state and disclose local recents/server caching.
- At 320px, all four comparison categories should occupy two rows, and numerical values should wrap rather than truncate. Check Recent and Records, long player names, and 390px/desktop views.
- Check image loading/error fallbacks, welcome/tour, console CSP errors and the installed PWA's update/offline behavior. Node DOM tests cannot verify browser layout, tab order, CSP enforcement or the actual service-worker lifecycle.

## Framing headers

The HTML includes a restrictive script/resource CSP and no inline event handlers. Inline styles remain allowed for the existing charts and generated UI. A JavaScript guard refuses to initialize inside frames as defense in depth.

**A real framing restriction still requires a hosting response header.** GitHub Pages does not provide repository-configurable response headers; adding `frame-ancestors` to a CSP meta tag does not enforce it. When the site is served by a host or reverse proxy with header control, configure:

```http
Content-Security-Policy: frame-ancestors 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

The header CSP adds framing protection alongside the resource policy in the HTML. Confirm it on the final public HTML response. A hosting move or custom-domain proxy is a separate deployment decision; this branch does not perform one.

Proposed option (needs approval before any DNS or hosting change): put a custom domain in front of the site with Cloudflare (free plan). Proxy it to GitHub Pages and add the four headers above with a Response Header Transform Rule. Pages keeps building from this repository, so the deploy flow stays the same. Then update `vapid().subject` and any links that use the github.io address. Another option is to move the static files to Cloudflare Pages or Netlify, with a `_headers` file in the repository. That changes where releases are published. In both cases the github.io address stays frameable unless it redirects to the new domain. [MDN: frame-ancestors and meta limitations](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors).

## Latency and diagnostics

Explore still applies its rate limit before expensive work. Cache lookup and tracked-profile lookup now run concurrently. Identifier-free usage counters run under `EdgeRuntime.waitUntil` after the response is ready (awaited on runtimes without that API). `Server-Timing` exposes `rate`, `lookup`, `profile` and `app` durations, without tags, device secrets or network identifiers. The `lookup` duration includes an upstream fetch on cache misses. Compare cache hits separately from fresh fetches.

Read-only Supabase profiling on 21 October 2026 found the database in Tokyo and invocations in other regions. Across the inspected 24-hour API logs, average origin times were about 422ms for rate calls, 319ms for usage counts, 163ms for cache calls and 176ms for profile calls. Database statement means were approximately 7.3ms, 2.1ms, 2.1ms and 0.8ms respectively. These aggregates cover different actions and are evidence of request overhead, not a measured before/after speedup for this release.

No production speedup is claimed until the updated function is deployed and measured. As of 26 October 2026, production had recorded no Explore lookups since 21 October (28 in total, 3 of them cache hits), so the logs do not provide a baseline.

After deployment, measure from a client:
1. Run about 20 fresh requests: `explore_player` for distinct valid tags that have not been looked up in the last 2 minutes. Each one shows `lookup` including an upstream fetch.
2. Run about 20 cached requests: repeat one tag within 2 minutes. The response has `source` = cache.
3. For each request, record the client's total time and the `Server-Timing` stages `rate`, `lookup`, `profile` and `app`.
4. Network overhead is the client total minus `app`. Server work is `app`. Report the median and p90 for each group, with sample counts.
5. Compare against the same procedure run on the old function only if a baseline was captured before deployment. Region pinning has not been enabled: compare representative clients before trading automatic regional failover for a forced location. [Supabase regional invocation](https://supabase.com/docs/guides/functions/regional-invocation), [background tasks](https://supabase.com/docs/guides/functions/background-tasks).

## Tests

Install `esbuild` for the server harness, then run:

```sh
node tests/fn_security.js supabase/functions/brawl/index.ts
node tests/fn_limits.js supabase/functions/brawl/index.ts
node tests/fn_explore.js supabase/functions/brawl/index.ts
node tests/fn_audit.js supabase/functions/brawl/index.ts
node tests/fn_performance.js supabase/functions/brawl/index.ts
node tests/frontend_audit.js
node tests/sw_release.js
```

The server harness substitutes database, game API and push transport. `fn_audit.js` checks handler integration and failure handling; it does not prove SQL concurrency. `frontend_audit.js` uses a minimal DOM model and leaves visual/keyboard-engine validation to the browser checks above.

For real PostgreSQL verification, use an empty disposable **local** database named `brawl_audit_test`, a superuser named `postgres`, and port 55439. The test creates fixture tables and roles and deliberately causes a failed transaction. Never run it against production. Set `PGTEST_PSQL` to the psql executable if not on PATH; optionally set `PGTEST_PORT`. Run `node tests/db_link.js`. It uses separate PostgreSQL sessions for competing redemptions and tests rollback, owner merges, expired/self codes and role permissions.
