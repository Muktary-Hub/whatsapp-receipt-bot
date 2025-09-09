// --- Dependencies ---
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const FormData = require('form-data');

// --- Configuration ---
// These MUST be set in Railway's "Variables" tab for security
const MONGO_URI = process.env.MONGO_URI;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY; 
const RECEIPT_BASE_URL = process.env.RECEIPT_BASE_URL; // e.g., 'http://smartnaijaservices.com.ng/'

const DB_NAME = 'receiptBot';
// Admin numbers with unlimited access
const ADMIN_NUMBERS = ['2348146817448@c.us', '2347016370067@c.us']; 

// --- Database Connection & State Management ---
let db;
const userStates = new Map();

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

        // --- Command Handling ---
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

        // --- State-Based Conversation Logic ---
        switch (currentState) {
            // ONBOARDING
            case 'awaiting_brand_name':
                await db.collection('users').deleteMany({ userId: senderId });
                await db.collection('users').insertOne({ userId: senderId, brandName: text, onboardingComplete: false, receiptCount: 0, isPaid: false });
                userStates.set(senderId, { state: 'awaiting_brand_color' });
                await sendMessageWithDelay(msg, `Great! Your brand is "${text}".\n\nWhat is your brand's main color? (e.g., #1D4ED8 or "blue")`);
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
                await db.collection('users').updateOne({ userId: senderId }, { $set: { onboardingComplete: true } });
                userStates.delete(senderId);
                await sendMessageWithDelay(msg, `✅ *Setup Complete!* Your brand profile is all set.\n\nTo create your first receipt, just type:\n*'new receipt'*`);
                break;

            // RECEIPT
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

                // BUSINESS LOGIC: Check limits
                const isAdmin = ADMIN_NUMBERS.includes(senderId);
                if (!isAdmin && !user.isPaid && user.receiptCount >= 1) {
                    await sendMessageWithDelay(msg, "You've used your 1 free receipt. Please make a payment to continue generating unlimited receipts.");
                    // We will add the payment link logic here in the next phase
                    userStates.delete(senderId);
                    return;
                }

                await sendMessageWithDelay(msg, `✅ *Details collected!* Generating your high-class receipt, please wait a moment...`);
                
                // Construct the dynamic URL
                const urlParams = new URLSearchParams({
                    bn: user.brandName,
                    bc: user.brandColor,
                    logo: user.logoUrl || 'null',
                    cn: userSession.receiptData.customerName,
                    items: userSession.receiptData.items.join('||'), // Special separator
                    prices: userSession.receiptData.prices.join(','),
                    pm: userSession.receiptData.paymentMethod,
                    ci: user.contactInfo || '' // Pass other info as needed
                });
                
                const fullUrl = `${RECEIPT_BASE_URL}template.${user.preferredTemplate}.html?${urlParams.toString()}`;
                console.log(`Generating receipt from URL: ${fullUrl}`);

                // Use Puppeteer to take a screenshot
                const page = await client.pupBrowser.newPage();
                await page.setViewport({ width: 800, height: 800, deviceScaleFactor: 2 }); // High-res
                await page.goto(fullUrl, { waitUntil: 'networkidle0' });
                const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
                await page.close();

                // Send the image
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
    if (!MONGO_URI || !IMGBB_API_KEY || !RECEIPT_BASE_URL) {
        console.error("FATAL ERROR: Missing required environment variables. Please set MONGO_URI, IMGBB_API_KEY, and RECEIPT_BASE_URL in Railway.");
        process.exit(1);
    }
    await connectToDB();
    client.initialize();
}

startBot();


