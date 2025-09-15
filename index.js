// index.js

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const { connectToDB, getDB } = require('./db.js');
const { startTelegramBot } = require('./telegramBot.js');
const { handleMessage } = require('./messageHandler.js');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
const corsOptions = { origin: ['http://smartnaijaservices.com.ng', 'https://smartnaijaservices.com.ng'] };
app.use(cors(corsOptions));

// --- HELPER FUNCTIONS THAT STAY IN INDEX.JS ---

async function uploadLogo(media) {
    try {
        const imageBuffer = Buffer.from(media.data, 'base64');
        const form = new FormData();
        form.append('image', imageBuffer, { filename: 'logo.png' });
        const response = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, form, { headers: form.getHeaders() });
        return response.data.data.display_url;
    } catch (error) {
        console.error("ImgBB upload failed:", error.response ? error.response.data : error.message);
        return null;
    }
}
module.exports.uploadLogo = uploadLogo;

function parseInputList(text) {
    const normalizedText = text.replace(/\n/g, ',');
    const dirtyParts = normalizedText.split(',');
    const cleanParts = [];
    for (let i = 0; i < dirtyParts.length; i++) {
        const part = dirtyParts[i].trim();
        if (!part) continue;
        const nextPart = (i + 1 < dirtyParts.length) ? dirtyParts[i + 1].trim() : null;
        if (!isNaN(part) && nextPart && nextPart.length === 3 && !isNaN(nextPart)) {
            cleanParts.push(part + nextPart);
            i++; 
        } else {
            cleanParts.push(part);
        }
    }
    return cleanParts.map(p => p.replace(/,/g, ''));
}
module.exports.parseInputList = parseInputList;

// Main function to start all services
async function startApp() {
    await connectToDB();

    const whatsappClient = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    const clients = {
        whatsapp: whatsappClient,
        telegram: null
    };

    const telegramBot = startTelegramBot(clients);
    clients.telegram = telegramBot;

    whatsappClient.on('qr', qr => {
        qrcode.generate(qr, { small: true });
    });

    whatsappClient.on('ready', () => {
        console.log('✅ WhatsApp client is ready!');
    });

    whatsappClient.on('message', async (msg) => {
        const chat = await msg.getChat();
        if (chat.isGroup) return;

        const messageAdapter = {
            platform: 'whatsapp',
            chatId: msg.from,
            text: msg.body.trim(),
            originalMessage: msg,
            hasMedia: msg.hasMedia,
            downloadMedia: async () => await msg.downloadMedia(),
            reply: async (message, options) => {
                await whatsappClient.sendMessage(msg.from, message, options);
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
            console.log("Full Webhook Body:", JSON.stringify(data, null, 2));
    
            if (data?.customer?.email) {
                let phone = data.customer.email.split('@')[0];
                if (phone.startsWith('0') && phone.length === 11) { phone = '234' + phone.substring(1); }
                const userId = `${phone}@c.us`;
                console.log(`Payment successfully matched to user: ${userId}`);
                
                const expiryDate = new Date();
                expiryDate.setMonth(expiryDate.getMonth() + 6);
    
                const result = await db.collection('users').updateOne(
                    { userId: userId }, 
                    { $set: { isPaid: true, subscriptionExpiryDate: expiryDate } }
                );
    
                if (result.modifiedCount > 0) {
                    console.log(`User ${userId} unlocked successfully until ${expiryDate.toLocaleDateString()}.`);
                    await clients.whatsapp.sendMessage(userId, `✅ *Payment Confirmed!* Thank you.\n\nYour SmartReceipt subscription is now active until ${expiryDate.toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })}.`);
                } else {
                     console.log(`Webhook processed, but no user found in DB with ID: ${userId}`);
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
