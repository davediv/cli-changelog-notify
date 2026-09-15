import test from 'node:test';
import assert from 'node:assert/strict';

import {
	PRODUCTS_BY_ID,
	checkForUpdates,
	filterStableReleases,
	formatVersionMessage,
	getKvKey,
	parseChangelog,
	processProduct,
} from '../src/index.ts';
import type { VersionEntry } from '../src/index.ts';

class MockKVNamespace {
	private readonly store = new Map<string, { value: string; metadata: unknown }>();

	constructor(initialValues: Record<string, string> = {}, initialMetadata: Record<string, unknown> = {}) {
		for (const [key, value] of Object.entries(initialValues)) {
			this.store.set(key, { value, metadata: initialMetadata[key] ?? null });
		}
	}

	async get(key: string): Promise<string | null> {
		return this.store.get(key)?.value ?? null;
	}

	async getWithMetadata(key: string): Promise<{ value: string | null; metadata: unknown; cacheStatus: null }> {
		const entry = this.store.get(key);
		return { value: entry?.value ?? null, metadata: entry?.metadata ?? null, cacheStatus: null };
	}

	async put(key: string, value: string, options: { metadata?: unknown } = {}): Promise<void> {
		this.store.set(key, { value, metadata: options.metadata ?? null });
	}
}

const noopLogger = {
	log() {},
	warn() {},
	error() {},
};

function createEnv(initialValues: Record<string, string> = {}, overrides: Record<string, string> = {}) {
	return {
		KV: new MockKVNamespace(initialValues),
		...overrides,
	};
}

function createRelease(
	tagName: string,
	body = `${tagName} release notes`,
	overrides: Partial<{
		draft: boolean;
		prerelease: boolean;
	}> = {},
) {
	return {
		tag_name: tagName,
		body,
		draft: false,
		prerelease: false,
		...overrides,
	};
}

// Serves the requested page of a releases list, like the GitHub API
function releasesPage(url: string, releases: unknown[]): unknown[] {
	const { searchParams } = new URL(url);
	const perPage = Number(searchParams.get('per_page'));
	const page = Number(searchParams.get('page'));
	return releases.slice((page - 1) * perPage, page * perPage);
}

