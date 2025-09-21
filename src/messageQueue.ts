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

const client = new LettaClient({
  token: process.env.LETTA_TOKEN || "dummy",
  baseUrl: process.env.LETTA_BASE_URL,
});
const AGENT_ID = process.env.LETTA_AGENT_ID;

// Configurable timing constants
const INITIAL_REQUEST_DELAY_MS = parseInt(process.env.INITIAL_REQUEST_DELAY_MS || "30000", 10); // 30 seconds default
const BATCH_DELAY_MS = parseInt(process.env.BATCH_DELAY_MS || "1000", 10); // 1 second default
const TYPING_PAUSE_DELAY_MS = parseInt(process.env.TYPING_PAUSE_DELAY_MS || "2000", 10); // 2 seconds default

interface TypingState {
  users: Set<string>; // Set of user IDs currently typing
  lastTypingStop: number; // Timestamp of when typing last stopped
}

export class MessageQueueManager {
  private queues = new Map<string, MessageQueue>();
  private typingStates = new Map<string, TypingState>(); // Track typing per channel

  // A dedicated queue for non-channel-specific system messages like timers
  private getSystemQueue(systemId: string): MessageQueue {
    if (!this.queues.has(systemId)) {
      this.queues.set(systemId, new MessageQueue(systemId, this));
    }
    return this.queues.get(systemId)!;
  }

