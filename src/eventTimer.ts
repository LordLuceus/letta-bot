import { client } from ".";
import logger from "./logger";
import { sendTimerMessage } from "./messages";

const ENABLE_TIMER = process.env.ENABLE_TIMER === "true";
const TIMER_INTERVAL_MINUTES = parseInt(process.env.TIMER_INTERVAL_MINUTES || "30", 10);
const FIRING_PROBABILITY = parseFloat(process.env.FIRING_PROBABILITY || "0.1"); // 10% chance to fire the event
const CHANNEL_ID = process.env.CHANNEL_ID;

export async function startRandomEventTimer() {
  if (!ENABLE_TIMER) {
    logger.info("Timer feature is disabled.");
    return;
  }

  // Set a minimum delay to prevent too-frequent firing (at least 1 minute)
  const minMinutes = 1;
  // Generate random minutes between minMinutes and TIMER_INTERVAL_MINUTES
  const randomMinutes = minMinutes + Math.floor(Math.random() * (TIMER_INTERVAL_MINUTES - minMinutes));

  // Log the next timer interval for debugging
  logger.info(`⏰ Timer scheduled to fire in ${randomMinutes} minutes`);

  const delay = randomMinutes * 60 * 1000; // Convert minutes to milliseconds

  setTimeout(async () => {
    logger.info(`⏰ Timer fired after ${randomMinutes} minutes`);

    // Determine if the event should fire based on the probability
    if (Math.random() < FIRING_PROBABILITY) {
      logger.info(`⏰ Random event triggered (${FIRING_PROBABILITY * 100}% chance)`);

      // Generate the response via the API
      const message = await sendTimerMessage();

      if (message !== "" && CHANNEL_ID) {
        // Send the message to the specified channel
        const channel = await client.channels.fetch(CHANNEL_ID);
        if (channel && "send" in channel) {
          try {
            await channel.send(message);
            logger.info(`Message sent to channel ${CHANNEL_ID}: ${message}`);
          } catch (error) {
            logger.error(`Failed to send message to channel ${CHANNEL_ID}:`, error);
          }
        }
      }
    } else {
      logger.info(`⏰ Random event not triggered (${(1 - FIRING_PROBABILITY) * 100}% chance)`);
    }

    // Schedule the next timer with a small delay to prevent immediate restarts
    setTimeout(() => {
      startRandomEventTimer();
    }, 1000); // 1 second delay before scheduling next timer
  }, delay);
}
