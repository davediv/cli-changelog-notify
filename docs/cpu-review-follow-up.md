# Workers CPU review and implementation checklist

Reviewed 2026-09-15 against commit `9a98bc5`. This report follows the earlier
[cpu-optimization-report.md](cpu-optimization-report.md); its older production
measurements are historical evidence, not measurements from this review.

## Summary

This repository is a release notifier running every 15 minutes. The expensive
path is the scheduled check and authorized `/check` requests. Ordinary HTTP
requests return a short text response. The main remaining CPU hotspot is parsing
large GitHub release responses even when nothing changed.

The baseline passes all 19 Node tests. Production deployment and CPU metrics
must be verified separately; local parsing measurements are not Workers billing
measurements. No application behavior, notification ordering, retry policy, or
polling interval should change during these optimizations.

## Findings

### Unconditional GitHub JSON parsing

`fetchGitHubReleasesPage` in [src/index.ts](../src/index.ts) fetches and parses all
release fields, including unused asset metadata. Only `tag_name`, `body`, `draft`,
and `prerelease` are needed.

Fresh public first-page measurements (30 releases, Node 26 ARM64, average process
CPU over 30 JSON parses after five warmups):

| Source     | Full JSON bytes | Used fields bytes | JSON parse CPU |
| ---------- | --------------: | ----------------: | -------------: |
| Codex      |       7,839,052 |            41,202 |       12.85 ms |
| Gemini CLI |         221,645 |            21,304 |        0.67 ms |

These numbers exclude network wait and response decoding. Approximately 99.5%
of Codex response bytes are irrelevant to this application. Both public endpoints
returned 304 when revalidated with their ETags during the review.

### Occasional full-history scans

`fetchGitHubEntries` already stops at the checkpoint. Its fallback fetches 100
releases after fetching 30, re-reading the first 30. A missing or old checkpoint
can still require the entire history. Failed notifications retain the checkpoint,
so the same backlog may be fetched again. Hard page caps and latest-release-only
queries would change behavior and are unsuitable.

### Claude ETag is not refreshed on unchanged versions

`processProduct` returns when the latest version equals the checkpoint without
saving a new ETag. Existing checkpoints without metadata and edits to release
notes therefore cause repeated body downloads until a version advances. Both
cases were reproduced with two checks: zero writes, and missing/stale validators
on both requests. The changelog parser already stops at the checkpoint.

## Prioritized action plan

Checkboxes mean implemented and validated, or explicitly verified for retention.
Pending conditional work stays unchecked, with the reason recorded below.
Each implementation commit must include its checklist update and validation.

### High impact / Low effort

- [x] **1. Verify production includes the existing optimizations.** Inspect the active
      deployment before recommending rollout. Existing bounded GitHub pagination,
      Claude conditional requests, and bounded parsing are already in this checkout.
- [x] **2. Add GitHub first-page conditional requests.** Store the ETag with the
      successfully processed checkpoint and exact request identity. Only permit
      the 304 shortcut when the first page contains the checkpoint. Never save a
      validator over failed notifications; never let a first-page 304 hide an
      unresolved backlog. Handle 304 before `response.ok`.
- [x] **3. Refresh Claude's ETag when the version is unchanged.** Write metadata
      only if the returned validator differs, retaining the same version and
      existing failure/retry semantics.

### High impact / Medium–High effort

- [ ] **4. Reduce payloads at the source.** Evaluate GraphQL field selection;
      only implement if REST ordering, filtering, missing-checkpoint behavior,
      authentication availability, and pagination can be preserved. Approximately
      190x smaller Codex data is a payload opportunity, not a promised CPU speedup.
- [ ] **5. Optimize repeated backlog scans if production shows they are frequent.**
      Consider revalidated compact page caching that preserves REST order and
      retries. Do not advance checkpoints simply to reduce work. Cache complexity
      needs evidence of frequent fallback or failed-backlog runs.

### Low impact

- [ ] **6. Eliminate overlapping pagination if justified.** Compare fixed small
      pages with the existing 30/100 strategy, including full-history request count.
      Preserve ordering and the complete missing-checkpoint scan.
- [ ] **7. Optimize allocations and routine logging only with profile evidence.**
      Formatting occurs only on notifications; no production dependencies or
      rendering framework exist. Avoid speculative micro-optimizations.
- [x] **8. Retain and verify `/check` protection and CPU limit.** Existing bearer
      authentication and the five-second limit control excess work. Lowering the
      limit does not make successful checks cheaper.

## Validation and rollout

- [x] Establish repeatable lint, format, type, test, and Worker build checks.
- [x] Validate each implementation and commit it separately.
- [ ] After rollout, compare CPU by unchanged check, new release, backlog, and
      upstream error. Track 304 rate, pages fetched, checkpoint progress, and
      notification outcomes. A low-cost failed run is not a successful optimization.

Do not substitute wall-clock latency for CPU. Parallelizing requests mostly
reduces waiting and may increase peak memory; network/KV waits are not CPU time.

## References