  private getQueueForMessage(discordMessage: OmitPartialGroupDMChannel<Message<boolean>>): MessageQueue {
    const channelId = discordMessage.channelId;
    if (!this.queues.has(channelId)) {
      logger.info(`Creating new message queue for channel: ${channelId}`);
      this.queues.set(channelId, new MessageQueue(channelId, this));
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

  public onTypingStart(channelId: string, userId: string): void {
    if (!this.typingStates.has(channelId)) {
      this.typingStates.set(channelId, { users: new Set(), lastTypingStop: 0 });
    }

    const typingState = this.typingStates.get(channelId)!;
    typingState.users.add(userId);

    logger.debug(`User ${userId} started typing in channel ${channelId}. Active typers: ${typingState.users.size}`);

    // Notify the queue about typing state change
    const queue = this.queues.get(channelId);
    if (queue) {
      queue.onTypingStateChange(true);
    }
  }

  public onTypingStop(channelId: string, userId: string): void {
    const typingState = this.typingStates.get(channelId);
    if (typingState) {
      typingState.users.delete(userId);

      if (typingState.users.size === 0) {
        typingState.lastTypingStop = Date.now();
        logger.debug(`All users stopped typing in channel ${channelId}`);

        // Notify the queue about typing state change
        const queue = this.queues.get(channelId);
        if (queue) {
          queue.onTypingStateChange(false);
        }
      } else {
        logger.debug(`User ${userId} stopped typing in channel ${channelId}. Active typers: ${typingState.users.size}`);
      }
    }
  }

  public isChannelTyping(channelId: string): boolean {
    const typingState = this.typingStates.get(channelId);
    return typingState ? typingState.users.size > 0 : false;
  }

  public getTimeSinceLastTypingStop(channelId: string): number {
    const typingState = this.typingStates.get(channelId);
    return typingState && typingState.lastTypingStop > 0 ? Date.now() - typingState.lastTypingStop : Infinity;
  }

  public shouldWaitForTypingPause(channelId: string): boolean {
    if (this.isChannelTyping(channelId)) {
      return true; // Still typing, definitely wait
    }

    const timeSinceStop = this.getTimeSinceLastTypingStop(channelId);
    return timeSinceStop < TYPING_PAUSE_DELAY_MS; // Wait if typing stopped recently
  }
}

class MessageQueue {
  private queue: QueuedMessage[] = [];
  private processing = false;
  private messageBuffer: QueuedMessage[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private initialDelayTimer: NodeJS.Timeout | null = null;
  private typingPauseTimer: NodeJS.Timeout | null = null;
  private emergencyTimer: NodeJS.Timeout | null = null;
  private isTypingActive = false;
  private readonly channelId: string;
  private readonly messageQueueManager: MessageQueueManager;

  constructor(channelId: string, messageQueueManager: MessageQueueManager) {
    this.channelId = channelId;
    this.messageQueueManager = messageQueueManager;
    // Initialize typing state based on current manager state
    this.isTypingActive = messageQueueManager.isChannelTyping(channelId);
  }

  public onTypingStateChange(isTyping: boolean): void {
    this.isTypingActive = isTyping;

    if (!isTyping) {
      // User stopped typing, start typing pause timer
      this.startTypingPauseTimer();
    } else {
      // User started typing, clear any timers
      this.clearTypingPauseTimer();
    }
  }

  private startTypingPauseTimer(): void {
    this.clearTypingPauseTimer();
    this.typingPauseTimer = setTimeout(() => {
      logger.debug(`Typing pause timer expired for channel ${this.channelId}`);
      this.tryProcessingAfterTypingPause();
    }, TYPING_PAUSE_DELAY_MS);
  }

  private clearTypingPauseTimer(): void {
    if (this.typingPauseTimer) {
      clearTimeout(this.typingPauseTimer);
      this.typingPauseTimer = null;
    }
  }

  private tryProcessingAfterTypingPause(): void {
    // Only proceed if not currently processing
    if (this.processing) return;

    // Process batched messages first (they now contain all messages in chronological order)
    if (this.messageBuffer.length > 0) {
      this.processBatchedMessages();
    } else if (this.queue.length > 0 && !this.initialDelayTimer) {
      this.processNext();
    }
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

      // Always add to batch if we're in any kind of delay state or processing
      if (this.processing || this.batchTimer || this.initialDelayTimer || this.isTypingActive) {
        logger.debug(
          `Message going to batch. State: processing=${this.processing}, batchTimer=${!!this.batchTimer}, initialDelayTimer=${!!this.initialDelayTimer}, isTypingActive=${this.isTypingActive}`,
        );
        // Move any existing queued messages to the batch first
        if (this.queue.length > 0) {
          logger.debug(`Moving ${this.queue.length} queued messages to batch`);
          this.messageBuffer.unshift(...this.queue);
          this.queue = [];
        }
        this.addToBatch(queuedMessage);
      } else {
        // This is the first message after being idle - start initial delay
        this.queue.push(queuedMessage);
        logger.info(`First message queued, starting initial delay. Queue size: ${this.queue.length}`);
        this.startInitialDelay();
      }
    });
  }

  private startInitialDelay(): void {
    if (this.initialDelayTimer) return; // Already running

    this.initialDelayTimer = setTimeout(() => {
      this.initialDelayTimer = null;
      logger.debug(`Initial delay expired for channel ${this.channelId}`);

      // If typing is active, wait for typing to finish
      if (this.isTypingActive) {
        logger.debug(`Typing is active, waiting for typing to finish`);
        return; // Will be handled by tryProcessingAfterTypingPause
      }

      this.processNext();
    }, INITIAL_REQUEST_DELAY_MS);
  }

  private addToBatch(newMessage: QueuedMessage): void {
    // Add new message to buffer
    this.messageBuffer.push(newMessage);

    // Set emergency timer if this is the first message in batch to prevent indefinite sticking
    if (this.messageBuffer.length === 1 && !this.emergencyTimer) {
      const maxWaitTime = Math.max(BATCH_DELAY_MS, TYPING_PAUSE_DELAY_MS) * 2;
      this.emergencyTimer = setTimeout(() => {
        logger.warn(
          `Emergency timer expired! Force processing ${this.messageBuffer.length} stuck messages after ${maxWaitTime}ms`,
        );
        this.emergencyTimer = null;
        this.processBatchedMessages();
      }, maxWaitTime);
    }

    // Clear existing batch timer and reset it
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    // Set new batch timer - this extends the batch window for new messages
    this.batchTimer = setTimeout(() => {
      // Before processing, check if we should wait for typing pause
      if (this.messageQueueManager.shouldWaitForTypingPause(this.channelId)) {
        logger.debug(`Batch timer expired but should wait for typing pause delay`);
        // Calculate remaining time to wait and reschedule
        const timeSinceStop = this.messageQueueManager.getTimeSinceLastTypingStop(this.channelId);
        const remainingWait = TYPING_PAUSE_DELAY_MS - timeSinceStop;

        if (remainingWait > 0) {
          logger.debug(`Rescheduling batch timer for ${remainingWait}ms`);
          this.batchTimer = setTimeout(() => {
            this.processBatchedMessages();
          }, remainingWait);
          return;
        }
      }
      this.processBatchedMessages();
    }, BATCH_DELAY_MS);
  }

  private async processBatchedMessages(): Promise<void> {
    if (this.messageBuffer.length === 0) return;

    this.processing = true;

    const messages = [...this.messageBuffer];
    this.messageBuffer = [];
    this.batchTimer = null;

    // Clear emergency timer since we're processing
    if (this.emergencyTimer) {
      clearTimeout(this.emergencyTimer);
      this.emergencyTimer = null;
    }

    try {
      const logMessage =
        messages.length === 1
          ? `Processing message from batch buffer`
          : `Processing batch of ${messages.length} messages`;
      logger.info(logMessage);
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
      logger.error("Error processing batched messages:", error);
      messages.forEach((msg) => msg.reject(error as Error));
    } finally {
      this.continueProcessing();
    }
  }

  private continueProcessing() {
    this.processing = false;
    // Clear typing pause timer since we just finished processing
    this.clearTypingPauseTimer();

    logger.debug(
      `Continue processing. State: batchTimer=${!!this.batchTimer}, initialDelayTimer=${!!this.initialDelayTimer}, isTypingActive=${this.isTypingActive}, queueLength=${this.queue.length}, bufferLength=${this.messageBuffer.length}`,
    );

    // Only process next message if we're not in any delay mode and typing is not active
    if (!this.batchTimer && !this.initialDelayTimer && !this.isTypingActive) {
      // Process batched messages first (they now contain all messages in chronological order)
      if (this.messageBuffer.length > 0) {
        setImmediate(() => this.processBatchedMessages());
      } else if (this.queue.length > 0) {
        // For queued messages, restart the initial delay to respect the timing
        setImmediate(() => this.startInitialDelay());
      } else {
        logger.debug(`Queue is now idle and ready for initial delay on next message`);
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
      logger.error("Error processing queued message:", error);
      queuedMessage.reject(error as Error);
    } finally {
      this.continueProcessing();
    }
  }

  private async processBatch(messages: QueuedMessage[]): Promise<string> {
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
      const logMessage =
        messageContents.length === 1
          ? `🛜 Sending message to Letta server (agent=${AGENT_ID}): ${JSON.stringify(lettaMessage)}`
          : `🛜 Sending batch of ${messageContents.length} messages as single combined message to Letta server (agent=${AGENT_ID}): ${JSON.stringify(lettaMessage)}`;
      logger.info(logMessage);

      const response = await client.agents.messages.createStream(
        AGENT_ID,
        {
          messages: [lettaMessage],
        },
        {
          timeoutInSeconds: 300,
        },
      );

      if (response) {
        return await processStream(response);
      }

      return "";
    } catch (error) {
      logger.error(error);
      return "";
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

      const response = await client.agents.messages.createStream(
        AGENT_ID,
        {
          messages: [lettaMessage],
        },
        {
          timeoutInSeconds: 300,
        },
      );

      if (response) {
        return await processStream(response);
      }

      return "";
    } catch (error) {
      logger.error(error);
      return "";
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

      const response = await client.agents.messages.createStream(
        AGENT_ID,
        {
          messages: [lettaMessage],
        },
        {
          timeoutInSeconds: 300,
        },
      );

      if (response) {
        return await processStream(response);
      }

      return "";
    } catch (error) {
      logger.error(error);
      return "";
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

      const response = await client.agents.messages.createStream(
        AGENT_ID,
        {
          messages: [lettaMessage],
        },
        {
          timeoutInSeconds: 300,
        },
      );

      if (response) {
        return await processStream(response);
      }

      return "";
    } catch (error) {
      logger.error(error);
      return "";
    }
  }
}
