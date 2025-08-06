# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

Use **pnpm** as the package manager:

- `pnpm dev` - Run development server with hot reload using tsx
- `pnpm build` - Compile TypeScript to JavaScript 
- `pnpm start` - Build and run the production version
- `pnpm lint` - Run ESLint on TypeScript files
- `pnpm lint:fix` - Run ESLint with automatic fixes
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check code formatting without changes

## Architecture Overview

This is a Discord bot that integrates with Letta AI to create a stateful AI assistant. The bot processes Discord messages and forwards them to a Letta agent, which maintains conversation context and memory across interactions.

### Core Components

**Entry Point (`src/index.ts`):**
- Discord.js client setup with message content, guild, and DM intents
- Message event handler that categorizes messages (DM, mention, reply, generic)
- Typing indicator simulation with random delays
- Error handling with fallback to general channel

**Message Processing (`src/messages.ts`):**  
- `sendMessage()` - Main function that enqueues Discord messages for processing
- `processStream()` - Processes Letta's streaming response for tool calls and messages
- Message categorization and context formatting for the AI agent
- Response processing from Letta's stateful agent API with tool call handling

**Message Queue System (`src/messageQueue.ts`):**
- **MessageQueueManager**: Manages separate queues per channel plus system queue
- **MessageQueue**: FIFO queue with batching and interruption capabilities  
- **Message Batching**: Combines rapid successive messages (150ms window) into single requests
- **Request Interruption**: Aborts current requests when new messages arrive to batch them
- **Per-Channel Queues**: Separate processing queues for each Discord channel
- **System Queue**: Dedicated queue for timer messages and member join events
- Reply handling that fetches original message content
- **Media Handling**: Detects attachments (images, audio, video) and includes descriptions

**Logging (`src/logger.ts`):**
- Winston-based logging with file and console output
- Separate error and combined log files in `logs/` directory

**Utilities (`src/util/`):**
- `chunkString.ts` - String chunking utility with delimiter-aware splitting
- `linkPreviews.ts` - URL metadata extraction with special handling for YouTube, GitHub, and Twitter
- `statusPersistence.ts` - Discord bot status persistence across restarts using JSON file storage

**Event Timer (`src/eventTimer.ts`):**
- Configurable random timer system for periodic agent heartbeat messages
- Probabilistic event firing with configurable intervals and firing rates
- Sends timer messages to specified Discord channel when triggered

### Message Queue Architecture

The bot implements a sophisticated per-channel queue system with batching:
- **Problem**: Multiple rapid Discord messages could trigger concurrent Letta requests, causing the AI to see messages without proper context
- **Solution**: `MessageQueueManager` creates separate `MessageQueue` instances per channel
- **Channel Isolation**: Each Discord channel has its own processing queue to prevent cross-channel interference
- **Message Batching**: Rapid messages (within 150ms) are combined into single requests to improve efficiency
- **Request Interruption**: Active requests can be aborted to accommodate new batched messages
- **System Queue**: Timer and member join messages use a dedicated system queue (`__system__`)
- **Error Handling**: Aborted requests are re-queued for batching; failed messages don't block processing
- **Monitoring**: Queue size and processing status are logged for debugging

### Letta Integration

The bot uses Letta's stateful agent architecture:
- Agents maintain conversation history server-side
- Messages are sent individually (not full conversation history)
- Responses contain multiple message types: assistant, reasoning, tool calls, tool returns
- Tool responses are parsed from `send_response` tool calls

### Message Flow

1. Discord message received → Message type detection (DM/mention/reply/generic)
2. Message enqueued in channel-specific `MessageQueue` via `MessageQueueManager`
3. If rapid messages detected, batch them with 150ms window and abort current request
4. Context formatting with sender info, channel names, reply context
5. **Media processing** - Attachment detection and description generation
6. Send to Letta agent via streaming `client.agents.messages.createStream()`
7. Process Letta streaming response for tool calls (`send_response`, `set_status`)
8. Send response back to Discord with typing simulation

### Environment Variables

Required:
- `DISCORD_BOT_TOKEN` - Discord bot authentication
- `LETTA_TOKEN` - Letta API key for cloud service  
- `LETTA_AGENT_ID` - Specific agent instance ID
- `LETTA_BASE_URL` - Letta server URL (optional, defaults to cloud)

Optional:
- `ELEVENLABS_API_KEY` - ElevenLabs API key for audio transcription (if not set, audio files will not be transcribed)
- `CHANNEL_ID` - Default channel ID for fallback message delivery and timer messages
- `IGNORE_CHANNEL_ID` - Channel ID to ignore messages from
- `ENABLE_TIMER` - Set to "true" to enable periodic agent heartbeat messages
- `TIMER_INTERVAL_MINUTES` - Maximum interval for timer events (default: 30)
- `FIRING_PROBABILITY` - Probability of timer events firing (default: 0.1 = 10%)

### Key Implementation Details

- **Per-Channel Queuing**: Each Discord channel has separate message processing queues
- **Message Batching**: Rapid messages (150ms window) are combined into single Letta requests
- **Request Interruption**: Active requests can be aborted to accommodate batching
- Uses Discord.js partials for DM support
- Implements attachment description for media files (`getAttachmentDescription()`)
- Message truncation for reply contexts (100 char limit)
- Streaming API with `client.agents.messages.createStream()` for real-time responses
- Structured logging with request/response details and queue status
- Pre-commit hooks with Husky for linting and formatting
- In-memory transcription cache to avoid re-processing audio files
- Link preview extraction with TTL-based caching (24 hours)
- Discord status persistence using JSON file storage in `data/` directory
- Chunked message delivery with rate limiting protection
- Fallback message delivery to general channel on permission errors
- Manual heartbeat command (`!heartbeat`) for triggering agent activity

### Agent Tools

The bot supports two custom tools that the Letta agent can use:

1. **`send_response`** - Sends a message back to Discord
   - `is_responding: boolean` - Whether the agent is actively responding
   - `message: string` - The message content to send

2. **`set_status`** - Sets the Discord bot's status
   - `message: string` - The status message to display

### File Structure

```
src/
├── index.ts              # Main Discord client and event handling
├── messages.ts           # Message processing and Letta integration
├── messageQueue.ts       # Per-channel queuing system with batching
├── eventTimer.ts         # Random timer system for agent heartbeats
├── logger.ts             # Winston logging configuration
└── util/
    ├── chunkString.ts    # Message chunking utility
    ├── linkPreviews.ts   # URL metadata extraction
    ├── statusPersistence.ts # Discord status persistence
    └── attachments.ts    # Media file description generation
```