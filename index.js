// index.js (Corrected)

const express = require('express');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const puppeteer = require('puppeteer'); // <-- 1. IMPORT PUPPETEER
const { Client, LocalAuth } = require('whatsapp-web.js');
const { connectToDB, getDB } = require('./db.js');
const { startTelegramBot } = require('./telegramBot.js');
const { handleMessage } = require('./messageHandler.js');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
const corsOptions = { origin: ['http://smartnaijaservices.com.ng', 'https://smartnaijaservices.com.ng'] };
app.use(cors(corsOptions));

// Main function to start all services
async function startApp() {
    await connectToDB();

    // --- 2. LAUNCH A SHARED BROWSER INSTANCE ---
    console.log('Launching shared browser...');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    console.log('Browser launched successfully.');

    // --- 3. CONFIGURE WHATSAPP TO USE THE SHARED BROWSER ---
    const whatsappClient = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: { browserWSEndpoint: browser.wsEndpoint() } 
    });

    // This object holds all shared clients
    const clients = {
        whatsapp: whatsappClient,
        telegram: null,
        browser: browser // Add the browser to the shared clients
    };

    // --- 4. START THE BOTS, PASSING THE SHARED CLIENTS OBJECT ---
    startTelegramBot(clients);

    whatsappClient.on('qr', qr => {
        qrcode.generate(qr, { small: true });
    });

    whatsappClient.on('ready', () => {
        console.log('✅ WhatsApp client is ready!');
    });

    whatsappClient.on('message', async (msg) => {
        const chat = await msg.getChat();
        if (chat.isGroup) return;

        // Create the standardized message object for the handler
        const messageAdapter = {
            platform: 'whatsapp',
            chatId: msg.from,
            text: msg.body.trim(),
            hasMedia: msg.hasMedia,
            originalMessage: msg,
            downloadMedia: async () => await msg.downloadMedia(),
            reply: async (message, options) => {
                await whatsappClient.sendMessage(msg.from, message, options);
            },
            replyWithFile: async (fileData, caption) => {
                const { MessageMedia } = require('whatsapp-web.js');
                const media = new MessageMedia(fileData.mimeType, fileData.buffer.toString('base64'), fileData.fileName);
                await whatsappClient.sendMessage(msg.from, media, { caption: caption });
            }
        };
        
        await handleMessage(clients, messageAdapter);
    });

    await whatsappClient.initialize();
    
    // --- WEB SERVER AND WEBHOOK LOGIC ---
    app.get('/', (req, res) => res.status(200).send('SmartReceipt Bot Webhook Server is running.'));

    app.post('/webhook', async (req, res) => {
        const db = getDB();
        try {
            console.log("Webhook received from PaymentPoint!");
            const data = req.body;
    
            if (data?.customer?.email) {
                let phone = data.customer.email.split('@')[0];
                if (phone.startsWith('0') && phone.length === 11) { phone = '234' + phone.substring(1); }
                const userId = `${phone}@c.us`;
                
                const expiryDate = new Date();
                expiryDate.setMonth(expiryDate.getMonth() + 6);
    
                const result = await db.collection('users').updateOne(
                    { userId: userId }, 
                    { $set: { isPaid: true, subscriptionExpiryDate: expiryDate } }
                );
    
                if (result.modifiedCount > 0) {
                    console.log(`User ${userId} unlocked successfully.`);
                    const user = await db.collection('users').findOne({ userId: userId });
                    await clients.whatsapp.sendMessage(userId, `✅ *Payment Confirmed!* Thank you, ${user.brandName}.\n\nYour subscription is now active until ${expiryDate.toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })}.`);
                }
            }
            res.status(200).send('Webhook processed');
        } catch (error) {
            console.error("Error processing webhook:", error);
            res.status(500).send('Error processing webhook');
        }
    });

    app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
}

startApp();

