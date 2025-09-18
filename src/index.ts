import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  OmitPartialGroupDMChannel,
  Partials,
} from "discord.js";
import "dotenv/config";
import { fireManualHeartbeat, startRandomEventTimer } from "./eventTimer";
import logger from "./logger";
import { MessageType, messageQueueManager, sendMemberJoinMessage, sendMessage } from "./messages";
import { chunkString } from "./util/chunkString";
import { loadStatus } from "./util/statusPersistence";

const CHANNEL_ID = process.env.CHANNEL_ID;
const IGNORE_CHANNEL_ID = process.env.IGNORE_CHANNEL_ID;

export const client = new Client({
  intents: [
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessageTyping,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, async () => {
  logger.info("Discord bot is ready!");

  // Restore saved status if exists
  const savedStatus = await loadStatus();
  if (savedStatus) {
    try {
      await client.user?.setActivity(savedStatus, { type: ActivityType.Custom });
      logger.info(`Restored Discord status: ${savedStatus}`);
    } catch (error) {
      logger.error("Failed to restore Discord status:", error);
    }
  }

  startRandomEventTimer();
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.id === client.user?.id) return; // Ignore messages from the bot itself

  if (message.channel.id === IGNORE_CHANNEL_ID) {
    logger.info(`Ignoring message in channel ${message.channel.id}`);
    return;
  }

  if (message.system) {
    logger.info("Received system message, ignoring.");
    return;
  }

  // Ignore sticker messages
  if (!message.content && message.stickers.size > 0) {
    logger.info("Ignoring sticker message.");
    return;
  }

  // Check for manual heartbeat command
  if (message.content.trim().toLowerCase() === "!heartbeat") {
    logger.info(`Manual heartbeat command triggered by ${message.author.displayName} (${message.author.id})`);

    try {
      await message.channel.sendTyping();
      await fireManualHeartbeat();
      await message.react("❤️"); // React with heart to acknowledge command
    } catch (error) {
      logger.error("Failed to execute manual heartbeat:", error);
      try {
        await message.react("❌"); // React with X to indicate failure
      } catch (reactionError) {
        logger.error("Failed to react to manual heartbeat command:", reactionError);
      }
    }
    return;
  }

  let messageType: MessageType;

  if (!message.guild) {
    messageType = MessageType.DM;
  } else if (message.mentions.has(client.user || "")) {
    messageType = MessageType.MENTION;
  } else if (message.reference) {
    messageType = MessageType.REPLY;
  } else {
    messageType = MessageType.GENERIC;
  }

  const response = await sendMessage(message, messageType);

  await handleMessageResponse({ message, response });
});

client.on(Events.GuildMemberAdd, async (member) => {
  logger.info(`New member joined: ${member.user.tag} (${member.id})`);

  const response = await sendMemberJoinMessage(member);

  await handleMessageResponse({ response });
});

// Handle typing detection with timeout-based stop detection
const typingTimeouts = new Map<string, NodeJS.Timeout>();

client.on(Events.TypingStart, (typing) => {
  const channelId = typing.channel.id;
  const userId = typing.user?.id;

  // Ignore typing from the bot itself or in ignored channels
  if (!userId || userId === client.user?.id || channelId === IGNORE_CHANNEL_ID) return;

  logger.debug(`User ${typing.user?.tag} (${userId}) started typing in channel ${channelId}`);
  messageQueueManager.onTypingStart(channelId, userId);

  const key = `${channelId}-${userId}`;

  // Clear existing timeout for this user in this channel
  const existingTimeout = typingTimeouts.get(key);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  // Set new timeout (Discord typing indicator lasts ~10 seconds)
  const timeout = setTimeout(() => {
    logger.debug(`User ${typing.user?.tag} (${userId}) stopped typing in channel ${channelId} (timeout)`);
    messageQueueManager.onTypingStop(channelId, userId);
    typingTimeouts.delete(key);
  }, 10000); // 10 second timeout

  typingTimeouts.set(key, timeout);
});

client.login(process.env.DISCORD_BOT_TOKEN);

async function handleMessageResponse({
  message,
  response,
}: {
  message?: OmitPartialGroupDMChannel<Message<boolean>> | null;
  response?: string | null;
}) {
  if (!response) return;

  // Determine the target channel - use message channel if available, otherwise use general channel
  let targetChannel = message?.channel;
  let guild = message?.guild;

  // If message is null/undefined (e.g., member join), find the general channel
  if (!message && CHANNEL_ID) {
    // Try to find the guild and general channel from all guilds the bot is in
    for (const [, botGuild] of client.guilds.cache) {
      const generalChannel = botGuild.channels.cache.find((channel) => channel.id === CHANNEL_ID);
      if (generalChannel && generalChannel.isTextBased()) {
        targetChannel = generalChannel;
        guild = botGuild;
        break;
      }
    }
  }

  if (!targetChannel) {
    logger.error("No target channel available for response");
    return;
  }

  try {
    await targetChannel.sendTyping();
  } catch (error) {
    logger.error("Failed to send typing indicator:", error);
  }

  // Add a small random delay to simulate typing
  const delay = Math.floor(Math.random() * 2000) + 1000; // Between 1 and 3 seconds
  setTimeout(async () => {
    // Split response into chunks if it exceeds Discord's 2000 character limit
    const chunks = chunkString(response, ["\n\n", "\n", ". ", " "], 2000);

    try {
      for (const chunk of chunks) {
        await targetChannel.send(chunk);
        // Small delay between chunks to avoid rate limiting
        if (chunks.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } catch (error) {
      logger.error("Failed to send message to channel:", error);

      // Try to send to general channel if we're in a guild and failed due to permissions
      if (guild && CHANNEL_ID) {
        try {
          const generalChannel = guild.channels.cache.find((channel) => channel.id === CHANNEL_ID);

          if (generalChannel && generalChannel.isTextBased()) {
            for (const chunk of chunks) {
              await generalChannel.send(chunk);
              if (chunks.length > 1) {
                await new Promise((resolve) => setTimeout(resolve, 500));
              }
            }
            logger.info("Successfully sent message to general channel as fallback");
          } else {
            logger.error("Could not find general channel for fallback");
          }
        } catch (fallbackError) {
          logger.error("Failed to send message to general channel as fallback:", fallbackError);
        }
      }
    }
  }, delay);
}
