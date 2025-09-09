// --- Dependencies ---
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');

// --- Configuration ---
// These MUST be set in Railway's "Variables" tab for security
const MONGO_URI = process.env.MONGO_URI;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY; 
const RECEIPT_BASE_URL = process.env.RECEIPT_BASE_URL; // e.g., 'http://smartnaijaservices.com.ng/'
const PP_API_KEY = process.env.PP_API_KEY; // PaymentPoint API Key
const PP_SECRET_KEY = process.env.PP_SECRET_KEY; // PaymentPoint Secret Key
const PORT = process.env.PORT || 3000; // Port for webhook server

const DB_NAME = 'receiptBot';
// Admin numbers with unlimited access
const ADMIN_NUMBERS = ['2348146817448@c.us', '2347016370067@c.us'];
const LIFETIME_FEE = 5000;

// --- Database, State, and Web Server ---
let db;
const userStates = new Map();
const app = express();
app.use(express.json()); // Middleware to parse webhook JSON

// --- Database Connection ---
async function connectToDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db(DB_NAME);
        console.log('Successfully connected to MongoDB.');
    } catch (error) {
        console.error('Failed to connect to MongoDB', error);
        process.exit(1);
    }
}

// --- Helper Functions ---
function sendMessageWithDelay(msg, text) {
    const delay = Math.floor(Math.random() * 1000) + 1500;
    return new Promise(resolve => setTimeout(() => msg.reply(text).then(resolve), delay));
}

async function uploadLogo(media) {
    try {
        const imageBuffer = Buffer.from(media.data, 'base64');
        const form = new FormData();
        form.append('image', imageBuffer, { filename: 'logo.png' });

        const response = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form, {
            headers: form.getHeaders()
        });
        
        return response.data.data.display_url;
    } catch (error) {
        console.error("ImgBB upload failed:", error.response ? error.response.data : error.message);
        return null;
    }
}

// --- PAYMENTPOINT INTEGRATION ---
async function generateReservedAccount(user) {
    const options = {
        method: 'POST',
        url: 'https://api.paymentpoint.co/v1/bank/reserve_account',
        headers: {
            'Content-Type': 'application/json',
            'api-key': PP_API_KEY,
            'secret-key': PP_SECRET_KEY
        },
        data: {
            account_name: user.brandName.substring(0, 20),
            customer_email: `${user.userId.split('@')[0]}@smartreceipt.user`,
            customer_phone: user.userId.split('@')[0],
            notification_url: `${process.env.RAILWAY_STATIC_URL}/webhook`, // Use Railway's public URL
            amount: LIFETIME_FEE
        }
    };
    try {
        const response = await axios.request(options);
        return response.data;
    } catch (error) {
        console.error("PaymentPoint Error:", error.response ? error.response.data : error.message);
        return null;
    }
}

// --- WEBHOOK LISTENER ---
app.post('/webhook', async (req, res) => {
    try {
        console.log("Webhook received from PaymentPoint!");
        const data = req.body;
        
        if (data && data.customer_phone) {
            const userId = `${data.customer_phone}@c.us`;
            console.log(`Payment received for user: ${userId}`);

            const result = await db.collection('users').updateOne(
                { userId: userId },
                { $set: { isPaid: true } }
            );

            if (result.modifiedCount > 0) {
                console.log(`User ${userId} unlocked successfully.`);
                await client.sendMessage(userId, `✅ *Payment Confirmed!* Thank you.\n\nYour SmartReceipt account now has lifetime access to unlimited receipts.`);
            }
        }
        res.status(200).send('Webhook processed');
    } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).send('Error processing webhook');
    }
});

// --- WhatsApp Client Initialization ---
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    }
});

client.on('qr', qr => console.log(qr));
client.on('ready', () => console.log('WhatsApp client is ready!'));