function createFetchStub({
	claudeMarkdown,
	claudeEtag,
	codexReleases,
	geminiReleases,
	onRequest,
}: {
	claudeMarkdown: string;
	claudeEtag?: string;
	codexReleases: unknown[];
	geminiReleases: unknown[];
	onRequest?: (input: string | URL | Request, init?: RequestInit) => void;
}) {
	return async (input: string | URL | Request, init?: RequestInit) => {
		onRequest?.(input, init);

		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

		if (url.includes('anthropics/claude-code')) {
			// Answers conditional requests like raw.githubusercontent.com
			if (claudeEtag && new Headers(init?.headers).get('If-None-Match') === claudeEtag) {
				return new Response(null, { status: 304, headers: { ETag: claudeEtag } });
			}
			return new Response(claudeMarkdown, { status: 200, headers: claudeEtag ? { ETag: claudeEtag } : {} });
		}

		if (url.includes('/repos/openai/codex/releases')) {
			return new Response(JSON.stringify(releasesPage(url, codexReleases)), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('/repos/google-gemini/gemini-cli/releases')) {
			return new Response(JSON.stringify(releasesPage(url, geminiReleases)), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		throw new Error(`Unexpected fetch URL: ${url}`);
	};
}

test('parseChangelog extracts multiple Claude Code versions', () => {
	const entries = parseChangelog(`# Changelog

## 1.2.0
- Added feature A

## 1.1.0
- Fixed issue B
`);

	assert.deepEqual(entries, [
		{ version: '1.2.0', content: '- Added feature A' },
		{ version: '1.1.0', content: '- Fixed issue B' },
	]);
});

test('parseChangelog stops after the last seen version', () => {
	const markdown = '# Changelog\n\n## 1.3.0\n- C\n\n## 1.2.0\n- B\n\n## 1.1.0\n- A\n';

	assert.deepEqual(parseChangelog(markdown, '1.2.0'), [
		{ version: '1.3.0', content: '- C' },
		{ version: '1.2.0', content: '- B' },
	]);
});

// The line-by-line parser parseChangelog replaced, kept as the reference for its output
function referenceParseChangelog(markdown: string): VersionEntry[] {
	const entries: VersionEntry[] = [];
	let currentVersion: string | null = null;
	let currentContent: string[] = [];

	for (const line of markdown.split('\n')) {
		const versionMatch = line.match(/^## (\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/);
		if (versionMatch) {
			if (currentVersion) {
				entries.push({ version: currentVersion, content: currentContent.join('\n').trim() });
			}
			currentVersion = versionMatch[1];
			currentContent = [];
		} else if (currentVersion) {
			currentContent.push(line);
		}
	}

	if (currentVersion) {
		entries.push({ version: currentVersion, content: currentContent.join('\n').trim() });
	}

	return entries;
}

test('parseChangelog matches the line-by-line parser at every stopping point', () => {
	const samples = [
		'',
		'# Changelog\n\nNothing released yet\n',
		'## 1.2.3\n- a\n## 1.2.2\n- b',
		'# Changelog\n\n## 2.0.0\n- x\n\n## 1.0.0',
		'## 3.0\n## 2.0\n## 1.0\n',
		'# Changelog\r\n\r\n## 1.1.0\r\n- a\r\n- b\r\n\r\n## 1.0.0\r\n- c\r\n',
		'## 2.0.0-beta.1 (2026-01-01)\n- p\n## 1.9.9\n- q\n',
		'## Unreleased\n- u\n## 1.1\n- a\n## Notes\n- n\n## 1.0\n- b\n',
		'## 1.1\n- a\n## 1.0\n- b\n## 1.1\n- c\n## 0.9\n- d\n',
		'## 1.1\n```\n## 1.0.5 in code\n```\n## 1.0\n- b\n',
		'## 1.1\n  ## 1.0.5\n- a\n## 1.0\n',
		'## 1.1\n- a ## 1.0.5\n- b\r## 1.0.4\n## 1.0\n',
		'## 1.1\n   \n\t\n## 1.0\n  x  \n',
		'### 1.1\n## 1.0\n- a\n',
		'## 1.2.3.4 extra\n- a\n## 1.2abc\n- b\n',
	];

	for (const markdown of samples) {
		const expected = referenceParseChangelog(markdown);
		assert.deepEqual(parseChangelog(markdown), expected, JSON.stringify(markdown));

		for (const version of [...expected.map((entry) => entry.version), '0.0.0-missing']) {
			const stopIndex = expected.findIndex((entry) => entry.version === version);
			const expectedPrefix = stopIndex === -1 ? expected : expected.slice(0, stopIndex + 1);
			assert.deepEqual(parseChangelog(markdown, version), expectedPrefix, `${JSON.stringify(markdown)} stopping after ${version}`);
		}
	}
});

test('filterStableReleases excludes drafts and prereleases', () => {
	const releases = filterStableReleases([
		createRelease('v1.0.0'),
		createRelease('v1.1.0-rc1', 'preview', { prerelease: true }),
		createRelease('v1.2.0', 'draft', { draft: true }),
	]);

	assert.deepEqual(
		releases.map((release) => release.tag_name),
		['v1.0.0'],
	);
});

test('formatVersionMessage strips a leading v for display without changing stored tags', async () => {
	const env = createEnv({
		[getKvKey('codex')]: 'v1.2.2',
	});

	const notifications: string[] = [];

	await processProduct(PRODUCTS_BY_ID.codex, env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			claudeMarkdown: '## 1.0.0\n- Claude',
			codexReleases: [createRelease('v1.2.3', 'Codex notes'), createRelease('v1.2.2', 'Older notes')],
			geminiReleases: [createRelease('v0.1.0')],
		}),
		sendNotificationsFn: async (message) => {
			notifications.push(message);
			return true;
		},
	});

	assert.deepEqual(notifications, ['📦 Codex v1.2.3\n\nCodex notes']);
	assert.equal(await env.KV.get(getKvKey('codex')), 'v1.2.3');
	assert.equal(formatVersionMessage('Codex', { version: 'v9.9.9', content: 'Notes' }), '📦 Codex v9.9.9\n\nNotes');
});

test('first deployment seeds checkpoints without sending notifications', async () => {
	const env = createEnv();
	const notifications: string[] = [];

	await checkForUpdates(env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			claudeMarkdown: '## 1.2.0\n- Claude update',
			codexReleases: [createRelease('v2.0.0', 'Codex update')],
			geminiReleases: [createRelease('v3.0.0', 'Gemini update')],
		}),
		sendNotificationsFn: async (message) => {
			notifications.push(message);
			return true;
		},
	});

	assert.equal(await env.KV.get(getKvKey('claude-code')), '1.2.0');
	assert.equal(await env.KV.get(getKvKey('codex')), 'v2.0.0');
	assert.equal(await env.KV.get(getKvKey('gemini-cli')), 'v3.0.0');
	assert.deepEqual(notifications, []);
});

