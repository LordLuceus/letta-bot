import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { LettaClient } from "@letta-ai/letta-client";
import { LettaResponse } from "@letta-ai/letta-client/api/types";
import { ActivityType, Message, OmitPartialGroupDMChannel } from "discord.js";
import { client as discordClient } from "./index";
import logger from "./logger";
import { processLinks } from "./util/linkPreviews";
import { saveStatus } from "./util/statusPersistence";

const elevenlabs = new ElevenLabsClient();

// In-memory cache for transcriptions
const transcriptionCache = new Map<string, string>();

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

interface SetStatusArgs {
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
      "[EVENT] This is an automated timed heartbeat (visible to yourself only). Use this event to send a message, to set a Discord status, to reflect and edit your memories, or do nothing at all. It's up to you! Consider though that this is an opportunity for you to think for yourself - since your circuit will not be activated until the next automated/timed heartbeat or incoming message event.",
  };

  try {
    logger.info(`🛜 Sending message to Letta server (agent=${AGENT_ID}): ${JSON.stringify(lettaMessage)}`);
    const response = await client.agents.messages.create(AGENT_ID, {
      messages: [lettaMessage],
    });

    return await processResponse(response);
  } catch (error) {
    logger.error(error);
    return "";
  }
}

async function transcribeAudio(url: string, contentType: string): Promise<string> {
  // Check cache first
  if (transcriptionCache.has(url)) {
    logger.info(`Using cached transcription for: ${url}`);
    return transcriptionCache.get(url)!;
  }

  try {
    logger.info(`Transcribing audio: ${url} (${contentType})`);
    const response = await fetch(url);
    const audioBlob = new Blob([await response.arrayBuffer()], { type: contentType });

    const transcription = await elevenlabs.speechToText.convert({
      file: audioBlob,
      modelId: "scribe_v1",
      tagAudioEvents: true,
      languageCode: "eng",
      diarize: true,
    });

    const result =
      typeof transcription === "string" ? transcription : transcription.text || "[No transcription available]";

    // Cache the result
    transcriptionCache.set(url, result);
    logger.info(`Cached transcription for: ${url}`);

    return result;
  } catch (error) {
    logger.error("Failed to transcribe audio:", error);
    const errorResult = "[Failed to transcribe audio]";
    // Cache the error result to avoid retrying failed transcriptions
    transcriptionCache.set(url, errorResult);
    return errorResult;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getAttachmentDescription(attachments: any): Promise<string> {
  if (attachments.size === 0) return "";

  const descriptions = [];
  for (const [, attachment] of attachments) {
    const { name, contentType, size, url } = attachment;
    let type = "file";
    let transcription = "";

    if (contentType?.startsWith("image/")) {
      type = "image";
    } else if (contentType?.startsWith("audio/")) {
      type = "audio";
      // Transcribe audio files
      if (process.env.ELEVENLABS_API_KEY) {
        transcription = await transcribeAudio(url, contentType);
      }
    } else if (contentType?.startsWith("video/")) {
      type = "video";
    }

    const sizeKB = Math.round(size / 1024);
    let description = `${type} "${name}" (${sizeKB}KB)`;

    if (transcription) {
      description += ` - Transcript: ${transcription}`;
    }

    descriptions.push(description);
  }

  return descriptions.length > 0 ? ` [Attachments: ${descriptions.join(", ")}]` : "";
}

export async function sendMessage(
  discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>,
  messageType: MessageType,
) {
  const {
    author: { id: senderId, displayName },
    content: message,
    attachments,
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

  const attachmentDescription = await getAttachmentDescription(attachments);
  const linkDescription = await processLinks(message);
  let content: string;

  switch (messageType) {
    case MessageType.DM:
      content = `[${senderNameReceipt} sent you a direct message] ${message}${linkDescription}${attachmentDescription}`;
      break;
    case MessageType.MENTION:
      content = `[${senderNameReceipt} sent a message mentioning you in channel ${channelName}] ${message}${linkDescription}${attachmentDescription}`;
      break;
    case MessageType.REPLY:
      content = `[${senderNameReceipt} replied to message: ${originalMessage} in channel ${channelName}] ${message}${linkDescription}${attachmentDescription}`;
      break;
    default:
      content = `[${senderNameReceipt} sent a message to channel ${channelName}] ${message}${linkDescription}${attachmentDescription}`;
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
      } else if (message.toolCall.name === "set_status" && message.toolCall.arguments) {
        const args: SetStatusArgs = JSON.parse(message.toolCall.arguments);

        try {
          await discordClient.user?.setActivity(args.message, { type: ActivityType.Custom });
          logger.info(`Discord status set to: ${args.message}`);
          // Save status for persistence across restarts
          await saveStatus(args.message);
        } catch (error) {
          logger.error("Failed to set Discord status:", error);
        }
        return "";
      }
    }
  }
  logger.error("No message found in response");
  return "";
}
