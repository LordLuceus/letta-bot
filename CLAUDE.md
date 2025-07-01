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
- `sendMessage()` - Main function that processes Discord messages and sends to Letta
- Message categorization and context formatting for the AI agent
- Reply handling that fetches original message content
- **Media Handling**: Detects attachments (images, audio, video) and includes descriptions
- Response processing from Letta's stateful agent API
- Timer messages for periodic agent heartbeats

**Logging (`src/logger.ts`):**
- Winston-based logging with file and console output
- Separate error and combined log files in `logs/` directory

**Utilities (`src/util/`):**
- `chunkString.ts` - String chunking utility with delimiter-aware splitting

### Letta Integration

The bot uses Letta's stateful agent architecture:
- Agents maintain conversation history server-side
- Messages are sent individually (not full conversation history)
- Responses contain multiple message types: assistant, reasoning, tool calls, tool returns
- Tool responses are parsed from `send_response` tool calls

### Message Flow

1. Discord message received → Message type detection (DM/mention/reply/generic)
2. Context formatting with sender info, channel names, reply context
3. **Media processing** - Attachment detection and description generation
4. Send to Letta agent via `client.agents.messages.create()`
5. Process Letta response for `send_response` tool calls  
6. Send response back to Discord with typing simulation

### Environment Variables

Required:
- `DISCORD_BOT_TOKEN` - Discord bot authentication
- `LETTA_TOKEN` - Letta API key for cloud service  
- `LETTA_AGENT_ID` - Specific agent instance ID
- `LETTA_BASE_URL` - Letta server URL (optional, defaults to cloud)

Optional:
- `ELEVENLABS_API_KEY` - ElevenLabs API key for audio transcription (if not set, audio files will not be transcribed)

### Key Implementation Details

- Uses Discord.js partials for DM support
- Implements attachment description for media files (`getAttachmentDescription()`)
- Message truncation for reply contexts (100 char limit)
- Structured logging with request/response details
- Pre-commit hooks with Husky for linting and formatting