// --- Main Message Handling Logic ---
client.on('message', async msg => {
    try {
        const chat = await msg.getChat();
        if (chat.isGroup || msg.isStatus) return;

        const senderId = msg.from;
        const text = msg.body.trim();
        const lowerCaseText = text.toLowerCase();
        
        const userSession = userStates.get(senderId) || {};
        const currentState = userSession.state;

        if (['new receipt', 'changereceipt'].includes(lowerCaseText)) {
            const user = await db.collection('users').findOne({ userId: senderId });
            if (user && user.onboardingComplete) {
                if (lowerCaseText === 'changereceipt' || !user.preferredTemplate) {
                    userStates.set(senderId, { state: 'awaiting_template_choice' });
                    await sendMessageWithDelay(msg, "Please choose your receipt template.\n\nView our 6 high-class designs in the catalog, then send the number of your choice (1-6).");
                } else {
                    userStates.set(senderId, { state: 'receipt_customer_name', receiptData: {} });
                    await sendMessageWithDelay(msg, '🧾 *New Receipt Started*\n\nWho is the customer?');
                }
            } else {
                userStates.set(senderId, { state: 'awaiting_brand_name' });
                await sendMessageWithDelay(msg, "👋 Welcome to SmartReceipt!\n\nLet's get your brand set up. First, what is your business name?");
            }
            return;
        }

        switch (currentState) {
            case 'awaiting_brand_name':
                await db.collection('users').deleteMany({ userId: senderId });
                await db.collection('users').insertOne({ userId: senderId, brandName: text, onboardingComplete: false, receiptCount: 0, isPaid: false });
                userStates.set(senderId, { state: 'awaiting_brand_color' });
                await sendMessageWithDelay(msg, `Great! Your brand is "${text}".\n\nWhat's your brand's main color? (e.g., #1D4ED8 or "blue")`);
                break;
            case 'awaiting_brand_color':
                await db.collection('users').updateOne({ userId: senderId }, { $set: { brandColor: text } });
                userStates.set(senderId, { state: 'awaiting_logo' });
                await sendMessageWithDelay(msg, `Color saved!\n\nNow, please upload your business logo. If you don't have one, just type *'skip'*.`);
                break;
            case 'awaiting_logo':
                if (msg.hasMedia) {
                    const media = await msg.downloadMedia();
                    await sendMessageWithDelay(msg, "Logo received! Uploading now, please wait...");
                    const logoUrl = await uploadLogo(media);
                    if (logoUrl) {
                        await db.collection('users').updateOne({ userId: senderId }, { $set: { logoUrl: logoUrl } });
                        await sendMessageWithDelay(msg, "Logo uploaded successfully!");
                    } else {
                        await sendMessageWithDelay(msg, "Sorry, I couldn't upload the logo. We'll proceed without it for now.");
                    }
                } else if (lowerCaseText !== 'skip') {
                    await sendMessageWithDelay(msg, "That's not an image. Please upload a logo file or type 'skip'.");
                    return;
                }
                userStates.set(senderId, { state: 'awaiting_address' });
                await sendMessageWithDelay(msg, `Logo step complete.\n\nNext, what is your business address?`);
                break;
            case 'awaiting_address':
                await db.collection('users').updateOne({ userId: senderId }, { $set: { address: text } });
                userStates.set(senderId, { state: 'awaiting_contact_info' });
                await sendMessageWithDelay(msg, `Address saved.\n\nFinally, what contact info should be on the receipt? (e.g., a phone number or email)`);
                break;
            case 'awaiting_contact_info':
                await db.collection('users').updateOne({ userId: senderId }, { $set: { contactInfo: text, onboardingComplete: true } });
                userStates.delete(senderId);
                await sendMessageWithDelay(msg, `✅ *Setup Complete!* Your brand profile is all set.\n\nTo create your first receipt, just type:\n*'new receipt'*`);
                break;
            case 'awaiting_template_choice':
                const choice = parseInt(text, 10);
                if (choice >= 1 && choice <= 6) {
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { preferredTemplate: choice } });
                    userStates.set(senderId, { state: 'receipt_customer_name', receiptData: {} });
                    await sendMessageWithDelay(msg, `✅ Template #${choice} saved!\n\nNow, let's create your receipt. Who is the customer?`);
                } else {
                    await sendMessageWithDelay(msg, "Invalid selection. Please send a single number between 1 and 6.");
                }
                break;
            case 'receipt_customer_name':
                userSession.receiptData.customerName = text;
                userSession.state = 'receipt_items';
                userStates.set(senderId, userSession);
                await sendMessageWithDelay(msg, `Customer: ${text}\n\nWhat item(s) did they purchase? (Separate with commas)`);
                break;
            case 'receipt_items':
                userSession.receiptData.items = text.split(',').map(item => item.trim());
                userSession.state = 'receipt_prices';
                userStates.set(senderId, userSession);
                await sendMessageWithDelay(msg, `Items saved.\n\nNow, enter the price for each item in the same order, separated by commas.`);
                break;
            case 'receipt_prices':
                userSession.receiptData.prices = text.split(',').map(price => price.trim());
                if (userSession.receiptData.items.length !== userSession.receiptData.prices.length) {
                    await sendMessageWithDelay(msg, `⚠️ Items and prices don't match. Please enter the prices again.`);
                    return; 
                }
                userSession.state = 'receipt_payment_method';
                userStates.set(senderId, userSession);
                await sendMessageWithDelay(msg, `Prices saved.\n\nWhat was the payment method?`);
                break;
            case 'receipt_payment_method':
                userSession.receiptData.paymentMethod = text;
                const user = await db.collection('users').findOne({ userId: senderId });

                const isAdmin = ADMIN_NUMBERS.includes(senderId);
                if (!isAdmin && !user.isPaid && user.receiptCount >= 1) {
                    await sendMessageWithDelay(msg, "You've used your 1 free receipt. Generating a secure payment account for you now...");
                    const accountDetails = await generateReservedAccount(user);
                    if (accountDetails && accountDetails.bank_name) {
                        const reply = `To get lifetime access, please transfer *₦${LIFETIME_FEE.toLocaleString()}* to this account:\n\n` +
                                      `*Bank:* ${accountDetails.bank_name}\n` +
                                      `*Account Number:* ${accountDetails.account_number}\n` +
                                      `*Amount:* ₦${LIFETIME_FEE.toLocaleString()}\n\n` +
                                      `Your access will be unlocked automatically the moment you pay.`;
                        await msg.reply(reply);
                    } else {
                        await msg.reply("Sorry, I couldn't generate a payment account right now. Please try again later.");
                    }
                    userStates.delete(senderId);
                    return;
                }

                await sendMessageWithDelay(msg, `✅ *Details collected!* Generating your high-class receipt, please wait...`);
                
                const urlParams = new URLSearchParams({
                    bn: user.brandName, bc: user.brandColor,
                    logo: user.logoUrl || '',
                    cn: userSession.receiptData.customerName,
                    items: userSession.receiptData.items.join('||'),
                    prices: userSession.receiptData.prices.join(','),
                    pm: userSession.receiptData.paymentMethod,
                    addr: user.address || '', 
                    ci: user.contactInfo || ''
                });
                
                const fullUrl = `${RECEIPT_BASE_URL}template.${user.preferredTemplate}.html?${urlParams.toString()}`;
                console.log(`Generating receipt from URL: ${fullUrl}`);

                const page = await client.pupBrowser.newPage();
                await page.setViewport({ width: 800, height: 800, deviceScaleFactor: 2 });
                await page.goto(fullUrl, { waitUntil: 'networkidle0' });
                const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
                await page.close();

                const media = new MessageMedia('image/png', screenshotBuffer.toString('base64'), 'SmartReceipt.png');
                await client.sendMessage(senderId, media, { caption: `Here is the receipt for ${userSession.receiptData.customerName}.` });

                if (!isAdmin && !user.isPaid) {
                    await db.collection('users').updateOne({ userId: senderId }, { $inc: { receiptCount: 1 } });
                }
                
                userStates.delete(senderId);
                break;
            default:
                const existingUser = await db.collection('users').findOne({ userId: senderId });
                if (!existingUser || !existingUser.onboardingComplete) {
                    userStates.set(senderId, { state: 'awaiting_brand_name' });
                    await sendMessageWithDelay(msg, "👋 Welcome to SmartReceipt!\n\nTo get started, what is your business or brand name?");
                } else {
                    await sendMessageWithDelay(msg, `Welcome back, ${existingUser.brandName}!\n\nType *'new receipt'* to begin.`);
                }
        }
    } catch (err) {
        console.error("An error occurred in message handler:", err);
    }
});

// --- Main Function ---
async function startBot() {
    if (!MONGO_URI || !IMGBB_API_KEY || !RECEIPT_BASE_URL || !PP_API_KEY || !PP_SECRET_KEY) {
        console.error("FATAL ERROR: Missing required environment variables.");
        process.exit(1);
    }
    await connectToDB();
    client.initialize();
    app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
}

startBot();

