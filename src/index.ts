import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import "dotenv/config";
import logger from "./logger";
import { MessageType, sendMessage } from "./messages";

const client = new Client({
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
    try {
      await message.channel.send(response);
    } catch (error) {
      logger.error("Failed to send message to channel:", error);

      // Try to send to general channel if we're in a guild and failed due to permissions
      if (message.guild) {
        try {
          const generalChannel = message.guild.channels.cache.find(
            (channel) => channel.name === "general" && channel.isTextBased(),
          );

          if (generalChannel && generalChannel.isTextBased()) {
            await generalChannel.send(response);
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
