import { LettaStreamingResponse } from "@letta-ai/letta-client/api/resources/agents/resources/messages/types";
import { Stream } from "@letta-ai/letta-client/core";
import { ActivityType, GuildMember, Message, OmitPartialGroupDMChannel } from "discord.js";
import { client as discordClient } from "./index";
import logger from "./logger";
import { MessageQueueManager } from "./messageQueue";
import { saveStatus } from "./util/statusPersistence";

export enum MessageType {
  DM = "DM",
  MENTION = "MENTION",
  REPLY = "REPLY",
  GENERIC = "GENERIC",
}

const messageQueueManager = new MessageQueueManager();

interface SetStatusArgs {
  message: string;
}

interface SendResponseArgs {
  is_responding: boolean;
  message: string;
}

export function truncateMessage(message: string, maxLength: number): string {
  if (message.length > maxLength) {
    return message.substring(0, maxLength - 3) + "..."; // Truncate and add ellipsis
  }
  return message;
}

export async function sendTimerMessage(): Promise<string> {
  return messageQueueManager.enqueueTimerMessage();
}

export const processStream = async (response: Stream<LettaStreamingResponse>): Promise<string> => {
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
          case "assistant_message":
            if ("content" in chunk && chunk.content) {
              agentMessageResponse += chunk.content;
            }
            break;
          case "tool_call_message":
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
  return messageQueueManager.enqueue(discordMessageObject, messageType);
}

export async function sendMemberJoinMessage(member: GuildMember): Promise<string> {
  return messageQueueManager.enqueueMemberJoinMessage(member);
}
