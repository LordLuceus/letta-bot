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

interface QueuedMessage {
  discordMessage: OmitPartialGroupDMChannel<Message<boolean>> | null;
  messageType: MessageType;
  timestamp: number;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
}

class MessageQueue {
  private queue: QueuedMessage[] = [];
  private processing = false;

  async enqueue(
    discordMessage: OmitPartialGroupDMChannel<Message<boolean>>,
    messageType: MessageType,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        discordMessage,
        messageType,
        timestamp: Date.now(),
        resolve,
        reject,
      });

      logger.info(`Message queued. Queue size: ${this.queue.length}`);
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const queuedMessage = this.queue.shift()!;

    try {
      logger.info(`Processing message from queue. Remaining: ${this.queue.length}`);
      let response: string;

      if (queuedMessage.discordMessage === null) {
        // This is a timer message
        response = await this.processTimerMessage();
      } else {
        // This is a regular Discord message
        response = await this.processMessage(queuedMessage.discordMessage, queuedMessage.messageType);
      }

      queuedMessage.resolve(response);
    } catch (error) {
      logger.error("Error processing queued message:", error);
      queuedMessage.reject(error as Error);
    } finally {
      this.processing = false;
      // Process next message if any
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }

  private async processMessage(
    discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>,
    messageType: MessageType,
  ): Promise<string> {
    const {
      author: { id: senderId, displayName },
      content: message,
      attachments,
    } = discordMessageObject;

    const nickname = discordMessageObject.member?.nickname || displayName;

    if (!AGENT_ID) {
      logger.error("Error: LETTA_AGENT_ID is not set");
      return "";
    }

    const senderNameReceipt = `${nickname} (id=${senderId})`;
    const channelName = "name" in discordMessageObject.channel ? discordMessageObject.channel.name || "" : "";

    let originalMessage = "";

    if (messageType === MessageType.REPLY && discordMessageObject.reference?.messageId) {
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
      const response = await client.agents.messages.create(
        AGENT_ID,
        {
          messages: [lettaMessage],
        },
        { timeoutInSeconds: 300 },
      );

      if (response) {
        return await processResponse(response);
      }

      return "";
    } catch (error) {
      logger.error(error);
      return "";
    }
  }

  async enqueueTimerMessage(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timerMessage: QueuedMessage = {
        discordMessage: null,
        messageType: MessageType.GENERIC,
        timestamp: Date.now(),
        resolve,
        reject,
      };

      this.queue.push(timerMessage);
      logger.info(`Timer message queued. Queue size: ${this.queue.length}`);
      this.processNext();
    });
  }

  private async processTimerMessage(): Promise<string> {
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
      logger.info(`🛜 Sending timer message to Letta server (agent=${AGENT_ID}): ${JSON.stringify(lettaMessage)}`);
      const response = await client.agents.messages.create(
        AGENT_ID,
        {
          messages: [lettaMessage],
        },
        { timeoutInSeconds: 300 },
      );

      if (response) {
        return await processResponse(response);
      }

      return "";
    } catch (error) {
      logger.error(error);
      return "";
    }
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  isProcessing(): boolean {
    return this.processing;
  }
}

const messageQueue = new MessageQueue();

interface SetStatusArgs {
  message: string;
}

function truncateMessage(message: string, maxLength: number): string {
  if (message.length > maxLength) {
    return message.substring(0, maxLength - 3) + "..."; // Truncate and add ellipsis
  }
  return message;
}

export async function sendTimerMessage(): Promise<string> {
  return messageQueue.enqueueTimerMessage();
}

export function getQueueStatus(): { size: number; isProcessing: boolean } {
  return {
    size: messageQueue.getQueueSize(),
    isProcessing: messageQueue.isProcessing(),
  };
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

async function readTextFile(url: string, name: string): Promise<string> {
  try {
    logger.info(`Reading text file: ${url} (${name})`);
    const response = await fetch(url);
    const text = await response.text();
    return text;
  } catch (error) {
    logger.error("Failed to read text file:", error);
    return "[Failed to read text file]";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getAttachmentDescription(attachments: any): Promise<string> {
  if (attachments.size === 0) return "";

  const descriptions = [];
  for (const [, attachment] of attachments) {
    const { name, contentType, size, url } = attachment;
    let type = "file";
    let content = "";

    if (contentType?.startsWith("image/")) {
      type = "image";
    } else if (contentType?.startsWith("audio/")) {
      type = "audio";
      // Transcribe audio files
      if (process.env.ELEVENLABS_API_KEY) {
        content = await transcribeAudio(url, contentType);
      }
    } else if (contentType?.startsWith("video/")) {
      type = "video";
    } else if (contentType?.startsWith("text/") || name.endsWith(".txt") || name.endsWith(".md")) {
      type = "text file";
      content = await readTextFile(url, name);
    }

    const sizeKB = Math.round(size / 1024);
    let description = `${type} "${name}" (${sizeKB}KB)`;

    if (content) {
      if (type === "audio") {
        description += ` - Transcript: ${content}`;
      } else if (type === "text file") {
        description += ` - Content: ${content}`;
      }
    }

    descriptions.push(description);
  }

  return descriptions.length > 0 ? ` [Attachments: ${descriptions.join(", ")}]` : "";
}

export async function sendMessage(
  discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>,
  messageType: MessageType,
): Promise<string> {
  return messageQueue.enqueue(discordMessageObject, messageType);
}

async function processResponse(response: LettaResponse): Promise<string> {
  if (!response || !response.messages || response.messages.length === 0) {
    logger.error("No messages in response");
    return "";
  }

  for (const message of response.messages) {
    if (message.messageType === "tool_call_message") {
      if (message.toolCall.name === "set_status" && message.toolCall.arguments) {
        const args: SetStatusArgs = JSON.parse(message.toolCall.arguments);

        try {
          await discordClient.user?.setActivity(args.message, { type: ActivityType.Custom });
          logger.info(`Discord status set to: ${args.message}`);
          // Save status for persistence across restarts
          await saveStatus(args.message);
        } catch (error) {
          logger.error("Failed to set Discord status:", error);
        }
      }
    } else if (message.messageType === "assistant_message") {
      if (typeof message.content === "string" && message.content.trim()) {
        const content = message.content.trim();
        if (content) {
          logger.info(`Letta response: ${content}`);
          return content;
        }
      }
    }
  }
  return "";
}
