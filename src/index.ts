import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import "dotenv/config";
import { startRandomEventTimer } from "./eventTimer";
import logger from "./logger";
import { MessageType, sendMessage } from "./messages";
import { chunkString } from "./util/chunkString";

const CHANNEL_ID = process.env.CHANNEL_ID;

export const client = new Client({
  intents: [
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, () => {
  logger.info("Discord bot is ready!");
  startRandomEventTimer();
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.id === client.user?.id) return; // Ignore messages from the bot itself

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

  if (!response) return;

  try {
    await message.channel.sendTyping();
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
        await message.channel.send(chunk);
        // Small delay between chunks to avoid rate limiting
        if (chunks.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } catch (error) {
      logger.error("Failed to send message to channel:", error);

      // Try to send to general channel if we're in a guild and failed due to permissions
      if (message.guild) {
        try {
          const generalChannel = message.guild.channels.cache.find((channel) => channel.id === CHANNEL_ID);

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
});

client.login(process.env.DISCORD_BOT_TOKEN);