- [Cloudflare CPU definition](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
- [Cloudflare CPU profiling](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/)
- [GitHub conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests)

## Implementation log

Implementation results, validation, and any evidence-based deferrals are recorded
here as the checklist is processed.

### Validation tooling

Added pinned ESLint/TypeScript linting and Prettier, plus `npm run validate`.
Worker type checking is explicitly scoped to `src` and generated Worker types;
Node test files are linted and executed by `npm test`, not type-checked against
the Worker runtime. Removed one unnecessary regex escape flagged by ESLint.
Validation: lint, format, Worker type check, 19 tests, and dry-run bundle.

### Fix 2 — GitHub first-page revalidation

Stores a validator with each successful checkpoint when the next checkpoint is
in the first page. Request identity includes URL, representation headers, and a
SHA-256 credential fingerprint (never the token). Changed credentials/repositories
force a full response. Failed notifications do not change the validator. A first
page with only prereleases cannot authorize a 304 shortcut for later stable releases.

Validation: all 25 tests pass, including unchanged/seeded checkpoints for both
products, edited notes, credential/repository changes, notification retries,
prerelease-only first pages, and unexpected 304s. ESLint, Prettier, Worker type
checking, and Wrangler dry-run bundle all pass.

### Fix 3 — Claude validator refresh

When the latest version matches the checkpoint, save a missing or changed ETag
once. Further 304 responses and unchanged ETags perform no KV writes. Notification
failures retain their old checkpoint and ETag.

Validation: all 27 tests pass, including missing metadata, edited notes, no
notifications on an unchanged version, and no redundant writes. ESLint, Prettier,
Worker type checking, and Wrangler dry-run bundle all pass.

### Production verification — recommendations 1 and 8

Read-only Cloudflare verification found active version
`80291c31-97af-4663-b145-8da8d30779d0`, deployed 2026-09-15 at 12:15:21 UTC.
Downloaded deployed source confirms bounded GitHub pagination, Claude conditional
requests, checkpoint-bounded changelog parsing, and CHECK_TOKEN protection. Version
metadata confirms the five-second CPU limit. It does not include the new GitHub
conditional-request fix. Both controls remain intact locally; the authentication
regression test passes and Wrangler validates the CPU configuration.

Scheduled analytics after that deployment returned 212.509 ms, 298.537 ms,
5.142 ms, and 5.712 ms of CPU at 12:15, 12:30, 12:45, and 13:00 UTC respectively.
A read-only live tail at 13:15:26 UTC showed 5 ms CPU and 608 ms wall time, but
both Codex and Gemini checks failed with HTTP 403. The overall event outcome was
`ok` because per-product errors are caught. Therefore neither event outcome nor
low CPU alone establishes a successful optimization. Secret names confirm no
GITHUB_TOKEN is configured; HTTP 403 alone does not prove rate limiting.

Read-only KV checks found `2.1.272`, `python-v0.154.0`, and `v0.59.0` for Claude,
Codex, and Gemini respectively. The old report's stuck Codex checkpoint is no
longer the production checkpoint. No secrets, checkpoints, or deployments were
changed during this implementation.

### Remaining conditional recommendations — assessed, not implemented

- **4 — source field selection:** Production has no GITHUB_TOKEN, which GraphQL
  requires. The previous report also records differing REST/GraphQL ordering.
  Current work does not establish an equivalent order, so switching APIs would
  violate the requirement to preserve release selection. Retain REST; revisit
  only with authenticated parity fixtures covering ordering and missed releases.
- **5 — backlog caching:** Current evidence establishes GitHub HTTP failures,
  not frequent successful full-history scans. The historical stuck checkpoint has
  advanced. Additional persistent page caching would add KV operations and cache
  invalidation complexity. Leave pending until successful-run page counts justify it.
- **6 — overlapping pagination:** A fixed 30-release page removes overlap, but
  increases full-history requests. For a missing checkpoint in a 1,080-release
  history, the current strategy uses 12 requests and reads 1,110 release records;
  fixed 30-release pages use 37 requests (including the terminal empty page) and
  read 1,080 records. This is a request-count model, not a byte or CPU measurement.
  Given current GitHub failures and no frequency evidence for near-page-boundary
  backlogs, retain the existing strategy. Do not trade a small fallback CPU saving
  for substantially more API requests without measurements.
- **7 — allocations/logging:** No CPU profile identifies these as material costs.
  Logs proved necessary to distinguish failures from successful cheap checks.
  Keep them and the existing notification formatting behavior.

The operational follow-up is to investigate the GitHub 403 responses and provision
appropriate GitHub authentication if needed, then compare successful checks after
rollout. This is distinct from the implemented CPU fixes and remains outstanding.

### Local before/after validation

Compared baseline `9a98bc5` with the completed code using the same current Codex
first-page payload (7,839,052 bytes), a checkpoint at the newest stable release,
five warmups, and 30 measured `processProduct` calls in Node 26 ARM64. The fetch
stub exposes the real JSON through `json()` for 200 responses and returns 304
when the saved ETag matches. Network and response decoding are excluded.

| Implementation               | Mean process CPU/check | JSON parses in 30 checks | KV writes after warmup |
| ---------------------------- | ---------------------: | -----------------------: | ---------------------: |
| Baseline                     |              12.916 ms |                       30 |                      0 |
| New code, unchanged response |               0.030 ms |                        0 |                      0 |

This validates that unchanged checks avoid parsing; it is not a production CPU
or billing forecast. Savings depend on the real 304 rate. Changed responses still
need the existing JSON processing and pagination.

Commits: `e18672c` saves this report, `b0a08aa` adds validation tooling,
`50e4ddc` implements GitHub revalidation, and `5de19f3` fixes Claude ETag refresh.
Every code commit passed its complete validation suite before commit. Rollout and
post-rollout CPU validation remain unchecked because these changes have not been
deployed in this task.
