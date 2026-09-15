const CLAUDE_CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md';
const KV_KEY_PREFIX = 'last_seen_version:';
const GITHUB_RELEASES_PER_PAGE = 100;
// Usually reaches the last seen release in one request, even after a run of Codex prereleases
const GITHUB_RELEASES_FIRST_PAGE_SIZE = 30;
const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_USER_AGENT = 'claudecode-codex-gemini-changelog-notify';

const MAX_TELEGRAM_LENGTH = 4096;
const MAX_DISCORD_LENGTH = 2000;
const MAX_SLACK_LENGTH = 40000;

export type ProductId = 'claude-code' | 'codex' | 'gemini-cli';

interface Env {
	KV: KVNamespace;
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
	TELEGRAM_THREAD_ID?: string;
	DISCORD_WEBHOOK_URL?: string;
	SLACK_WEBHOOK_URL?: string;
	GITHUB_TOKEN?: string;
	// Bearer token for the manual /check endpoint, which stays disabled without it
	CHECK_TOKEN?: string;
}

export interface VersionEntry {
	version: string;
	content: string;
}

interface NotificationResult {
	platform: string;
	success: boolean;
}

export interface ProductDefinition {
	id: ProductId;
	label: string;
	source: 'changelog' | 'github-releases';
	changelogUrl?: string;
	githubRepo?: string;
}

interface GitHubRelease {
	tag_name: string;
	body: string | null;
	draft: boolean;
	prerelease: boolean;
}

interface GitHubValidator {
	etag: string;
	requestKey: string;
}

interface GitHubPage {
	releases: GitHubRelease[];
	validator?: GitHubValidator;
}

// Stored in KV alongside a product's last seen version
interface CheckpointMetadata {
	// ETag of the changelog the version was read from
	etag?: string;
	github?: GitHubValidator;
}

interface SourceSnapshot {
	entries: VersionEntry[];
	etag?: string;
	github?: GitHubValidator;
}

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;
type FetchFn = typeof fetch;
type NotificationSender = (message: string, env: Env) => Promise<boolean>;

export interface CheckDependencies {
	fetchFn?: FetchFn;
	sendNotificationsFn?: NotificationSender;
	logger?: Logger;
}

export const PRODUCTS: readonly ProductDefinition[] = [
	{
		id: 'claude-code',
		label: 'Claude Code',
		source: 'changelog',
		changelogUrl: CLAUDE_CHANGELOG_URL,
	},
	{
		id: 'codex',
		label: 'Codex',
		source: 'github-releases',
		githubRepo: 'openai/codex',
	},
	{
		id: 'gemini-cli',
		label: 'Gemini CLI',
		source: 'github-releases',
		githubRepo: 'google-gemini/gemini-cli',
	},
] as const;

export const PRODUCTS_BY_ID = Object.fromEntries(PRODUCTS.map((product) => [product.id, product])) as Record<ProductId, ProductDefinition>;

// Truncate message to max length with ellipsis
function truncateMessage(message: string, maxLength: number): string {
	if (message.length <= maxLength) {
		return message;
	}
	return message.slice(0, maxLength - 4) + '\n...';
}

