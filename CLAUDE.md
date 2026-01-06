# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Development mode (watch all packages)
pnpm dev

# Type check all packages
pnpm typecheck

# Build individual packages
pnpm -F @claude-blocker/extension build
pnpm -F claude-blocker build  # server package

# Run server in dev mode
pnpm -F claude-blocker dev

# Package extension for distribution
pnpm -F @claude-blocker/extension zip
```

## Architecture

This is a pnpm monorepo with three packages that work together to block distracting websites unless Claude Code is actively running.

### Communication Flow

```
Claude Code → Server (HTTP hooks) → Extension (WebSocket) → Content Script (blocks pages)
```

### packages/server (published as `claude-blocker` on npm)

The Node.js server receives hook events from Claude Code and broadcasts state to the Chrome extension.

- **bin.ts**: CLI entry point, handles `--setup`, `--remove`, `--port`, `--help` flags
- **server.ts**: HTTP server (POST `/hook`, GET `/status`) + WebSocket server (`/ws`)
- **state.ts**: `SessionState` class - tracks Claude Code sessions, manages status (idle/working/waiting_for_input), broadcasts to WebSocket subscribers
- **setup.ts**: Configures Claude Code hooks in `~/.claude/settings.json`

Key types from `types.ts`:
- `HookPayload`: Events from Claude Code (UserPromptSubmit, PreToolUse, Stop, SessionStart, SessionEnd)
- `Session`: Tracked session with status and last activity timestamp
- `ServerMessage`/`ClientMessage`: WebSocket protocol

### packages/extension (Chrome Manifest V3)

- **service-worker.ts**: Maintains WebSocket connection to server, computes blocking state, broadcasts to content scripts. Handles bypass logic (5 min, 1x/day) and work hours settings.
- **content-script.ts**: Injects blocking UI on configured domains when `blocked=true`. Replaces page content with "Time to Work" message.
- **options.ts/html/css**: Settings page for blocked domains and work hours
- **popup.ts/html/css**: Extension popup showing current status

The extension blocks when: server disconnected OR (no sessions working AND not waiting for user input AND within work hours AND bypass not active)

### packages/shared

Shared TypeScript types and constants used by both server and extension:
- `DEFAULT_PORT`: 8765
- `SESSION_TIMEOUT_MS`: 5 minutes
- `DEFAULT_BLOCKED_DOMAINS`: x.com, twitter.com

## Important Behaviors

- **Waiting for input**: When Claude uses `AskUserQuestion` tool, the session is marked `waiting_for_input` and should NOT block (user needs to respond)
- **Work hours**: Blocking only applies during configured work hours (default: 10am-5pm Mon-Fri)
- **Session cleanup**: Stale sessions (no activity for 5 min) are automatically removed
- **Safety default**: If server is unreachable, extension blocks by default
