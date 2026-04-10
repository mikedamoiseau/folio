# Setting Up the Telegram Channel for Claude Code

This guide explains how to connect Claude Code to Telegram so it can receive and reply to messages from a Telegram bot.

## Prerequisites

- Claude Code CLI installed
- [Bun](https://bun.sh/) runtime installed (the Telegram plugin runs on Bun)
- A Telegram account

## Step 1: Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow the prompts: choose a name and a username (must end in `bot`)
4. BotFather will give you a **bot token** — copy it, you'll need it next

## Step 2: Install the Telegram Plugin

The plugin is part of the official Claude plugins. It should be available through Claude Code's plugin system. Once installed, it lives at:

```
~/.claude/plugins/cache/claude-plugins-official/telegram/<version>/
```

The plugin runs as an MCP server using Bun:

```json
{
  "command": "bun",
  "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
}
```

## Step 3: Save the Bot Token

Create the channel directory and store the token:

```bash
mkdir -p ~/.claude/channels/telegram
echo "TELEGRAM_BOT_TOKEN=<your-token-here>" > ~/.claude/channels/telegram/.env
chmod 600 ~/.claude/channels/telegram/.env
```

The `chmod 600` restricts the file to your user only — important since it contains a secret.

## Step 4: Configure Access Control

Create `~/.claude/channels/telegram/access.json`:

```json
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "pending": {}
}
```

### DM Policies

| Policy | Behavior |
|--------|----------|
| `pairing` (default) | Unknown users get a 6-character pairing code. You approve it from your terminal. |
| `allowlist` | Only pre-approved user IDs can message the bot. |
| `disabled` | Bot ignores all DMs. |

`pairing` is recommended for initial setup — it lets you safely approve yourself without needing to know your Telegram user ID upfront.

## Step 5: Pair Your Account

1. Launch Claude Code **with the `--channels` flag** — this is required, the Telegram server won't connect without it:
   ```sh
   claude --channels plugin:telegram@claude-plugins-official
   ```
2. Open Telegram and send any message to your bot
3. The bot will reply with a **6-character pairing code**
4. In your Claude Code terminal, run `/telegram:access` and approve the code:
   ```
   pair <the-code>
   ```
5. Your Telegram user ID is now added to the `allowFrom` list

You can verify by checking `~/.claude/channels/telegram/access.json` — your numeric user ID should appear in the `allowFrom` array.

## Step 6: (Optional) Add a Group

If you want the bot to participate in a Telegram group:

1. Add the bot to the group
2. Get the group's chat ID (it will be a negative number like `-5180151099`)
3. Use `/telegram:access` to enable the group:
   ```
   group add <group-chat-id>
   ```

By default, groups use **mention mode** — the bot only responds when mentioned by name. This prevents it from reacting to every message in the group.

## How It Works Once Running

- **Incoming messages** from allowed users arrive as channel events in your Claude Code session
- **Photos and documents** are automatically downloaded to `~/.claude/channels/telegram/inbox/`
- **Replies** go back through the bot — Claude uses the `reply` tool with your `chat_id`
- **Access config is live** — editing `access.json` takes effect immediately, no restart needed
- **Pairing codes expire** after 1 hour, and there can be at most 3 pending pairings at a time

## Security Notes

- The bot token in `.env` should never be committed to version control
- Only allowlisted users and groups can receive replies from the bot
- The plugin prevents sending channel state files — only inbox attachments can be shared
- For extra lockdown, set the environment variable `TELEGRAM_ACCESS_MODE=static` to freeze the access config at boot (no runtime changes)

## Available Delivery Settings

These can be adjusted via `/telegram:access` using `set <key> <value>`:

| Setting | Default | Description |
|---------|---------|-------------|
| `ackReaction` | (none) | Emoji reaction sent as read receipt |
| `replyToMode` | `first` | Threading: `first`, `all`, or `off` |
| `textChunkLimit` | 4096 | Max characters per message (Telegram's hard cap) |
| `chunkMode` | `newline` | How to split long messages: `newline` or `length` |

## Troubleshooting

- **Bot not responding?** Check that the token in `.env` is correct and that your user ID is in `allowFrom`
- **Messages not arriving in Claude?** Make sure Claude Code is running — the bot only works while a session is active
- **Group not working?** Verify the group is enabled in `access.json` and try mentioning the bot by name
