import { LettaClient } from "@letta-ai/letta-client";
import { LettaResponse } from "@letta-ai/letta-client/api/types";
import { Message, OmitPartialGroupDMChannel } from "discord.js";
import logger from "./logger";

const client = new LettaClient({
  token: process.env.LETTA_TOKEN || "dummy",
  baseUrl: process.env.LETTA_BASE_URL,
});
const AGENT_ID = process.env.LETTA_AGENT_ID;

export enum MessageType {
  DM = "DM",
  MENTION = "MENTION",
  REPLY = "REPLY",
  GENERIC = "GENERIC",
}

interface SendResponseArgs {
  is_responding: boolean;
  message: string;
}

function truncateMessage(message: string, maxLength: number): string {
  if (message.length > maxLength) {
    return message.substring(0, maxLength - 3) + "..."; // Truncate and add ellipsis
  }
  return message;
}

export async function sendTimerMessage() {
  if (!AGENT_ID) {
    logger.error("Error: LETTA_AGENT_ID is not set");
    return "";
  }

  const lettaMessage = {
    role: "user" as const,
    content:
      "[EVENT] This is an automated timed heartbeat (visible to yourself only). Use this event to send a message, to reflect and edit your memories, or do nothing at all. It's up to you! Consider though that this is an opportunity for you to think for yourself - since your circuit will not be activated until the next automated/timed heartbeat or incoming message event.",
  };

  try {
    logger.info(`🛜 Sending message to Letta server (agent=${AGENT_ID}): ${JSON.stringify(lettaMessage)}`);
    const response = await client.agents.messages.create(AGENT_ID, {
      messages: [lettaMessage],
    });

    return response || "";
  } catch (error) {
    logger.error(error);
    return "";
  }
}

export async function sendMessage(
  discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>,
  messageType: MessageType,
) {
  const {
    author: { id: senderId, displayName },
    content: message,
  } = discordMessageObject;

  // Use server nickname for guild messages, fallback to displayName for DMs
  const nickname = discordMessageObject.member?.nickname || displayName;

  if (!AGENT_ID) {
    logger.error("Error: LETTA_AGENT_ID is not set");
    return "";
  }

  // We include a sender receipt so that agent knows which user sent the message
  // We also include the Discord ID so that the agent can tag the user with @
  const senderNameReceipt = `${nickname} (id=${senderId})`;

  const channelName = "name" in discordMessageObject.channel ? discordMessageObject.channel.name || "" : "";

  let originalMessage = "";

  if (messageType === MessageType.REPLY && discordMessageObject.reference?.messageId) {
    // If the message is a reply, we try to fetch the original message
    const originalMessageObject = await discordMessageObject.channel.messages.fetch(
      discordMessageObject.reference.messageId,
    );
    const originalSenderNickname = originalMessageObject.member?.nickname || originalMessageObject.author.displayName;
    originalMessage = `${originalSenderNickname} (id=${originalMessageObject.author.id}): ${truncateMessage(originalMessageObject.content, 100)}`;
  }

  let content: string;

  switch (messageType) {
    case MessageType.DM:
      content = `[${senderNameReceipt} sent you a direct message] ${message}`;
      break;
    case MessageType.MENTION:
      content = `[${senderNameReceipt} sent a message mentioning you in channel ${channelName}] ${message}`;
      break;
    case MessageType.REPLY:
      content = `[${senderNameReceipt} replied to message: ${originalMessage} in channel ${channelName}] ${message}`;
      break;
    default:
      content = `[${senderNameReceipt} sent a message to channel ${channelName}] ${message}`;
      break;
  }

  const lettaMessage = {
    role: "user" as const,
    content,
  };

  try {
    logger.info(`🛜 Sending message to Letta server (agent=${AGENT_ID}): ${JSON.stringify(lettaMessage)}`);
    const response = await client.agents.messages.create(AGENT_ID, {
      messages: [lettaMessage],
    });

    if (response) {
      return await processResponse(response);
    }

    return "";
  } catch (error) {
    logger.error(error);
    return "";
  }
}

async function processResponse(response: LettaResponse): Promise<string> {
  if (!response || !response.messages || response.messages.length === 0) {
    logger.error("No messages in response");
    return "";
  }

  for (const message of response.messages) {
    if (message.messageType === "tool_call_message") {
      if (message.toolCall.name === "send_response" && message.toolCall.arguments) {
        const args: SendResponseArgs = JSON.parse(message.toolCall.arguments);

        if (!args.is_responding) {
          return "";
        }
        return args.message;
      }
    }
  }
  logger.error("No message found in response");
  return "";
}
