# Audit fix verification — 21 October 2026

Prepared on `fix/audit-security-and-navigation` from main commit `e214b0226d6b88647c2ad76ad97b2a7bfe9dcfe2`. These changes have not been merged, deployed to GitHub Pages, or applied to production Supabase.

| Finding | Change | Verification and remaining work |
| --- | --- | --- |
| Single-use link redeemed twice | Transactional redemption consumes the code and merges ownership under one database lock. Issuance uses the same lock and resolves the current owner during concurrent merges. | Separate PostgreSQL sessions produced exactly one successful redeemer. Rollback, merge, issuance concurrency, expiration and role permissions passed. Deploy both RPCs before the Edge Function. |
| Arbitrary notification destinations | Allow only known browser push provider hosts over HTTPS; reject credentials, ports, fragments, IPs and malformed keys. Revalidate old subscriptions before delivery; bound request time. | Handler tests reject unsafe destinations and retain valid provider subscriptions. Delivery is mocked; real browser push delivery needs a controlled smoke test. The pinned push library does not follow redirects. |
| Explore focus escape | Make underlying page roots inert while Explore is open, preserving overlapping About coverage and prior inert state. | DOM contract tests pass. Real browser Tab/Shift+Tab and nested overlay interaction remain unverified. |
| Wrong section after reload | Keep tab selection, address, saved preference and history navigation aligned. | DOM route/reload/history checks pass; browser retest remains. |
| Misleading tracking status | Show distinct tracked, paused and untracked descriptions; disclose local recents and shared cache. | All three DOM copy checks pass. |
| Cramped 320px comparison | Use two rows of category buttons and separate labels from wrapping values on narrow screens. | CSS reviewed; visual verification at 320px, 390px and desktop remains. |
| Missing CSP/framing protection | Extract script to `app.js`, remove inline event handlers, restrict resource sources, and refuse framed initialization. Install/cache the entire shell together. | Syntax, DOM frame guard and service-worker contract checks pass. Actual CSP enforcement and PWA lifecycle need browser verification. A real anti-framing header is still required from a host/proxy with header control; GitHub Pages cannot configure it in this repository. |
| Slow cached lookups | Run independent cache/profile reads concurrently, finish usage counters with `waitUntil`, and expose identifier-free stage timings. | Dependency/lifetime tests pass. Read-only production profiling supports request overhead as a contributor. No production speedup is claimed; a regional comparison stopped on its first connection failure, with zero samples. |

## Passed automated checks

- Existing server suites: security 38, limits 35, Explore 32.
- New server audit regression suite: 29 assertions, including both linking races, failure handling and endpoint validation.
- Actual PostgreSQL 18.4: 17 checks using separate local database sessions. This used disposable fixture tables with RLS and the exact migration file, not production data. The local database server was stopped afterward.
- Frontend DOM contract suite: 13 checks. This uses a minimal DOM model, not a browser engine.
- Performance lifecycle suite: parallel reads, retained background counters, timing headers.
- Service-worker suite: failed shell install rejection, complete shell inclusion, consistent cached files and preservation of unrelated caches.
- JavaScript syntax and Git whitespace checks.

## Release blockers and access

The browser automation connection closed before the updated preview could be inspected. No new desktop/mobile screenshots, browser keyboard passes, or live CSP/PWA passes are claimed. Follow the concrete browser checklist in [DEPLOYMENT.md](DEPLOYMENT.md).

The connected GitHub integration rejected branch creation with HTTP 403, `Resource not accessible by integration`. The workspace's Git credential manager also had no usable noninteractive sign-in. No remote review branch or pull request was created. Publishing requires repository Contents write access; creating the review request also requires Pull requests write access. No production deployment was attempted.

See [DEPLOYMENT.md](DEPLOYMENT.md) for migration/deployment order, rollback implications, hosting headers, profiling context and reproducible test commands.
