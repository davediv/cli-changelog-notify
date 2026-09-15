# Workers CPU analysis and optimization plan

Analyzed 2026-09-15 for the production Worker `claudecode-changelog-notify`, which runs commit `fd2c500` (deployed 2026-04-01).

## Summary

About 95% of this Worker's CPU goes to one function. Every 15 minutes it downloads and parses the entire GitHub Releases history of `openai/codex` (11 pages, 155 MB of JSON) and `google-gemini/gemini-cli` (6.3 MB), only to read the newest few releases. Stopping once the last-seen release is reached gave identical results in every test case, and should cut a heavy run from about 1 s of CPU to roughly 50 ms (estimate).

- **Make sure your checkout is current.** Production runs `fd2c500`, which is `main` on both `davediv/claudecode-changelog-notify` and `davediv/claudecode-codex-gemini-changelog-notify`. Anything older is the Claude-only Worker.
- **This Worker isn't the account's big CPU cost.** It's a cron job rather than a website: about 97 runs a day and almost no HTTP traffic. In the 7 days to 2026-09-15 it used 471 s of CPU, about 2% of the account and at most ~$0.04/month at Standard pricing. `steamrev` (46%), `playrev-web` (33%) and `playrev-api` (15%) use most of it.
- **Per run, though, it's very heavy for what it does:** ~650 ms of CPU on average.

## What production shows

Cloudflare analytics for the 30 days to 2026-09-15:

| Metric      | Value                                                                     |
| ----------- | ------------------------------------------------------------------------- |
| CPU per run | ~650 ms average. ~0.7–1.6 s when GitHub answers, ~5–20 ms when it doesn't |
| Memory, p99 | 100–148 MB; over the 128 MB per-isolate limit on 11 of 30 days            |
| Secrets     | Telegram only, no `GITHUB_TOKEN`                                          |

The two very different run costs fit GitHub rate limiting. A full run makes 18 unauthenticated GitHub requests (72 an hour), and GitHub allows 60 an hour per IP. Runs that get rate-limited fail early and are cheap; the rest parse everything. You can confirm by searching Workers Logs for `Failed to fetch GitHub releases`.

## Causes, ranked

1. **Every run pages through all GitHub releases** (`fetchGitHubEntries`).
   - Codex has 1,080 releases, and 98% of the bytes are their `assets` lists.
   - Locally that's 375 ms of JSON parsing plus 74 ms of decompression per run.
   - It holds 26 MB pages in memory, which is also why memory sits at the limit.
2. **Every run re-downloads and fully parses `CHANGELOG.md`** (`fetchClaudeEntries` → `parseChangelog`).
   - The file is 692 KB, up about 10× since January 2026.
   - The parser splits 6,783 lines and builds all 395 version entries, just to read a version number that ends at byte 23.
   - That's about 5 ms locally, which is most of a cheap run, and it grows with every release.
3. **Minor:** one extra KV read per run for a finished legacy migration (`migrateLegacyClaudeCheckpoint`), and a public `/check` route that runs a full check on every hit.

