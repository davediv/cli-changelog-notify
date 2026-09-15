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

class MockKVNamespace {
	private readonly store = new Map<string, string>();

	constructor(initialValues: Record<string, string> = {}) {
		for (const [key, value] of Object.entries(initialValues)) {
			this.store.set(key, value);
		}
	}

	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
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

function createFetchStub({
	claudeMarkdown,
	codexReleases,
	geminiReleases,
	onRequest,
}: {
	claudeMarkdown: string;
	codexReleases: unknown[];
	geminiReleases: unknown[];
	onRequest?: (input: string | URL | Request, init?: RequestInit) => void;
}) {
	return async (input: string | URL | Request, init?: RequestInit) => {
		onRequest?.(input, init);

		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

		if (url.includes('anthropics/claude-code')) {
			return new Response(claudeMarkdown, { status: 200 });
		}

		if (url.includes('/repos/openai/codex/releases')) {
			return new Response(JSON.stringify(codexReleases), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('/repos/google-gemini/gemini-cli/releases')) {
			return new Response(JSON.stringify(geminiReleases), {
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