test('legacy Claude checkpoint migrates to the per-product key', async () => {
	const env = createEnv({
		last_seen_version: '1.0.0',
		[getKvKey('codex')]: 'v2.0.0',
		[getKvKey('gemini-cli')]: 'v3.0.0',
	});

	await checkForUpdates(env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			claudeMarkdown: '## 1.0.0\n- Claude update',
			codexReleases: [createRelease('v2.0.0')],
			geminiReleases: [createRelease('v3.0.0')],
		}),
		sendNotificationsFn: async () => true,
	});

	assert.equal(await env.KV.get(getKvKey('claude-code')), '1.0.0');
	assert.equal(await env.KV.get('last_seen_version'), '1.0.0');
});

test('multiple missed releases are notified oldest first', async () => {
	const env = createEnv({
		[getKvKey('codex')]: 'v0.1.0',
	});

	const notifications: string[] = [];

	await processProduct(PRODUCTS_BY_ID.codex, env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			claudeMarkdown: '## 1.0.0\n- Claude',
			codexReleases: [createRelease('v0.3.0', 'Newest'), createRelease('v0.2.0', 'Middle'), createRelease('v0.1.0', 'Oldest')],
			geminiReleases: [createRelease('v0.1.0')],
		}),
		sendNotificationsFn: async (message) => {
			notifications.push(message);
			return true;
		},
	});

	assert.deepEqual(notifications, ['📦 Codex v0.2.0\n\nMiddle', '📦 Codex v0.3.0\n\nNewest']);
	assert.equal(await env.KV.get(getKvKey('codex')), 'v0.3.0');
});

test('one product failure does not block checkpoint updates for the others', async () => {
	const env = createEnv({
		[getKvKey('claude-code')]: '1.0.0',
		[getKvKey('codex')]: 'v0.1.0',
		[getKvKey('gemini-cli')]: 'v0.1.0',
	});

	await checkForUpdates(env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			claudeMarkdown: '## 1.1.0\n- Claude latest\n\n## 1.0.0\n- Claude old',
			codexReleases: [createRelease('v0.2.0', 'Codex latest'), createRelease('v0.1.0', 'Codex old')],
			geminiReleases: [createRelease('v0.2.0', 'Gemini latest'), createRelease('v0.1.0', 'Gemini old')],
		}),
		sendNotificationsFn: async (message) => !message.includes('Codex'),
	});

	assert.equal(await env.KV.get(getKvKey('claude-code')), '1.1.0');
	assert.equal(await env.KV.get(getKvKey('codex')), 'v0.1.0');
	assert.equal(await env.KV.get(getKvKey('gemini-cli')), 'v0.2.0');
});

test('empty GitHub release notes still send a usable notification', async () => {
	const env = createEnv({
		[getKvKey('codex')]: 'v0.1.0',
	});

	const notifications: string[] = [];

	await processProduct(PRODUCTS_BY_ID.codex, env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			claudeMarkdown: '## 1.0.0\n- Claude',
			codexReleases: [createRelease('v0.2.0', ''), createRelease('v0.1.0', 'Old notes')],
			geminiReleases: [createRelease('v0.1.0')],
		}),
		sendNotificationsFn: async (message) => {
			notifications.push(message);
			return true;
		},
	});

	assert.deepEqual(notifications, ['📦 Codex v0.2.0']);
	assert.equal(await env.KV.get(getKvKey('codex')), 'v0.2.0');
});

test('GitHub requests include Authorization when GITHUB_TOKEN is configured', async () => {
	const env = createEnv(
		{
			[getKvKey('codex')]: 'v1.0.0',
		},
		{
			GITHUB_TOKEN: 'secret-token',
		},
	);

	const requestHeaders: Headers[] = [];

	await processProduct(PRODUCTS_BY_ID.codex, env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			claudeMarkdown: '## 1.0.0\n- Claude',
			codexReleases: [createRelease('v1.1.0', 'Codex latest'), createRelease('v1.0.0', 'Codex old')],
			geminiReleases: [createRelease('v0.1.0')],
			onRequest: (_input, init) => {
				if (init?.headers) {
					requestHeaders.push(new Headers(init.headers));
				}
			},
		}),
		sendNotificationsFn: async () => true,
	});

	assert.ok(requestHeaders.length > 0);
	assert.equal(requestHeaders[0].get('authorization'), 'Bearer secret-token');
});