Ruled out: startup and bundle size (one 13 KB file, no dependencies), message formatting (only runs when there's a release), and network wait time (not counted as CPU).

Local numbers come from Node 26 on an Apple Silicon Mac, run against real payloads. Production is roughly 2× slower (a full run is ~470 ms locally and ~1 s in production), so compare them as ratios.

## Action plan

### Before deploying anything

- [x] **P0. Fix the Worker name.** `wrangler.jsonc` names the Worker `claudecode-codex-gemini-changelog-notify`, but production is `claudecode-changelog-notify`. Running `npm run deploy` would create a second Worker on the same KV namespace and cron: double the CPU and duplicate notifications.

> Don't deploy a checkout older than `fd2c500`. It would remove Codex and Gemini CLI monitoring, and the old code reads the legacy `last_seen_version` key (unchanged since April 2026), so it would likely re-send every Claude Code release since then.

### High impact / Low effort (do these first)

- [x] **1. Stop paging GitHub once the last-seen release is found, starting with a 30-release first page.**

  Read the checkpoint in `processProduct` before fetching. Then move the existing request and checks into a `fetchReleasesPage` helper and loop like this:

  ```ts
  // True once we have what processProduct reads: the newest stable release and, if set, the last seen one
  const collect = (pageReleases: GitHubRelease[]) => {
  	const stableEntries = filterStableReleases(pageReleases).map(toVersionEntry);
  	releases.push(...stableEntries);
  	return lastSeenVersion ? stableEntries.some((e) => e.version === lastSeenVersion) : releases.length > 0;
  };

  const firstPage = await fetchReleasesPage(product, env, fetchFn, 1, GITHUB_FIRST_PAGE_SIZE); // 30
  if (collect(firstPage) || firstPage.length < GITHUB_FIRST_PAGE_SIZE) return releases;

  for (let page = 1; ; page += 1) {
  	const pageReleases = await fetchReleasesPage(product, env, fetchFn, page, GITHUB_RELEASES_PER_PAGE);
  	// Page 1 repeats the releases already read from the first page
  	const unread = page === 1 ? pageReleases.slice(GITHUB_FIRST_PAGE_SIZE) : pageReleases;
  	if (collect(unread) || pageReleases.length < GITHUB_RELEASES_PER_PAGE) return releases;
  }
  ```

  | Per run           | Today                | After               |
  | ----------------- | -------------------- | ------------------- |
  | Codex             | 11 requests / 155 MB | 1 request / 7.5 MB  |
  | Gemini CLI        | 7 requests / 6.3 MB  | 1 request / 0.21 MB |
  | Local CPU (Codex) | ~450 ms              | ~19 ms              |
  - **Behavior:** the latest version, the list of new versions and the message text matched the deployed code in 45,860 synthetic cases and on the real Codex and Gemini CLI histories. The one difference: if the last-seen release is deleted from GitHub, that run makes one extra request.
  - **Why 30:** Codex's newest stable release is 11th in the list, behind alpha releases. A 10-release first page misses it and ends up downloading 28.6 MB. A 20-release page is smaller (4.9 MB) but needs a second 26 MB page whenever 5 or more releases land between checks.
  - **Side benefit:** 2 GitHub requests per run instead of 18 stays under the rate limit, so the Codex and Gemini CLI checks stop failing silently.

- [x] **2. Only download `CHANGELOG.md` when it has changed.** raw.githubusercontent.com returns an empty `304` for a matching `If-None-Match`.
  - Read the checkpoint with `getWithMetadata`, which is still one KV read.
  - Send the stored ETag. On a `304`, return "no new updates" without reading the body. Check for 304 before the `!response.ok` throw, because a 304 isn't `ok`.
  - Store the ETag as metadata in the same `KV.put` that saves the version. If notifications fail, the ETag isn't saved, so the next run still retries, as it does today.
  - Saves about 5 ms per run, roughly a fifth of what's left after #1.

### High impact / Medium–High effort

- [ ] **3. Ask GitHub's GraphQL API for only the fields you use** (`tagName`, `isPrerelease`, `isDraft`, `description`).
  - 20 releases come to 25 KB instead of 7.5 MB, and the Codex parse drops from ~15 ms to ~0.03 ms.
  - It needs a `GITHUB_TOKEN`; GraphQL doesn't accept anonymous requests.
  - It changes behavior. GraphQL's order matched the REST order for only the first 2 Codex and 7 Gemini CLI releases (the REST list isn't sorted by time either), so which releases count as "new" could change. Ship it only with a comparison test and sign-off.

### Low impact

- [x] **4. Parse the changelog only down to the last-seen version.** Cold parse goes from 2.5 ms to 0.24 ms, with identical output on 1,037 cases, and the cost stops growing with the file. After #2 this only runs when the changelog actually changes.
- [x] **5. Protect `/check`** with a secret header, or set `workers_dev: false` if you don't use it. It got one request in 30 days, but each hit runs a full check and uses GitHub quota.
- [ ] **6. Remove `migrateLegacyClaudeCheckpoint` from every run.** The migration finished in April 2026. It saves a KV read per run; update the legacy-migration test too.
- [ ] **7. Add `GITHUB_TOKEN` only after #1 is deployed.** It improves reliability, not CPU. Added before #1, it would make every run a ~1 s run.
- [ ] **8. Add a CPU safety limit** such as `"limits": { "cpu_ms": 5000 }`, which leaves room for a rare full-history run.

### After deploying

- [ ] CPU per run drops to tens of milliseconds (Workers Metrics, or `workersInvocationsScheduled.cpuTimeUs` in GraphQL Analytics).
- [ ] Memory p99 stays well under 128 MB.
- [ ] Each run makes about 3 subrequests.
