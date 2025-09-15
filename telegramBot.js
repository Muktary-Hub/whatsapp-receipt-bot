// telegramBot.js

const TelegramBot = require('node-telegram-bot-api');
const { getDB } = require('./db.js');

const token = process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.trim() : null;

/**
 * This function initializes and runs the Telegram bot.
 */
function startTelegramBot() {
    if (!token) {
        console.log("TELEGRAM_BOT_TOKEN not found. Skipping Telegram bot start.");
        return;
    }

    const bot = new TelegramBot(token, { polling: true });
    const db = getDB();
    console.log('✅ Telegram Bot is running and listening for messages...');

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;

        if (!text) return;

        try {
            let user = await db.collection('users').findOne({ telegramId: chatId });

            if (text.startsWith('/start')) {
                const parts = text.split(' ');
                const backupCode = parts[1];

                if (user) {
                    bot.sendMessage(chatId, `👋 Welcome back, ${user.brandName}! Your account is already linked. Type /commands to see what I can do.`);
                    return;
                }
                if (!backupCode) {
                    bot.sendMessage(chatId, "👋 Welcome! To sync with your WhatsApp account, please use the `backup` command on WhatsApp to get your code, then come back here and type:\n\n`/start YOUR_CODE`");
                    return;
                }
                
                const userToLink = await db.collection('users').findOne({ backupCode: backupCode.toUpperCase() });

                if (!userToLink) {
                    bot.sendMessage(chatId, "❌ Sorry, that backup code is not valid. Please double-check the code from WhatsApp and try again.");
                    return;
                }

                await db.collection('users').updateOne(
                    { _id: userToLink._id },
                    { $set: { telegramId: chatId } }
                );
                
                bot.sendMessage(chatId, `✅ *Account Synced!* Welcome, ${userToLink.brandName}. Your account is now linked to Telegram.\n\nType /commands to get started.`, { parse_mode: 'Markdown' });
                return;
            }
            
            if (!user) {
                bot.sendMessage(chatId, "I don't recognize you yet. Please sync your account using your backup code from WhatsApp.\n\nExample: `/start YOUR_CODE`");
                return;
            }

            // --- NEW: Check for an active conversation session ---
            let userSession = await db.collection('conversations').findOne({ telegramId: chatId });
            if (userSession) {
                switch (userSession.state) {
                    case 'adding_product_name':
                        await db.collection('conversations').updateOne(
                            { telegramId: chatId }, 
                            { $set: { state: 'adding_product_price', 'data.newProductName': text } }
                        );
                        bot.sendMessage(chatId, `Got it. What's the price for *${text}*?`, { parse_mode: 'Markdown' });
                        return; // Stop further processing

                    case 'adding_product_price':
                        const price = parseFloat(text.trim().replace(/,/g, ''));
                        if (isNaN(price)) {
                            bot.sendMessage(chatId, "That's not a valid price. Please send only a number.");
                            return; // Stop further processing
                        }
                        const productName = userSession.data.newProductName;
                        await db.collection('products').updateOne(
                            { userId: user.userId, name: { $regex: new RegExp(`^${productName}$`, 'i') } },
                            { $set: { price: price, name: productName, userId: user.userId } },
                            { upsert: true }
                        );
                        await db.collection('conversations').deleteOne({ telegramId: chatId }); // End conversation
                        bot.sendMessage(chatId, `✅ Saved: *${productName}* - ₦${price.toLocaleString()}.\n\nTo add another, just type /addproduct again.`, { parse_mode: 'Markdown' });
                        return; // Stop further processing
                }
            }

            // --- COMMAND HANDLING ---
            const command = text.toLowerCase();

            if (command === '/newreceipt') {
                 bot.sendMessage(chatId, `Okay ${user.brandName}, let's create a new receipt.\n\n*(Full receipt creation on Telegram is coming in the next update!)*`);
            
            } else if (command === '/history') {
                const recentReceipts = await db.collection('receipts').find({ userId: user.userId }).sort({ createdAt: -1 }).limit(5).toArray();
                if (recentReceipts.length === 0) {
                    bot.sendMessage(chatId, "You haven't generated any receipts yet.");
                } else {
                    let historyMessage = "🧾 *Your 5 Most Recent Receipts:*\n\n";
                    recentReceipts.forEach((r, i) => {
                        const receiptDate = r.createdAt.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
                        historyMessage += `*${i + 1}.* For *${r.customerName}* - ₦${r.totalAmount.toLocaleString()} on ${receiptDate}\n`;
                    });
                    bot.sendMessage(chatId, historyMessage, { parse_mode: 'Markdown' });
                }

            } else if (command === '/stats') {
                const now = new Date();
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
                const receipts = await db.collection('receipts').find({ userId: user.userId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }).toArray();
                const totalSales = receipts.reduce((sum, receipt) => sum + receipt.totalAmount, 0);
                const receiptCount = receipts.length;
                const monthName = startOfMonth.toLocaleString('default', { month: 'long' });
                let statsMessage = `📊 *Your Stats for ${monthName}*\n\n*Receipts Generated:* ${receiptCount}\n*Total Sales:* ₦${totalSales.toLocaleString()}`;
                bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });

            } else if (command === '/products') {
                const products = await db.collection('products').find({ userId: user.userId }).sort({name: 1}).toArray();
                if(products.length === 0) {
                    bot.sendMessage(chatId, "You haven't added any products to your catalog yet. Type /addproduct to start.");
                } else {
                    let productList = "📦 *Your Product Catalog*\n\n";
                    products.forEach(p => { productList += `*${p.name}* - ₦${p.price.toLocaleString()}\n`; });
                    bot.sendMessage(chatId, productList, { parse_mode: 'Markdown' });
                }

            } else if (command === '/addproduct') {
                // --- NEW: Start the conversation for adding a product ---
                await db.collection('conversations').updateOne({ telegramId: chatId }, { $set: { state: 'adding_product_name', data: {} } }, { upsert: true });
                bot.sendMessage(chatId, "Let's add a new product. What is the product's name?");

            } else if (command === '/commands') {
                 const commandsList = "Here are the available commands:\n\n" +
                    "*/newreceipt* - Start creating a new receipt.\n" +
                    "*/history* - See your last 5 receipts.\n" +
                    "*/stats* - View your sales stats for the current month.\n" +
                    "*/products* - View your saved product catalog.\n" +
                    "*/addproduct* - Add a new product to your catalog.\n\n" +
                    "_More advanced features are coming soon!_";
                 bot.sendMessage(chatId, commandsList, { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, `Hi ${user.brandName}! How can I help? Type /commands to see what I can do on Telegram.`);
            }

        } catch (error) {
            console.error("Error in Telegram message handler:", error);
            bot.sendMessage(chatId, "Sorry, something went wrong on my end. Please try again later.");
        }
    });
}

module.exports = { startTelegramBot };
