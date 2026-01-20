import { Letta } from "@letta-ai/letta-client";
import { promises as fs } from "fs";
import path from "path";
import logger from "../logger";

const MAPPINGS_FILE_PATH = path.join(process.cwd(), "data", "conversation-mappings.json");

interface ConversationMappings {
  [channelId: string]: string; // channelId -> conversationId
}

let mappings: ConversationMappings = {};
let client: Letta | null = null;
let agentId: string | null = null;

export function initConversationMappings(lettaClient: Letta, lettaAgentId: string): void {
  client = lettaClient;
  agentId = lettaAgentId;
}

export async function loadConversationMappings(): Promise<void> {
  try {
    const data = await fs.readFile(MAPPINGS_FILE_PATH, "utf-8");
    mappings = JSON.parse(data);
    logger.info(`Loaded ${Object.keys(mappings).length} conversation mappings`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.info("No saved conversation mappings found, starting fresh");
      mappings = {};
    } else {
      logger.error("Failed to load conversation mappings:", error);
      mappings = {};
    }
  }
}

async function saveMappings(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(MAPPINGS_FILE_PATH), { recursive: true });
    await fs.writeFile(MAPPINGS_FILE_PATH, JSON.stringify(mappings, null, 2));
    logger.debug("Conversation mappings saved");
  } catch (error) {
    logger.error("Failed to save conversation mappings:", error);
  }
}

export async function getOrCreateConversation(channelId: string): Promise<string> {
  // Return existing conversation ID if we have one
  if (mappings[channelId]) {
    logger.debug(`Using existing conversation for channel ${channelId}: ${mappings[channelId]}`);
    return mappings[channelId];
  }

  if (!client || !agentId) {
    throw new Error("Conversation mappings not initialized. Call initConversationMappings first.");
  }

  // Create a new conversation for this channel
  logger.info(`Creating new conversation for channel ${channelId}`);
  const conversation = await client.conversations.create({ agent_id: agentId });

  mappings[channelId] = conversation.id;
  await saveMappings();

  logger.info(`Created conversation ${conversation.id} for channel ${channelId}`);
  return conversation.id;
}

export function getConversationId(channelId: string): string | undefined {
  return mappings[channelId];
}
