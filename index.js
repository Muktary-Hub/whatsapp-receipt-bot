// --- Dependencies ---
const { Client, LocalAuth } = require('whatsapp-web.js');
const { MongoClient } = require('mongodb');

// --- Configuration ---
const MONGO_URI = process.env.MONGO_URI; 
const DB_NAME = 'receiptBot';

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

// Helper function for delayed sending to appear more human
function sendMessageWithDelay(msg, text) {
    // Random delay between 1.5 and 2.5 seconds
    const delay = Math.floor(Math.random() * 1000) + 1500; 
    return new Promise(resolve => {
        setTimeout(async () => {
            const sentMessage = await msg.reply(text);
            resolve(sentMessage);
        }, delay);
    });
}

// --- WhatsApp Client Initialization ---
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: '/app/.wwebjs_auth' 
    }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

// --- Event Handlers ---
client.on('qr', qr => {
    console.log('QR CODE RECEIVED! See instructions below to scan.');
    console.log('--- QR STRING START ---');
    console.log(qr);
    console.log('--- QR STRING END ---');
});

client.on('ready', () => {
    console.log('WhatsApp client is ready!');
});

// --- Main Message Handling Logic ---
client.on('message', async msg => {
    const chat = await msg.getChat();
    if (chat.isGroup || msg.isStatus) return;

    const senderId = msg.from;
    const text = msg.body.trim();
    const lowerCaseText = text.toLowerCase();
    
    const userSession = userStates.get(senderId) || {};
    const currentState = userSession.state;

    // --- Command Handling ---
    if (lowerCaseText === 'new receipt') {
        const user = await db.collection('users').findOne({ userId: senderId });
        if (user && user.onboardingComplete) {
            if (user.preferredTemplate) {
                userStates.set(senderId, { state: 'receipt_customer_name', receiptData: {} });
                await sendMessageWithDelay(msg, '🧾 *New Receipt Started*\n\nWho is the customer?');
            } else {
                userStates.set(senderId, { state: 'receipt_awaiting_template_choice' });
                await sendMessageWithDelay(msg, "First, please choose your preferred receipt template.\n\nPlease view our designs in the catalog, then send the number of your choice (1-5).");
            }
        } else {
            await sendMessageWithDelay(msg, "You need to complete your brand setup first! Just send any message like 'Hi' to get started.");
        }
        return;
    }

    if (lowerCaseText === 'changereceipt') {
        userStates.set(senderId, { state: 'receipt_awaiting_template_choice' });
        await sendMessageWithDelay(msg, "Let's change your receipt style.\n\nPlease view our designs in the catalog, then send the number of your new choice (1-5).");
        return;
    }

    // --- State-Based Conversation Logic ---
    switch (currentState) {
        // RECEIPT FLOW
        case 'receipt_awaiting_template_choice':
            const choice = parseInt(text, 10);
            if (choice >= 1 && choice <= 5) {
                await db.collection('users').updateOne({ userId: senderId }, { $set: { preferredTemplate: choice } });
                userStates.set(senderId, { state: 'receipt_customer_name', receiptData: {} });
                await sendMessageWithDelay(msg, `✅ Template #${choice} saved!\n\nNow, let's create your receipt. Who is the customer?`);
            } else {
                await sendMessageWithDelay(msg, "Invalid selection. Please send a single number between 1 and 5.");
            }
            break;

        case 'receipt_customer_name':
            userSession.receiptData.customerName = text;
            userSession.state = 'receipt_items';
            userStates.set(senderId, userSession);
            await sendMessageWithDelay(msg, `Customer: ${text}\n\nWhat item(s) did they purchase? (Separate with commas, e.g., "Rice, Beans")`);
            break;

        case 'receipt_items':
            userSession.receiptData.items = text.split(',').map(item => item.trim());
            userSession.state = 'receipt_prices';
            userStates.set(senderId, userSession);
            await sendMessageWithDelay(msg, `Items saved.\n\nNow, enter the price for each item in the same order, separated by commas. (e.g., "500, 300")`);
            break;

        case 'receipt_prices':
            userSession.receiptData.prices = text.split(',').map(price => price.trim());
            userSession.state = 'receipt_payment_method';
            userStates.set(senderId, userSession);
            await sendMessageWithDelay(msg, `Prices saved.\n\nWhat was the payment method? (e.g., "Cash", "Bank Transfer")`);
            break;

        case 'receipt_payment_method':
            userSession.receiptData.paymentMethod = text;
            console.log('--- COMPLETE RECEIPT DATA COLLECTED ---', userSession.receiptData);
            await sendMessageWithDelay(msg, `✅ *Details collected!* Generating your receipt now... (Image generation coming next!)`);
            userStates.delete(senderId);
            break;

        // ONBOARDING FLOW
        case 'awaiting_brand_name':
            await db.collection('users').insertOne({ userId: senderId, brandName: text, onboardingComplete: false, createdAt: new Date() });
            userStates.set(senderId, { state: 'awaiting_brand_color' });
            await sendMessageWithDelay(msg, `Great! Your brand is "${text}".\n\nNow, what is your brand's main color? (e.g., #FF5733 or "orange")`);
            break;
        
        // (Add other onboarding states here: brand_color, address, contact_info following the same pattern)
        // ...
        
        default:
            // Default response for users without a current task
            const existingUser = await db.collection('users').findOne({ userId: senderId });
            if (!existingUser) {
                userStates.set(senderId, { state: 'awaiting_brand_name' });
                await sendMessageWithDelay(msg, "👋 Welcome to SmartReceipt!\n\nLet's get your brand set up. First, what is your business or brand name?");
            } else {
                await sendMessageWithDelay(msg, `Welcome back, ${existingUser.brandName}!\n\nType *'new receipt'* to begin or *'changereceipt'* to switch styles.`);
            }
    }
});

// --- Main Function ---
async function startBot() {
    await connectToDB();
    client.initialize();
}

startBot();