test('GitHub checks stop reading releases once the last seen release is found', async () => {
	// Like Codex: a run of prereleases above the newest stable release, and a long history below it
	const codexReleases = [
		...Array.from({ length: 10 }, (_, i) => createRelease(`v2.0.0-alpha.${10 - i}`, 'Alpha', { prerelease: true })),
		createRelease('v1.9.0', 'Newest stable'),
		...Array.from({ length: 489 }, (_, i) => createRelease(`v1.8.${488 - i}`)),
	];
	const env = createEnv({ [getKvKey('codex')]: 'v1.9.0' });
	const requestedPages: string[] = [];
	const notifications: string[] = [];

	await processProduct(PRODUCTS_BY_ID.codex, env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			claudeMarkdown: '',
			codexReleases,
			geminiReleases: [],
			onRequest: (input) => {
				const { searchParams } = new URL(String(input));
				requestedPages.push(`page=${searchParams.get('page')}&per_page=${searchParams.get('per_page')}`);
			},
		}),
		sendNotificationsFn: async (message) => {
			notifications.push(message);
			return true;
		},
	});

	assert.deepEqual(requestedPages, ['page=1&per_page=30']);
	assert.deepEqual(notifications, []);
	assert.equal(await env.KV.get(getKvKey('codex')), 'v1.9.0');
});

test('GitHub checks keep paging when the last seen release is older than the first page', async () => {
	const codexReleases = Array.from({ length: 250 }, (_, i) => createRelease(`v1.0.${249 - i}`));
	const env = createEnv({ [getKvKey('codex')]: 'v1.0.99' });
	const requestedPages: string[] = [];
	const notifications: string[] = [];

	await processProduct(PRODUCTS_BY_ID.codex, env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			claudeMarkdown: '',
			codexReleases,
			geminiReleases: [],
			onRequest: (input) => {
				const { searchParams } = new URL(String(input));
				requestedPages.push(`page=${searchParams.get('page')}&per_page=${searchParams.get('per_page')}`);
			},
		}),
		sendNotificationsFn: async (message) => {
			notifications.push(message);
			return true;
		},
	});

	assert.deepEqual(requestedPages, ['page=1&per_page=30', 'page=1&per_page=100', 'page=2&per_page=100']);
	assert.equal(notifications.length, 150);
	assert.equal(notifications[0], '📦 Codex v1.0.100\n\nv1.0.100 release notes');
	assert.equal(notifications.at(-1), '📦 Codex v1.0.249\n\nv1.0.249 release notes');
	assert.equal(await env.KV.get(getKvKey('codex')), 'v1.0.249');
});

test('bounded GitHub paging notifies and stores the same versions as reading every release', async () => {
	const patterns: Record<string, (index: number) => Partial<{ draft: boolean; prerelease: boolean }>> = {
		allStable: () => ({}),
		everyOtherPrerelease: (index) => ({ prerelease: index % 2 === 1 }),
		prereleasesFirst: (index) => ({ prerelease: index < 40 }),
		allPrereleases: () => ({ prerelease: true }),
		someDrafts: (index) => ({ draft: index % 7 === 0 }),
	};

	for (const size of [0, 1, 29, 30, 31, 99, 100, 101, 129, 130, 131, 250]) {
		for (const [pattern, flags] of Object.entries(patterns)) {
			const releases = Array.from({ length: size }, (_, index) => createRelease(`v${size - index}.0.0`, `Notes ${index}`, flags(index)));
			const stableReleases = filterStableReleases(releases);

			for (const lastSeen of [null, 'v0.0.0-missing', ...stableReleases.map((release) => release.tag_name)]) {
				const env = createEnv(lastSeen ? { [getKvKey('codex')]: lastSeen } : {});
				const notifications: string[] = [];

				await processProduct(PRODUCTS_BY_ID.codex, env, {
					logger: noopLogger,
					fetchFn: createFetchStub({ claudeMarkdown: '', codexReleases: releases, geminiReleases: [] }),
					sendNotificationsFn: async (message) => {
						notifications.push(message);
						return true;
					},
				});

				// Reading every release notifies everything above the last seen one, oldest first, then stores the newest
				const lastSeenIndex = stableReleases.findIndex((release) => release.tag_name === lastSeen);
				const expectedNotifications = stableReleases
					.slice(0, Math.max(lastSeenIndex, 0))
					.reverse()
					.map((release) => formatVersionMessage('Codex', { version: release.tag_name, content: release.body }));
				const context = `${size} releases, ${pattern}, last seen ${lastSeen}`;

				assert.deepEqual(notifications, expectedNotifications, context);
				assert.equal(await env.KV.get(getKvKey('codex')), stableReleases[0]?.tag_name ?? lastSeen, context);
			}
		}
	}
});

