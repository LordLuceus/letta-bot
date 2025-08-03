import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { Attachment, Collection } from "discord.js";
import logger from "../logger";

const elevenlabs = new ElevenLabsClient();

const transcriptionCache = new Map<string, string>();

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

export async function getAttachmentDescription(attachments: Collection<string, Attachment>): Promise<string> {
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
