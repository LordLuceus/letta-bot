import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import "dotenv/config";
import { MessageType, sendMessage } from "./messages.js";

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
  console.log("Ready!");
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

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

  await message.channel.sendTyping();

  // Add a small random delay to simulate typing
  const delay = Math.floor(Math.random() * 2000) + 1000; // Between 1 and 3 seconds
  setTimeout(async () => {
    await message.channel.send(response);
  }, delay);
});

client.login(process.env.DISCORD_BOT_TOKEN);
