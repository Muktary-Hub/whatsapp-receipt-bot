// telegramBot.js

const TelegramBot = require('node-telegram-bot-api');
const { handleMessage } = require('./messageHandler.js');

/**
 * Initializes and runs the Telegram bot.
 * @param {object} clients - The shared object containing the whatsapp and telegram client instances.
 * @returns The initialized telegram bot instance.
 */
function startTelegramBot(clients) {
    const token = process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.trim() : null;
    if (!token) {
        console.log("TELEGRAM_BOT_TOKEN not found. Skipping Telegram bot start.");
        return null;
    }

    const bot = new TelegramBot(token, { polling: true });
    clients.telegram = bot; // Add the bot instance to the shared clients object for other files to use
    console.log('✅ Telegram Bot is running and listening for messages...');

    // Listen for any kind of message.
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;

        // We only process text messages
        if (!text) return;
        
        // This is the "adapter". It creates a standardized message object
        // that our central handler can understand, regardless of the platform.
        const messageAdapter = {
            platform: 'telegram',
            chatId: chatId,
            text: text,
            originalMessage: msg,
            // This function allows the central handler to reply without knowing it's talking to Telegram.
            reply: async (message, options) => {
                // The 'Markdown' parse mode allows for bold (*text*) and italics (_text_).
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...options });
            }
        };

        // Send the standardized message to the central brain for processing.
        await handleMessage(clients, messageAdapter);
    });
    
    return bot;
}

module.exports = { startTelegramBot };
