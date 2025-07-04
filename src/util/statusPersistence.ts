import { promises as fs } from "fs";
import path from "path";
import logger from "../logger";

const STATUS_FILE_PATH = path.join(process.cwd(), "data", "bot-status.json");

interface StatusData {
  message: string;
  timestamp: number;
}

export async function saveStatus(message: string): Promise<void> {
  try {
    const statusData: StatusData = {
      message,
      timestamp: Date.now(),
    };

    // Ensure data directory exists
    await fs.mkdir(path.dirname(STATUS_FILE_PATH), { recursive: true });

    // Write status to file
    await fs.writeFile(STATUS_FILE_PATH, JSON.stringify(statusData, null, 2));

    logger.info(`Status saved: ${message}`);
  } catch (error) {
    logger.error("Failed to save status:", error);
  }
}

export async function loadStatus(): Promise<string | null> {
  try {
    const data = await fs.readFile(STATUS_FILE_PATH, "utf-8");
    const statusData: StatusData = JSON.parse(data);

    logger.info(`Status loaded: ${statusData.message}`);
    return statusData.message;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.info("No saved status found");
    } else {
      logger.error("Failed to load status:", error);
    }
    return null;
  }
}

export async function clearStatus(): Promise<void> {
  try {
    await fs.unlink(STATUS_FILE_PATH);
    logger.info("Status file cleared");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.info("No status file to clear");
    } else {
      logger.error("Failed to clear status:", error);
    }
  }
}
