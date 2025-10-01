import axios from 'axios';

// Get credentials from environment variables
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

/**
 * Sends a WhatsApp message using the official Cloud API.
 * @param {string} recipientPhoneNumber - The user's phone number in international format (e.g., 2348123456789).
 * @param {string} messageText - The text message to send.
 */
async function sendMessage(recipientPhoneNumber, messageText) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: recipientPhoneNumber,
        text: {
          body: messageText,
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`Message sent to ${recipientPhoneNumber}`);
  } catch (error) {
    console.error(
      "Error sending WhatsApp message:",
      error.response ? error.response.data : error.message
    );
  }
}

// You can add more functions here later for sending images, documents, etc.

export { sendMessage };
