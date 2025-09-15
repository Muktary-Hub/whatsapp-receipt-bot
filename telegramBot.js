// telegramBot.js

const TelegramBot = require('node-telegram-bot-api');
const { getDB } = require('./db.js');

// --- DEBUGGING LINE ---
// This will print the exact token your app is reading to the logs.
console.log("Reading Token: [" + process.env.TELEGRAM_BOT_TOKEN + "]");

const token = process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.trim() : null;

/**
 * This function initializes and runs the Telegram bot.
 */
function startTelegramBot() {
    // Fails silently if the token is not provided in environment variables
    if (!token) {
        console.log("TELEGRAM_BOT_TOKEN not found. Skipping Telegram bot start.");
        return;
    }

    const bot = new TelegramBot(token, { polling: true });
    const db = getDB();
    console.log('✅ Telegram Bot is running and listening for messages...');

    // Main listener for all incoming messages
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;

        // Ignore any messages that are not text (like images, stickers, etc.)
        if (!text) return;

        try {
            // Find the user by their unique Telegram ID to see if they are already linked
            let user = await db.collection('users').findOne({ telegramId: chatId });

            // Handle the /start command, which is used for linking accounts
            if (text.startsWith('/start')) {
                const parts = text.split(' ');
                const backupCode = parts[1]; // The code the user provides, e.g., /start A1B2

                if (user) {
                    bot.sendMessage(chatId, `👋 Welcome back, ${user.brandName}! Your account is already linked. Type /commands to see what I can do.`);
                    return;
                }

                // If the user just types /start without a code
                if (!backupCode) {
                    bot.sendMessage(chatId, "👋 Welcome! To sync with your WhatsApp account, please use the `backup` command on WhatsApp to get your code, then come back here and type:\n\n`/start YOUR_CODE`");
                    return;
                }
                
                // If they provided a code, look for a user with that backup code
                const userToLink = await db.collection('users').findOne({ backupCode: backupCode.toUpperCase() });

                if (!userToLink) {
                    bot.sendMessage(chatId, "❌ Sorry, that backup code is not valid. Please double-check the code from WhatsApp and try again.");
                    return;
                }

                // If the code is valid, link the account by saving their Telegram ID to their user record
                await db.collection('users').updateOne(
                    { _id: userToLink._id },
                    { $set: { telegramId: chatId } }
                );
                
                bot.sendMessage(chatId, `✅ *Account Synced!* Welcome, ${userToLink.brandName}. Your account is now linked to Telegram.\n\nType /commands to get started.`, { parse_mode: 'Markdown' });
                return;
            }
            
            // If we don't recognize the user and they haven't used the /start command, guide them.
            if (!user) {
                bot.sendMessage(chatId, "I don't recognize you yet. Please sync your account using your backup code from WhatsApp.\n\nExample: `/start YOUR_CODE`");
                return;
            }

            // --- Basic Command Handling for Linked Users ---
            if (text.toLowerCase() === '/newreceipt') {
                 bot.sendMessage(chatId, `Okay ${user.brandName}, let's create a new receipt.\n\n*(Full receipt creation on Telegram is coming in the next update!)*`);
            } else if (text.toLowerCase() === '/commands') {
                 const commandsList = "Here are the available commands:\n\n" +
                    "*/newreceipt* - Start creating a new receipt.\n" +
                    "*/history* - See your last 5 receipts.\n" +
                    "*/stats* - View your sales stats for the current month.\n\n" +
                    "_More advanced features are coming soon!_";
                 bot.sendMessage(chatId, commandsList, { parse_mode: 'Markdown' });
            } else {
                // This is the default reply if the bot doesn't understand the command
                bot.sendMessage(chatId, `Hi ${user.brandName}! How can I help? Type /commands to see what I can do on Telegram.`);
            }

        } catch (error) {
            console.error("Error in Telegram message handler:", error);
            bot.sendMessage(chatId, "Sorry, something went wrong on my end. Please try again later.");
        }
    });
}

module.exports = { startTelegramBot };
