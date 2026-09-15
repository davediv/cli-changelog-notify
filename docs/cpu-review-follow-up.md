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

- [ ] **1. Verify production includes the existing optimizations.** Inspect the active
      deployment before recommending rollout. Existing bounded GitHub pagination,
      Claude conditional requests, and bounded parsing are already in this checkout.
- [x] **2. Add GitHub first-page conditional requests.** Store the ETag with the
      successfully processed checkpoint and exact request identity. Only permit
      the 304 shortcut when the first page contains the checkpoint. Never save a
      validator over failed notifications; never let a first-page 304 hide an
      unresolved backlog. Handle 304 before `response.ok`.
- [ ] **3. Refresh Claude's ETag when the version is unchanged.** Write metadata
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
- [ ] **8. Retain and verify `/check` protection and CPU limit.** Existing bearer
      authentication and the five-second limit control excess work. Lowering the
      limit does not make successful checks cheaper.

## Validation and rollout

- [x] Establish repeatable lint, format, type, test, and Worker build checks.
- [ ] Validate each implementation and commit it separately.
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
