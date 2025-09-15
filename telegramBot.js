// telegramBot.js (Complete)

const TelegramBot = require('node-telegram-bot-api');
const { handleMessage } = require('./messageHandler.js');
const stream = require('stream');

/**
 * Initializes and runs the Telegram bot.
 * @param {object} clients - The shared object for clients { browser }.
 * @returns The initialized telegram bot instance.
 */
function startTelegramBot(clients) {
    const token = process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.trim() : null;
    if (!token) {
        console.log("TELEGRAM_BOT_TOKEN not found. Skipping Telegram bot start.");
        return null;
    }

    const bot = new TelegramBot(token, { polling: true });
    clients.telegram = bot;
    console.log('✅ Telegram Bot is running and listening for messages...');

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;

        // A message might be text-only, or media with a caption.
        const text = msg.text || msg.caption || '';
        const hasMedia = !!(msg.photo || msg.document);
        
        const messageAdapter = {
            platform: 'telegram',
            chatId: chatId.toString(),
            text: text,
            hasMedia: hasMedia,
            originalMessage: msg,

            // Function to reply with simple text
            reply: async (message, options) => {
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...options });
            },

            // Function to send a file (PDF or PNG)
            replyWithFile: async (fileData, caption) => {
                const { buffer, fileName, mimeType } = fileData;
                const fileOptions = {
                    filename: fileName,
                    contentType: mimeType,
                    caption: caption
                };

                if (mimeType === 'application/pdf' || mimeType === 'text/plain') {
                    await bot.sendDocument(chatId, buffer, { caption: caption }, fileOptions);
                } else if (mimeType === 'image/png') {
                    await bot.sendPhoto(chatId, buffer, { caption: caption });
                }
            },

            // Function to download media sent by a user
            downloadMedia: async () => {
                if (!hasMedia) return null;
                
                // Get the file ID from the largest available photo size
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                const fileStream = bot.getFileStream(fileId);

                return new Promise((resolve, reject) => {
                    const chunks = [];
                    fileStream.on('data', (chunk) => chunks.push(chunk));
                    fileStream.on('error', reject);
                    fileStream.on('end', () => {
                        // Return an object compatible with the 'uploadLogo' function
                        resolve({
                            mimetype: 'image/jpeg', // Telegram converts uploads to jpeg
                            data: Buffer.concat(chunks).toString('base64'),
                            filename: `${fileId}.jpg`
                        });
                    });
                });
            }
        };

        await handleMessage(clients, messageAdapter);
    });
    
    return bot;
}

module.exports = { startTelegramBot };