test('an unchanged changelog is skipped with a conditional request', async () => {
	const kvKey = getKvKey('claude-code');
	const env = { KV: new MockKVNamespace({ [kvKey]: '1.0.0' }, { [kvKey]: { etag: '"v1"' } }) };
	const requestHeaders: Headers[] = [];
	const notifications: string[] = [];

	await processProduct(PRODUCTS_BY_ID['claude-code'], env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			// Would announce 1.1.0 if the body were read
			claudeMarkdown: '## 1.1.0\n- New\n\n## 1.0.0\n- Old',
			claudeEtag: '"v1"',
			codexReleases: [],
			geminiReleases: [],
			onRequest: (_input, init) => requestHeaders.push(new Headers(init?.headers)),
		}),
		sendNotificationsFn: async (message) => {
			notifications.push(message);
			return true;
		},
	});

	assert.equal(requestHeaders[0].get('If-None-Match'), '"v1"');
	assert.deepEqual(notifications, []);
	assert.deepEqual(await env.KV.getWithMetadata(kvKey), { value: '1.0.0', metadata: { etag: '"v1"' }, cacheStatus: null });
});

test('the changelog ETag is stored with the version read from it', async () => {
	const kvKey = getKvKey('claude-code');
	const env = { KV: new MockKVNamespace({ [kvKey]: '1.0.0' }, { [kvKey]: { etag: '"v1"' } }) };
	const notifications: string[] = [];

	await processProduct(PRODUCTS_BY_ID['claude-code'], env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			claudeMarkdown: '## 1.1.0\n- New\n\n## 1.0.0\n- Old',
			claudeEtag: '"v2"',
			codexReleases: [],
			geminiReleases: [],
		}),
		sendNotificationsFn: async (message) => {
			notifications.push(message);
			return true;
		},
	});

	assert.deepEqual(notifications, ['📦 Claude Code v1.1.0\n\n- New']);
	assert.deepEqual(await env.KV.getWithMetadata(kvKey), { value: '1.1.0', metadata: { etag: '"v2"' }, cacheStatus: null });
});

test('failed changelog notifications keep the previous ETag so the next run retries', async () => {
	const kvKey = getKvKey('claude-code');
	const env = { KV: new MockKVNamespace({ [kvKey]: '1.0.0' }, { [kvKey]: { etag: '"v1"' } }) };

	await processProduct(PRODUCTS_BY_ID['claude-code'], env, {
		logger: noopLogger,
		fetchFn: createFetchStub({
			claudeMarkdown: '## 1.1.0\n- New\n\n## 1.0.0\n- Old',
			claudeEtag: '"v2"',
			codexReleases: [],
			geminiReleases: [],
		}),
		sendNotificationsFn: async () => false,
	});

	assert.deepEqual(await env.KV.getWithMetadata(kvKey), { value: '1.0.0', metadata: { etag: '"v1"' }, cacheStatus: null });
});

test('a first run stores the changelog ETag with the latest version', async () => {
	const kvKey = getKvKey('claude-code');
	const env = createEnv();

	await processProduct(PRODUCTS_BY_ID['claude-code'], env, {
		logger: noopLogger,
		fetchFn: createFetchStub({ claudeMarkdown: '## 1.0.0\n- First', claudeEtag: '"v1"', codexReleases: [], geminiReleases: [] }),
		sendNotificationsFn: async () => true,
	});

	assert.deepEqual(await env.KV.getWithMetadata(kvKey), { value: '1.0.0', metadata: { etag: '"v1"' }, cacheStatus: null });
});
