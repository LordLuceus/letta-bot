import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { LettaClient } from "@letta-ai/letta-client";
import { LettaStreamingResponse } from "@letta-ai/letta-client/api/resources/agents/resources/messages/types";
import { Stream } from "@letta-ai/letta-client/core";
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

interface BatchedMessage {
  discordMessage: OmitPartialGroupDMChannel<Message<boolean>> | null;
  messageType: MessageType;
  timestamp: number;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
}

class MessageQueue {
  private queue: QueuedMessage[] = [];
  private processing = false;
  private currentAbortController: AbortController | null = null;
  private messageBuffer: BatchedMessage[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_DELAY_MS = 150; // Wait 150ms for more messages

  async enqueue(
    discordMessage: OmitPartialGroupDMChannel<Message<boolean>>,
    messageType: MessageType,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const queuedMessage = {
        discordMessage,
        messageType,
        timestamp: Date.now(),
        resolve,
        reject,
      };

      // If we're currently processing OR already batching, add to batch
      if (this.processing || this.batchTimer) {
        if (this.processing) {
          logger.info(`Interrupting current processing to batch new message`);
        } else {
          logger.info(`Adding message to existing batch`);
        }
        this.interruptAndBatch(queuedMessage);
      } else {
        this.queue.push(queuedMessage);
        logger.info(`Message queued. Queue size: ${this.queue.length}`);
        this.processNext();
      }
    });
  }

  private interruptAndBatch(newMessage: QueuedMessage): void {
    // Cancel current request if possible (only if actively processing)
    if (this.processing && this.currentAbortController) {
      this.currentAbortController.abort();
      logger.info("Aborted current request for batching");
    }

    // Add new message to buffer with its promise resolvers
    this.messageBuffer.push({
      discordMessage: newMessage.discordMessage,
      messageType: newMessage.messageType,
      timestamp: newMessage.timestamp,
      resolve: newMessage.resolve,
      reject: newMessage.reject,
    });

    // Clear existing batch timer and reset it
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    // Set new batch timer - this extends the batch window for new messages
    this.batchTimer = setTimeout(() => {
      this.processBatchedMessages();
    }, this.BATCH_DELAY_MS);

    logger.info(`Message added to batch. Buffer size: ${this.messageBuffer.length}`);
  }

  private async processBatchedMessages(): Promise<void> {
    if (this.messageBuffer.length === 0) return;

    this.processing = true;

    const messages = [...this.messageBuffer];
    this.messageBuffer = [];
    this.batchTimer = null;

    try {
      logger.info(`Processing batch of ${messages.length} messages`);
      const response = await this.processBatch(messages);

      // Resolve only the LAST message's promise with the content.
      // Resolve all others with an empty string to unblock them
      // without triggering a duplicate reply.
      messages.forEach((msg, index) => {
        if (index === messages.length - 1) {
          // This is the last message, it gets the real reply.
          logger.debug(`Resolving final message in batch of ${messages.length} with content.`);
          msg.resolve(response);
        } else {
          // These were earlier messages. Fulfill their promise without
          // content so they don't send duplicate replies.
          msg.resolve("");
        }
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
        logger.info("Batch processing was aborted to accommodate new messages. Re-batching...");
        // Prepend the aborted messages to the front of the current buffer.
        // This ensures they are included in the next batch attempt.
        this.messageBuffer.unshift(...messages);

        // Don't reject the promises. Just exit and let the new timer,
        // set by interruptAndBatch, handle the newly combined batch.
        return;
      }
      logger.error("Error processing batched messages:", error);
      messages.forEach((msg) => msg.reject(error as Error));
    } finally {
      this.processing = false;
      // Only process next message if we're not in batching mode
      if (this.queue.length > 0 && !this.batchTimer) {
        logger.info(`Batch processing complete, continuing with ${this.queue.length} remaining messages`);
        setImmediate(() => this.processNext());
      } else if (this.batchTimer) {
        logger.info("Batch timer still active, waiting for batch to complete");
      }
    }
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
      if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
        logger.info("Request was aborted for batching");
        // Add the interrupted message to the batch buffer
        if (queuedMessage.discordMessage !== null) {
          this.messageBuffer.unshift({
            discordMessage: queuedMessage.discordMessage,
            messageType: queuedMessage.messageType,
            timestamp: queuedMessage.timestamp,
            resolve: queuedMessage.resolve,
            reject: queuedMessage.reject,
          });
          logger.info("Added aborted message to batch buffer");
        }
        this.processing = false;
        logger.info("Waiting for batch timer to complete, not processing next message");
        return; // Don't process next, wait for batch timer
      }
      logger.error("Error processing queued message:", error);
      queuedMessage.reject(error as Error);
    } finally {
      this.processing = false;
      // Only process next message if we're not in batching mode
      if (this.queue.length > 0 && !this.batchTimer) {
        logger.info(`Batch processing complete, continuing with ${this.queue.length} remaining messages`);
        setImmediate(() => this.processNext());
      } else if (this.batchTimer) {
        logger.info("Batch timer still active, waiting for batch to complete");
      }
    }
  }

  private async processBatch(messages: BatchedMessage[]): Promise<string> {
    if (!AGENT_ID) {
      logger.error("Error: LETTA_AGENT_ID is not set");
      return "";
    }

    // Create combined content from all messages into a single message
    const messageContents = [];

    for (const { discordMessage, messageType } of messages) {
      if (discordMessage === null) continue; // Skip timer messages in batches

      const content = await this.formatDiscordMessage(discordMessage, messageType);
      messageContents.push(content);
    }

    if (messageContents.length === 0) return "";

    // Combine all messages into a single message with clear separation
    const combinedContent =
      messageContents.length === 1
        ? messageContents[0]
        : `[BATCH: ${messageContents.length} messages received in quick succession]\n\n${messageContents.join("\n\n")}`;

    const lettaMessage = {
      role: "user" as const,
      content: combinedContent,
    };

    try {
      logger.info(
        `🛜 Sending batch of ${messageContents.length} messages as single combined message to Letta server (agent=${AGENT_ID}): ${JSON.stringify(lettaMessage)}`,
      );

      // Create new abort controller for this request
      this.currentAbortController = new AbortController();

      const response = await client.agents.messages.createStream(
        AGENT_ID,
        {
          messages: [lettaMessage],
          assistantMessageToolName: "send_response",
          assistantMessageToolKwarg: "message",
          useAssistantMessage: true,
        },
        {
          timeoutInSeconds: 300,
          abortSignal: this.currentAbortController.signal,
        },
      );

      if (response) {
        return await processStream(response);
      }

      return "";
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
        logger.info("Batch request was aborted");
        throw error;
      }
      logger.error(error);
      return "";
    } finally {
      this.currentAbortController = null;
    }
  }

  private async formatDiscordMessage(
    discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>,
    messageType: MessageType,
  ): Promise<string> {
    const {
      author: { id: senderId, displayName },
      content: message,
      attachments,
    } = discordMessageObject;

    const nickname = discordMessageObject.member?.nickname || displayName;
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

    return content;
  }

  private async processMessage(
    discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>,
    messageType: MessageType,
  ): Promise<string> {
    if (!AGENT_ID) {
      logger.error("Error: LETTA_AGENT_ID is not set");
      return "";
    }

    const content = await this.formatDiscordMessage(discordMessageObject, messageType);
    const lettaMessage = {
      role: "user" as const,
      content,
    };

    try {
      logger.info(`🛜 Sending message to Letta server (agent=${AGENT_ID}): ${JSON.stringify(lettaMessage)}`);

      // Create new abort controller for this request
      this.currentAbortController = new AbortController();

      const response = await client.agents.messages.createStream(
        AGENT_ID,
        {
          messages: [lettaMessage],
          assistantMessageToolName: "send_response",
          assistantMessageToolKwarg: "message",
          useAssistantMessage: true,
        },
        {
          timeoutInSeconds: 300,
          abortSignal: this.currentAbortController.signal,
        },
      );

      if (response) {
        return await processStream(response);
      }

      return "";
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
        logger.info("Request was aborted");
        throw error;
      }
      logger.error(error);
      return "";
    } finally {
      this.currentAbortController = null;
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

      // Timer messages don't interrupt processing
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

      // Create new abort controller for this request
      this.currentAbortController = new AbortController();

      const response = await client.agents.messages.createStream(
        AGENT_ID,
        {
          messages: [lettaMessage],
          assistantMessageToolName: "send_response",
          assistantMessageToolKwarg: "message",
          useAssistantMessage: true,
        },
        {
          timeoutInSeconds: 300,
          abortSignal: this.currentAbortController.signal,
        },
      );

      if (response) {
        return await processStream(response);
      }

      return "";
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
        logger.info("Timer request was aborted");
        throw error;
      }
      logger.error(error);
      return "";
    } finally {
      this.currentAbortController = null;
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

const processStream = async (response: Stream<LettaStreamingResponse>): Promise<string> => {
  let agentMessageResponse = "";
  try {
    for await (const chunk of response) {
      // Handle different message types that might be returned
      if ("messageType" in chunk) {
        switch (chunk.messageType) {
          case "stop_reason":
            logger.info("🛑 Stream stopped:", chunk);
            break;
          case "reasoning_message":
            logger.info("🧠 Reasoning:", chunk);
            break;
          case "tool_call_message":
            logger.info("🔧 Tool call:", chunk);
            // Handle tool calls for status setting
            if ("toolCall" in chunk && chunk.toolCall.name === "set_status" && chunk.toolCall.arguments) {
              const args: SetStatusArgs = JSON.parse(chunk.toolCall.arguments);
              try {
                await discordClient.user?.setActivity(args.message, { type: ActivityType.Custom });
                logger.info(`Discord status set to: ${args.message}`);
                // Save status for persistence across restarts
                await saveStatus(args.message);
              } catch (error) {
                logger.error("Failed to set Discord status:", error);
              }
            } else if ("toolCall" in chunk && chunk.toolCall.name === "send_response" && chunk.toolCall.arguments) {
              const args: SendResponseArgs = JSON.parse(chunk.toolCall.arguments);
              if (args.is_responding) {
                agentMessageResponse += args.message;
              } else {
                logger.info("Agent is not responding, skipping message:", args.message);
              }
            }
            break;
          case "tool_return_message":
            logger.info("🔧 Tool return:", chunk);
            break;
          case "usage_statistics":
            logger.info("📊 Usage stats:", chunk);
            break;
          default:
            logger.info("📨 Unknown message type:", chunk.messageType, chunk);
        }
      } else {
        logger.info("❓ Chunk without messageType:", chunk);
      }
    }
  } catch (error) {
    logger.error("❌ Error processing stream:", error);
    throw error;
  }

  if (agentMessageResponse.trim()) {
    const content = agentMessageResponse.trim();
    logger.info(`Letta response: ${content}`);
    return content;
  }

  return "";
};

export async function sendMessage(
  discordMessageObject: OmitPartialGroupDMChannel<Message<boolean>>,
  messageType: MessageType,
): Promise<string> {
  return messageQueue.enqueue(discordMessageObject, messageType);
}