// Escape special characters for Telegram Markdown V1
function escapeTelegramMarkdown(text: string): string {
	return text.replace(/([_*`[])/g, '\\$1');
}

export function getKvKey(productId: ProductId): string {
	return `${KV_KEY_PREFIX}${productId}`;
}

export function normalizeDisplayVersion(version: string): string {
	return version.replace(/^v/i, '');
}

// Parse changelog markdown into version entries, newest first. With stopAfterVersion, parsing ends at that
// entry, since older entries are never needed to find new versions.
export function parseChangelog(markdown: string, stopAfterVersion?: string): VersionEntry[] {
	const entries: VersionEntry[] = [];
	let current: { version: string; contentStart: number } | null = null;

	// `(?:^|\n)` matches a heading at the start of any line, like `^` on each line of markdown.split('\n')
	for (const match of markdown.matchAll(/(?:^|\n)## (\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/g)) {
		const headingStart = match[0].startsWith('\n') ? match.index + 1 : match.index;

		if (current) {
			entries.push({ version: current.version, content: markdown.slice(current.contentStart, headingStart - 1).trim() });
			if (current.version === stopAfterVersion) {
				return entries;
			}
		}

		const lineEnd = markdown.indexOf('\n', match.index + match[0].length);
		current = { version: match[1], contentStart: lineEnd === -1 ? markdown.length : lineEnd + 1 };
	}

	if (current) {
		entries.push({ version: current.version, content: markdown.slice(current.contentStart).trim() });
	}

	return entries;
}

export function filterStableReleases(releases: GitHubRelease[]): GitHubRelease[] {
	return releases.filter((release) => !release.draft && !release.prerelease);
}

// Get new versions since the last seen version
export function getNewVersions(
	entries: VersionEntry[],
	lastSeenVersion: string,
	logger: Logger = console,
	productLabel = 'product',
): VersionEntry[] {
	const lastSeenIndex = entries.findIndex((entry) => entry.version === lastSeenVersion);

	// If last seen version not found in the source, treat as first run to avoid spam.
	if (lastSeenIndex === -1) {
		logger.warn(`Last seen version ${lastSeenVersion} not found for ${productLabel}, treating as first run`);
		return [];
	}

	return entries.slice(0, lastSeenIndex);
}

// Format version entry for notification
export function formatVersionMessage(productLabel: string, entry: VersionEntry): string {
	const header = `📦 ${productLabel} v${normalizeDisplayVersion(entry.version)}`;
	return entry.content ? `${header}\n\n${entry.content}` : header;
}

// Send notification to Telegram
async function sendTelegram(message: string, botToken: string, chatId: string, threadId?: string): Promise<NotificationResult> {
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
	const truncatedMessage = truncateMessage(message, MAX_TELEGRAM_LENGTH);
	const escapedMessage = escapeTelegramMarkdown(truncatedMessage);

	const body: Record<string, string | number> = {
		chat_id: chatId,
		text: escapedMessage,
		parse_mode: 'Markdown',
	};

	if (threadId) {
		body.message_thread_id = parseInt(threadId, 10);
	}

	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		console.error(`Telegram error: ${response.status} ${await response.text()}`);
	}

	return { platform: 'Telegram', success: response.ok };
}

// Send notification to Discord
async function sendDiscord(message: string, webhookUrl: string): Promise<NotificationResult> {
	const truncatedMessage = truncateMessage(message, MAX_DISCORD_LENGTH);

	const response = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ content: truncatedMessage }),
	});

	if (!response.ok) {
		console.error(`Discord error: ${response.status} ${await response.text()}`);
	}

	return { platform: 'Discord', success: response.ok };
}

// Send notification to Slack
async function sendSlack(message: string, webhookUrl: string): Promise<NotificationResult> {
	const truncatedMessage = truncateMessage(message, MAX_SLACK_LENGTH);

	const response = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text: truncatedMessage }),
	});

	if (!response.ok) {
		console.error(`Slack error: ${response.status} ${await response.text()}`);
	}

	return { platform: 'Slack', success: response.ok };
}

// Send notifications to all configured platforms
async function sendNotifications(message: string, env: Env, logger: Logger = console): Promise<boolean> {
	const promises: Promise<NotificationResult>[] = [];

	if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
		promises.push(sendTelegram(message, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, env.TELEGRAM_THREAD_ID));
	}

	if (env.DISCORD_WEBHOOK_URL) {
		promises.push(sendDiscord(message, env.DISCORD_WEBHOOK_URL));
	}

	if (env.SLACK_WEBHOOK_URL) {
		promises.push(sendSlack(message, env.SLACK_WEBHOOK_URL));
	}

	if (promises.length === 0) {
		logger.warn('No notification platforms configured');
		return false;
	}

	const results = await Promise.all(promises);
	const successCount = results.filter((result) => result.success).length;
	const failedPlatforms = results.filter((result) => !result.success).map((result) => result.platform);

	if (failedPlatforms.length > 0) {
		logger.error(`Failed to send to: ${failedPlatforms.join(', ')}`);
	}

	// Return true if at least one platform succeeded
	return successCount > 0;
}

// Returns null when the changelog is unchanged since the checkpoint's ETag
async function fetchClaudeEntries(
	product: ProductDefinition,
	fetchFn: FetchFn,
	logger: Logger,
	checkpoint: KVNamespaceGetWithMetadataResult<string, CheckpointMetadata>,
): Promise<SourceSnapshot | null> {
	const etag = checkpoint.metadata?.etag;
	const response = await fetchFn(product.changelogUrl!, etag ? { headers: { 'If-None-Match': etag } } : undefined);
	// Checked before `ok`, which is false for 304
	if (response.status === 304) {
		return null;
	}

	if (!response.ok) {
		throw new Error(`Failed to fetch changelog: ${response.status}`);
	}

	const markdown = await response.text();
	const entries = parseChangelog(markdown, checkpoint.value ?? undefined);

	if (entries.length === 0) {
		logger.log(`No version entries found for ${product.label}`);
	}

	return { entries, etag: response.headers.get('ETag') ?? undefined };
}

async function fetchGitHubReleasesPage(
	product: ProductDefinition,
	env: Env,
	fetchFn: FetchFn,
	page: number,
	perPage: number,
	validator?: GitHubValidator,
): Promise<GitHubPage | null> {
	const url = new URL(`${GITHUB_API_BASE_URL}/repos/${product.githubRepo!}/releases`);
	url.searchParams.set('page', page.toString());
	url.searchParams.set('per_page', perPage.toString());

	const headers: HeadersInit = {
		Accept: 'application/vnd.github+json',
		'User-Agent': GITHUB_USER_AGENT,
	};

	if (env.GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
	}

	// Include the representation and credential identity without storing the token in KV.
	const credential = env.GITHUB_TOKEN
		? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.GITHUB_TOKEN))))
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('')
		: 'anonymous';
	const requestKey = JSON.stringify([url.toString(), headers.Accept, headers['User-Agent'], credential]);
	const etag = validator?.requestKey === requestKey ? validator.etag : undefined;
	if (etag) {
		headers['If-None-Match'] = etag;
	}

	const response = await fetchFn(url.toString(), { headers });
	if (response.status === 304 && etag) {
		return null;
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch GitHub releases for ${product.githubRepo}: ${response.status}`);
	}

	const pageReleases = (await response.json()) as GitHubRelease[];
	if (!Array.isArray(pageReleases)) {
		throw new Error(`Unexpected GitHub response for ${product.githubRepo}`);
	}

	const responseEtag = response.headers.get('ETag');
	return { releases: pageReleases, validator: responseEtag ? { etag: responseEtag, requestKey } : undefined };
}

// Read releases newest first and stop once processProduct has what it uses:
// the newest stable release and, when set, the last seen one
async function fetchGitHubEntries(
	product: ProductDefinition,
	env: Env,
	fetchFn: FetchFn,
	checkpoint: KVNamespaceGetWithMetadataResult<string, CheckpointMetadata>,
): Promise<SourceSnapshot | null> {
	const lastSeenVersion = checkpoint.value;
	const releases: VersionEntry[] = [];

	// Adds a page's stable releases and reports whether reading can stop
	const collect = (pageReleases: GitHubRelease[]): boolean => {
		const stableEntries = filterStableReleases(pageReleases).map((release) => ({
			version: release.tag_name,
			content: release.body?.trim() ?? '',
		}));
		releases.push(...stableEntries);
		return lastSeenVersion ? stableEntries.some((entry) => entry.version === lastSeenVersion) : releases.length > 0;
	};

	const firstPage = await fetchGitHubReleasesPage(
		product,
		env,
		fetchFn,
		1,
		GITHUB_RELEASES_FIRST_PAGE_SIZE,
		lastSeenVersion ? checkpoint.metadata?.github : undefined,
	);
	if (!firstPage) {
		return null;
	}
	const foundCheckpoint = collect(firstPage.releases);
	// The next successful checkpoint will be in this page only if it contains a stable release.
	// processProduct saves this validator only after all notifications succeed.
	const snapshot: SourceSnapshot = { entries: releases, github: releases.length > 0 ? firstPage.validator : undefined };
	if (foundCheckpoint || firstPage.releases.length < GITHUB_RELEASES_FIRST_PAGE_SIZE) {
		return snapshot;
	}

	for (let page = 1; ; page += 1) {
		const result = await fetchGitHubReleasesPage(product, env, fetchFn, page, GITHUB_RELEASES_PER_PAGE);
		if (!result) {
			throw new Error('Unexpected unvalidated GitHub page');
		}
		const pageReleases = result.releases;
		// Full page 1 repeats the releases already read from the first page
		const unreadReleases = page === 1 ? pageReleases.slice(GITHUB_RELEASES_FIRST_PAGE_SIZE) : pageReleases;
		if (collect(unreadReleases) || pageReleases.length < GITHUB_RELEASES_PER_PAGE) {
			return snapshot;
		}
	}
}

// Returns null when the source is unchanged since the checkpoint was stored
async function fetchEntriesForProduct(
	product: ProductDefinition,
	env: Env,
	fetchFn: FetchFn,
	logger: Logger,
	checkpoint: KVNamespaceGetWithMetadataResult<string, CheckpointMetadata>,
): Promise<SourceSnapshot | null> {
	if (product.source === 'changelog') {
		return fetchClaudeEntries(product, fetchFn, logger, checkpoint);
	}

	return fetchGitHubEntries(product, env, fetchFn, checkpoint);
}

export async function processProduct(product: ProductDefinition, env: Env, dependencies: CheckDependencies = {}): Promise<void> {
	const logger = dependencies.logger ?? console;
	const fetchFn = dependencies.fetchFn ?? fetch;
	const notificationSender =
		dependencies.sendNotificationsFn ?? ((message: string, runtimeEnv: Env) => sendNotifications(message, runtimeEnv, logger));

	const kvKey = getKvKey(product.id);
	// Read the checkpoint first so sources can stop once they reach it, or skip content that hasn't changed
	const checkpoint = await env.KV.getWithMetadata<CheckpointMetadata>(kvKey);
	const lastSeenVersion = checkpoint.value;

	const snapshot = await fetchEntriesForProduct(product, env, fetchFn, logger, checkpoint);
	if (!snapshot) {
		logger.log(`No new updates for ${product.label}. Current version: ${lastSeenVersion}`);
		return;
	}

	const { entries } = snapshot;
	if (entries.length === 0) {
		return;
	}

	const latestVersion = entries[0].version;
	// Store the source ETag only together with the version read from it, so a failed run is retried
	const checkpointOptions = snapshot.github
		? { metadata: { github: snapshot.github } }
		: snapshot.etag
			? { metadata: { etag: snapshot.etag } }
			: undefined;

	if (!lastSeenVersion) {
		logger.log(`First run for ${product.label} - storing latest version: ${latestVersion}`);
		await env.KV.put(kvKey, latestVersion, checkpointOptions);
		return;
	}

	if (latestVersion === lastSeenVersion) {
		if (
			snapshot.github &&
			(snapshot.github.etag !== checkpoint.metadata?.github?.etag || snapshot.github.requestKey !== checkpoint.metadata?.github?.requestKey)
		) {
			await env.KV.put(kvKey, latestVersion, checkpointOptions);
		}
		logger.log(`No new updates for ${product.label}. Current version: ${latestVersion}`);
		return;
	}

	const newVersions = getNewVersions(entries, lastSeenVersion, logger, product.label);

	if (newVersions.length === 0) {
		logger.log(`No new versions to notify for ${product.label}`);
		await env.KV.put(kvKey, latestVersion, checkpointOptions);
		return;
	}

	logger.log(`Found ${newVersions.length} new version(s) for ${product.label}`);

	let allSucceeded = true;
	for (const entry of [...newVersions].reverse()) {
		const message = formatVersionMessage(product.label, entry);
		const success = await notificationSender(message, env);
		if (!success) {
			allSucceeded = false;
		}
	}

	if (allSucceeded) {
		await env.KV.put(kvKey, latestVersion, checkpointOptions);
		logger.log(`Updated ${product.label} last seen version to: ${latestVersion}`);
	} else {
		logger.error(`Some ${product.label} notifications failed, not updating last seen version`);
	}
}

export async function checkForUpdates(env: Env, dependencies: CheckDependencies = {}): Promise<void> {
	const logger = dependencies.logger ?? console;

	for (const product of PRODUCTS) {
		try {
			await processProduct(product, env, { ...dependencies, logger });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to process ${product.label}: ${message}`);
		}
	}
}

// Hashes both values so the comparison takes the same time whatever the token and its length
async function isAuthorizedCheck(req: Request, env: Env): Promise<boolean> {
	if (!env.CHECK_TOKEN) {
		return false;
	}

	const encoder = new TextEncoder();
	const [provided, expected] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(req.headers.get('Authorization') ?? '')),
		crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${env.CHECK_TOKEN}`)),
	]);
	return crypto.subtle.timingSafeEqual(provided, expected);
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === '/check') {
			// A check costs a full run and GitHub API quota, so only token holders can trigger one
			if (!(await isAuthorizedCheck(req, env))) {
				return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
			}

			await checkForUpdates(env);
			return new Response('Release check completed');
		}

		url.pathname = '/__scheduled';
		url.searchParams.set('cron', '*/15 * * * *');
		return new Response(
			`CLI Release Monitor\n\nTracking: Claude Code, Codex, Gemini CLI\n\nTo test the scheduled handler, run:\ncurl "${url.href}"\n\nOr trigger a manual check:\ncurl -H "Authorization: Bearer $CHECK_TOKEN" "${new URL('/check', req.url).href}"`,
		);
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`Scheduled trigger fired at ${controller.cron}`);
		ctx.waitUntil(checkForUpdates(env));
	},
} satisfies ExportedHandler<Env>;
