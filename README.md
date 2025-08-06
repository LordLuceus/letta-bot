# Letta Bot

A Discord bot frontend for a Letta AI agent that provides stateful, intelligent conversations with memory persistence across interactions.

## Overview

This Discord bot integrates with [Letta AI](https://docs.letta.com/) to create a sophisticated AI assistant that maintains conversation context and memory. Unlike traditional chatbots, the Letta agent remembers previous conversations and can learn about users over time, providing a more personalized and coherent experience.

### Key Features

- **Stateful AI Conversations**: Persistent memory across Discord sessions
- **Per-Channel Message Queues**: Isolated processing for each Discord channel
- **Message Batching**: Combines rapid messages for efficient processing
- **Media Support**: Processes images, audio, and video with AI descriptions
- **Voice Transcription**: Audio message transcription via ElevenLabs API
- **Link Previews**: Automatic URL metadata extraction with caching
- **Random Heartbeats**: Periodic agent activity to maintain engagement
- **Status Persistence**: Discord bot status survives restarts
- **Comprehensive Logging**: Structured logging with file and console output

## Architecture

### Core Components

- **Message Queue System**: Per-channel FIFO queues with batching and interruption capabilities
- **Letta Integration**: Streaming API communication with stateful agent
- **Media Processing**: Attachment handling with AI-powered descriptions
- **Event Timer**: Configurable random heartbeat system
- **Status Persistence**: Bot status storage across restarts

### Message Flow

1. Discord message received → Type detection (DM/mention/reply/generic)
2. Message queued per-channel with batching (150ms window)
3. Media processing and link preview extraction
4. Context formatting with sender info and reply chains
5. Streaming request to Letta agent
6. Response processing with typing simulation
7. Delivery to Discord with chunking for long messages

## Installation

### Prerequisites

- Node.js 18+
- pnpm package manager
- Discord bot token
- Letta Cloud account or self-hosted Letta server

### Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/lordluceus/letta-bot.git
   cd letta-bot
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   ```

3. **Environment Configuration**

Create a `.env` file in the project root:

```env
# Required
DISCORD_BOT_TOKEN=your_discord_bot_token
LETTA_TOKEN=your_letta_api_key
LETTA_AGENT_ID=your_letta_agent_id

# Optional
LETTA_BASE_URL=https://api.letta.com  # Default for Letta Cloud
ELEVENLABS_API_KEY=your_elevenlabs_key  # For audio transcription
CHANNEL_ID=discord_channel_id  # Fallback channel for errors/timer
IGNORE_CHANNEL_ID=channel_to_ignore  # Channel to skip processing

# Timer Configuration
ENABLE_TIMER=true  # Enable random heartbeat messages
TIMER_INTERVAL_MINUTES=30  # Maximum timer interval
FIRING_PROBABILITY=0.1  # 10% chance of firing per interval
```

4. **Discord Bot Setup**
   - Create a Discord application at [Discord Developer Portal](https://discord.com/developers/applications)
   - Create a bot and copy the token to `DISCORD_BOT_TOKEN`
   - Enable the following bot permissions:
     - Send Messages
     - Read Message History
     - Embed Links
     - Attach Files
     - Use Slash Commands
   - Invite the bot to your server with these permissions

5. **Letta Agent Setup**
   - Sign up at [Letta Cloud](https://app.letta.com) or set up self-hosted Letta
   - Create an API key at [API Keys](https://app.letta.com/api-keys)
   - Create an agent and note the agent ID
   - Configure the agent with custom tools if needed

## Usage

### Development

```bash
# Run in development mode with hot reload
pnpm dev

# Build the project
pnpm build

# Run production build
pnpm start

# Linting and formatting
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
```

### Docker Deployment

```bash
# Using Docker Compose
docker-compose up -d

# Or build manually
docker build -t letta-bot .
docker run -d --env-file .env letta-bot
```

### Bot Commands

- **Direct Messages**: Bot responds to all DMs
- **Mentions**: Responds when mentioned in channels
- **Replies**: Processes replies to bot messages
- **`!heartbeat`**: Manual trigger for agent activity

## Configuration

### Environment Variables

| Variable                 | Required | Description                                 |
| ------------------------ | -------- | ------------------------------------------- |
| `DISCORD_BOT_TOKEN`      | Yes      | Discord bot authentication token            |
| `LETTA_TOKEN`            | Yes      | Letta API key for cloud service             |
| `LETTA_AGENT_ID`         | Yes      | Specific Letta agent instance ID            |
| `LETTA_BASE_URL`         | No       | Letta server URL (defaults to cloud)        |
| `ELEVENLABS_API_KEY`     | No       | ElevenLabs API for audio transcription      |
| `CHANNEL_ID`             | No       | Default channel for fallback/timer messages |
| `IGNORE_CHANNEL_ID`      | No       | Channel ID to ignore messages from          |
| `ENABLE_TIMER`           | No       | Enable periodic agent heartbeats            |
| `TIMER_INTERVAL_MINUTES` | No       | Timer interval (default: 30)                |
| `FIRING_PROBABILITY`     | No       | Timer firing probability (default: 0.1)     |

### Agent Tools

The bot supports these custom tools that the Letta agent can use:

- **`send_response`**: Send messages back to Discord
- **`set_status`**: Update the Discord bot's status message

## Development

### Project Structure

```
src/
├── index.ts              # Discord client and event handling
├── messages.ts           # Message processing and Letta integration
├── messageQueue.ts       # Per-channel queuing with batching
├── eventTimer.ts         # Random timer system
├── logger.ts            # Winston logging configuration
└── util/
    ├── chunkString.ts    # Message chunking utility
    ├── linkPreviews.ts   # URL metadata extraction
    ├── statusPersistence.ts # Discord status persistence
    └── attachments.ts    # Media description generation
```

### Key Implementation Details

- **Stateful Architecture**: Letta agents maintain server-side conversation history
- **Message Batching**: 150ms window for combining rapid messages
- **Request Interruption**: Active requests can be aborted for batching
- **Media Processing**: AI-powered descriptions for images, audio, and video
- **Streaming Responses**: Real-time processing with typing indicators
- **Error Handling**: Comprehensive error recovery and logging

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Use TypeScript for type safety
- Follow ESLint and Prettier configurations
- Add comprehensive logging for debugging
- Test with various Discord message types
- Ensure proper error handling and recovery

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- **Documentation**: [Letta Documentation](https://docs.letta.com/)
- **Discord**: Join the [Letta Discord Server](https://discord.gg/letta)
- **Issues**: Report bugs on [GitHub Issues](https://github.com/lordluceus/letta-bot/issues)

## Acknowledgments

- [Letta AI](https://letta.com/) for the stateful agent infrastructure
- [Discord.js](https://discord.js.org/) for Discord integration
- [ElevenLabs](https://elevenlabs.io/) for voice transcription services
