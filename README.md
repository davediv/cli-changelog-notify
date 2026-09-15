# CLI Changelog Notify

Cloudflare Worker that monitors release updates for Claude Code, Codex, and Gemini CLI every hour and sends notifications to Telegram, Discord, and/or Slack when new updates are detected.

Repository: [davediv/cli-changelog-notify](https://github.com/davediv/cli-changelog-notify).

The production Cloudflare Worker remains named `claudecode-changelog-notify`.
Keep that name in `wrangler.jsonc` so deployments update the existing Worker.

## Features

- Scheduled checks every hour using Cloudflare Workers Cron Triggers
- Tracks Claude Code via the upstream changelog
- Tracks Codex and Gemini CLI via stable GitHub releases only
- Automatic diffing to detect only new updates
- Multi-platform notifications (Telegram, Discord, Slack) - configure one or all
- Stores per-product last seen versions in Cloudflare KV to avoid duplicate notifications

## Setup

### 1. Create KV Namespace

```bash
wrangler kv namespace create cli-changelog-notify-kv
```

Copy the `id` from the output and update `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "KV",
    "id": "YOUR_KV_NAMESPACE_ID"
  }
]
```

### 2. Configure Notification Platforms

Set secrets for the platforms you want to use. You only need to configure the platforms you want notifications on.

#### Telegram

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put TELEGRAM_THREAD_ID  # Optional: for forum topics
```

#### Discord

```bash
wrangler secret put DISCORD_WEBHOOK_URL
```

#### Slack

```bash
wrangler secret put SLACK_WEBHOOK_URL
```

### 3. Optional GitHub API Token

Codex and Gemini CLI releases are fetched from the GitHub Releases API. The worker works without authentication, but adding a token gives you higher rate limits.

```bash
wrangler secret put GITHUB_TOKEN
```

### 4. Optional Manual Check Token

`GET /check` runs a full release check on demand. It stays disabled until you set a token, and requests must send it as a bearer token.

```bash
wrangler secret put CHECK_TOKEN
```

### 5. Deploy

```bash
npm run deploy
```

## Development

```bash
npm run dev
```

Run the unit tests:

```bash
npm test
```

Test the scheduled handler:

```bash
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

Or trigger a manual check, after adding `CHECK_TOKEN=<token>` to `.dev.vars`:

```bash
curl -H "Authorization: Bearer <token>" "http://localhost:8787/check"
```

## How It Works

1. Every hour, the worker checks Claude Code, Codex, and Gemini CLI in a fixed order
2. Claude Code is parsed from the upstream changelog markdown
3. Codex and Gemini CLI are read from stable GitHub releases only
4. Each product is compared with its own last seen version stored in KV
5. New releases are sent as separate messages to all configured platforms
6. Each product checkpoint is updated only if its notifications succeeded

On first run for any product, the worker stores the current latest version without sending notifications.
