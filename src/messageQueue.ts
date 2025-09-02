import { LettaClient } from "@letta-ai/letta-client";
import { GuildMember, Message, OmitPartialGroupDMChannel } from "discord.js";
import logger from "./logger";
import { MessageType, processStream, truncateMessage } from "./messages";
import { getAttachmentDescription } from "./util/attachments";
import { processLinks } from "./util/linkPreviews";

interface QueuedMessage {
  discordMessage: OmitPartialGroupDMChannel<Message<boolean>> | null;
  memberJoinData?: GuildMember;
  messageType: MessageType;
  timestamp: number;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
}

interface BatchedMessage {
  discordMessage: OmitPartialGroupDMChannel<Message<boolean>> | null;
  memberJoinData?: GuildMember;
  messageType: MessageType;
  timestamp: number;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
}

const client = new LettaClient({
  token: process.env.LETTA_TOKEN || "dummy",
  baseUrl: process.env.LETTA_BASE_URL,
});
const AGENT_ID = process.env.LETTA_AGENT_ID;

export class MessageQueueManager {
  private queues = new Map<string, MessageQueue>();

  // A dedicated queue for non-channel-specific system messages like timers
  private getSystemQueue(systemId: string): MessageQueue {
    if (!this.queues.has(systemId)) {
      this.queues.set(systemId, new MessageQueue(systemId));
    }
    return this.queues.get(systemId)!;
  }

  private getQueueForMessage(discordMessage: OmitPartialGroupDMChannel<Message<boolean>>): MessageQueue {
    const channelId = discordMessage.channelId;
    if (!this.queues.has(channelId)) {
      logger.info(`Creating new message queue for channel: ${channelId}`);
      this.queues.set(channelId, new MessageQueue(channelId));
    }
    return this.queues.get(channelId)!;
  }

  public enqueue(
    discordMessage: OmitPartialGroupDMChannel<Message<boolean>>,
    messageType: MessageType,
  ): Promise<string> {
    const queue = this.getQueueForMessage(discordMessage);
    return queue.enqueue(discordMessage, messageType);
  }

  public enqueueTimerMessage(): Promise<string> {
    // Timer messages are not tied to a channel, so they get their own system queue.
    const timerQueue = this.getSystemQueue("__system__");
    return timerQueue.enqueueTimerMessage();
  }

  public enqueueMemberJoinMessage(member: GuildMember): Promise<string> {
    // Member join messages are not tied to a specific channel, use system queue
    const systemQueue = this.getSystemQueue("__system__");
    return systemQueue.enqueueMemberJoinMessage(member);
  }
}

class MessageQueue {
  private queue: QueuedMessage[] = [];
  private processing = false;
  private currentAbortController: AbortController | null = null;
  private messageBuffer: BatchedMessage[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_DELAY_MS = 150; // Wait 150ms for more messages
  private readonly channelId: string;

  constructor(channelId: string) {
    this.channelId = channelId;
  }

  public enqueue(
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
    }

    // Add new message to buffer with its promise resolvers
    this.messageBuffer.push({
      discordMessage: newMessage.discordMessage,
      memberJoinData: newMessage.memberJoinData,
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

      messages.forEach((msg, index) => {
        if (index === messages.length - 1) {
          // This is the last message, it gets the real reply.
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
      this.continueProcessing();
    }
  }

  private continueProcessing() {
    this.processing = false;
    // Only process next message if we're not in batching mode
    if (this.queue.length > 0 && !this.batchTimer) {
      setImmediate(() => this.processNext());
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

      if (queuedMessage.discordMessage === null && !queuedMessage.memberJoinData) {
        // This is a timer message
        response = await this.processTimerMessage();
      } else if (queuedMessage.memberJoinData) {
        // This is a member join message
        response = await this.processMemberJoinMessage(queuedMessage.memberJoinData);
      } else {
        // This is a regular Discord message
        response = await this.processMessage(queuedMessage.discordMessage!, queuedMessage.messageType);
      }

      queuedMessage.resolve(response);
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
        logger.info("Request was aborted for batching");
        // Add the interrupted message to the batch buffer
        if (queuedMessage.discordMessage !== null || queuedMessage.memberJoinData) {
          this.messageBuffer.unshift({
            discordMessage: queuedMessage.discordMessage,
            memberJoinData: queuedMessage.memberJoinData,
            messageType: queuedMessage.messageType,
            timestamp: queuedMessage.timestamp,
            resolve: queuedMessage.resolve,
            reject: queuedMessage.reject,
          });
        }
        this.processing = false;
        return; // Don't process next, wait for batch timer
      }
      logger.error("Error processing queued message:", error);
      queuedMessage.reject(error as Error);
    } finally {
      this.continueProcessing();
    }
  }

  private async processBatch(messages: BatchedMessage[]): Promise<string> {
    if (!AGENT_ID) {
      logger.error("Error: LETTA_AGENT_ID is not set");
      return "";
    }

    // Create combined content from all messages into a single message
    const messageContents = [];

    for (const { discordMessage, memberJoinData, messageType } of messages) {
      if (discordMessage === null && !memberJoinData) continue; // Skip timer messages in batches

      let content: string;
      if (memberJoinData) {
        // Format member join message
        const memberInfo = `${memberJoinData.displayName} (id=${memberJoinData.id})`;
        const guildName = memberJoinData.guild.name;
        const joinedAt = memberJoinData.joinedAt?.toISOString() || "unknown";
        content = `[EVENT] A new member has joined the Discord server "${guildName}": ${memberInfo}. They joined at ${joinedAt}.`;
      } else if (discordMessage) {
        // Format regular Discord message
        content = await this.formatDiscordMessage(discordMessage, messageType);
      } else {
        continue; // Skip if neither message type is present
      }

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

  public enqueueTimerMessage(): Promise<string> {
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

  public enqueueMemberJoinMessage(member: GuildMember): Promise<string> {
    return new Promise((resolve, reject) => {
      const memberJoinMessage: QueuedMessage = {
        discordMessage: null,
        memberJoinData: member,
        messageType: MessageType.GENERIC,
        timestamp: Date.now(),
        resolve,
        reject,
      };

      // Member join messages don't interrupt processing
      this.queue.push(memberJoinMessage);
      logger.info(`Member join message queued for ${member.displayName}. Queue size: ${this.queue.length}`);
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
        "[EVENT] This is an automated timed heartbeat (visible to yourself only). Use this event to send a message, to set a Discord status, to reflect on recent events, or anything else. It's up to you! Consider though that this is an opportunity for you to think for yourself - since your circuit will not be activated until the next automated/timed heartbeat or incoming message event.",
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

  private async processMemberJoinMessage(member: GuildMember): Promise<string> {
    if (!AGENT_ID) {
      logger.error("Error: LETTA_AGENT_ID is not set");
      return "";
    }

    const memberInfo = `${member.displayName} (id=${member.id})`;
    const guildName = member.guild.name;
    const joinedAt = member.joinedAt?.toISOString() || "unknown";

    const lettaMessage = {
      role: "user" as const,
      content: `[EVENT] A new member has joined the Discord server "${guildName}": ${memberInfo}. They joined at ${joinedAt}.`,
    };

    try {
      logger.info(
        `🛜 Sending member join message to Letta server (agent=${AGENT_ID}): ${JSON.stringify(lettaMessage)}`,
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
        logger.info("Member join request was aborted");
        throw error;
      }
      logger.error(error);
      return "";
    } finally {
      this.currentAbortController = null;
    }
  }
}
