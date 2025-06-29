import { LettaClient } from "@letta-ai/letta-client";
import { LettaResponse } from "@letta-ai/letta-client/api/types";
import { Message, OmitPartialGroupDMChannel } from "discord.js";

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

interface IndicateResponseArgs {
  is_responding: boolean;
}

function truncateMessage(message: string, maxLength: number): string {
  if (message.length > maxLength) {
    return message.substring(0, maxLength - 3) + "..."; // Truncate and add ellipsis
  }
  return message;
}

export async function sendTimerMessage() {
  if (!AGENT_ID) {
    console.error("Error: LETTA_AGENT_ID is not set");
    return "";
  }

  const lettaMessage = {
    role: "user" as const,
    content:
      "[EVENT] This is an automated timed heartbeat (visible to yourself only). Use this event to send a message, to reflect and edit your memories, or do nothing at all. It's up to you! Consider though that this is an opportunity for you to think for yourself - since your circuit will not be activated until the next automated/timed heartbeat or incoming message event.",
  };

  try {
    console.log(
      `🛜 Sending message to Letta server (agent=${AGENT_ID}): ${JSON.stringify(lettaMessage)}`
    );
    const response = await client.agents.messages.create(AGENT_ID, {
      messages: [lettaMessage],
    });

    return response || "";
  } catch (error) {
    console.error(error);
    return "";
  }
}

export async function sendMessage(
  discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>,
  messageType: MessageType
) {
  const {
    author: { id: senderId, displayName },
    content: message,
  } = discordMessageObject;

  // Use server nickname for guild messages, fallback to displayName for DMs
  const nickname = discordMessageObject.member?.nickname || displayName;

  if (!AGENT_ID) {
    console.error("Error: LETTA_AGENT_ID is not set");
    return "";
  }

  // We include a sender receipt so that agent knows which user sent the message
  // We also include the Discord ID so that the agent can tag the user with @
  const senderNameReceipt = `${nickname} (id=${senderId})`;

  const channelName =
    "name" in discordMessageObject.channel
      ? discordMessageObject.channel.name || ""
      : "";

  let originalMessage = "";

  if (
    messageType === MessageType.REPLY &&
    discordMessageObject.reference?.messageId
  ) {
    // If the message is a reply, we try to fetch the original message
    const originalMessageObject =
      await discordMessageObject.channel.messages.fetch(
        discordMessageObject.reference.messageId
      );
    originalMessage = truncateMessage(originalMessageObject.content, 100) || "";
  }

  const lettaMessage = {
    role: "user" as const,
    content:
      messageType === MessageType.MENTION
        ? `[${senderNameReceipt} sent a message mentioning you in channel ${channelName}] ${message}`
        : messageType === MessageType.REPLY
          ? `[${senderNameReceipt} replied to previous message: ${originalMessage}] ${message}`
          : messageType === MessageType.DM
            ? `[${senderNameReceipt} sent you a direct message] ${message}`
            : `[${senderNameReceipt} sent a message to channel ${channelName}] ${message}`,
  };

  try {
    console.log(
      `🛜 Sending message to Letta server (agent=${AGENT_ID}): ${JSON.stringify(lettaMessage)}`
    );
    const response = await client.agents.messages.create(AGENT_ID, {
      messages: [lettaMessage],
    });

    if (response) {
      return await processResponse(response);
    }

    return "";
  } catch (error) {
    console.error(error);
    return "";
  }
}

async function processResponse(response: LettaResponse): Promise<string> {
  if (!response || !response.messages || response.messages.length === 0) {
    console.error("No messages in response");
    return "";
  }

  for (const message of response.messages) {
    if (message.messageType === "tool_call_message") {
      if (
        message.toolCall.name === "indicate_response" &&
        message.toolCall.arguments
      ) {
        const args: IndicateResponseArgs = JSON.parse(
          message.toolCall.arguments
        );

        if (!args.is_responding) {
          return "";
        }
        continue;
      }
    } else if (message.messageType === "assistant_message") {
      if (typeof message.content === "string") {
        const content = message.content.trim();
        if (content) {
          console.log(`🛜 Received message from Letta server: ${content}`);
          return content;
        }
      }
    }
  }
  console.error("No message found in response");
  return "";
}
