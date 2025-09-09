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

// Helper function for delayed sending
function sendMessageWithDelay(msg, text) {
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
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

// --- Event Handlers ---
client.on('qr', qr => {
    console.log('QR CODE RECEIVED!');
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
    if (lowerCaseText === 'new receipt' || lowerCaseText === 'changereceipt') {
        const user = await db.collection('users').findOne({ userId: senderId });
        if (user && user.onboardingComplete) {
            if (lowerCaseText === 'changereceipt' || !user.preferredTemplate) {
                userStates.set(senderId, { state: 'awaiting_template_choice' });
                await sendMessageWithDelay(msg, "Please choose your receipt template.\n\nView our designs in the catalog, then send the number of your choice (1-5).");
            } else {
                userStates.set(senderId, { state: 'receipt_customer_name', receiptData: {} });
                await sendMessageWithDelay(msg, '🧾 *New Receipt Started*\n\nWho is the customer?');
            }
        } else {
            // User is not onboarded yet, trigger onboarding.
            userStates.set(senderId, { state: 'awaiting_brand_name' });
            await sendMessageWithDelay(msg, "👋 Welcome to SmartReceipt!\n\nLet's get your brand set up. First, what is your business or brand name?");
        }
        return;
    }

    // --- State-Based Conversation Logic ---
    switch (currentState) {
        // ONBOARDING FLOW (COMPLETE VERSION)
        case 'awaiting_brand_name':
            await db.collection('users').insertOne({ userId: senderId, brandName: text, onboardingComplete: false, createdAt: new Date() });
            userStates.set(senderId, { state: 'awaiting_brand_color' });
            await sendMessageWithDelay(msg, `Great! Your brand is "${text}".\n\nNow, what is your brand's main color? (e.g., #001232 or "blue")`);
            break;

        case 'awaiting_brand_color':
            await db.collection('users').updateOne({ userId: senderId }, { $set: { brandColor: text } });
            userStates.set(senderId, { state: 'awaiting_address' });
            await sendMessageWithDelay(msg, `Got it! Your brand color is ${text}.\n\nNext, please provide your business address.`);
            break;

        case 'awaiting_address':
            await db.collection('users').updateOne({ userId: senderId }, { $set: { address: text } });
            userStates.set(senderId, { state: 'awaiting_contact_info' });
            await sendMessageWithDelay(msg, `Address saved.\n\nFinally, what contact info should be on the receipt? (e.g., a phone number or email)`);
            break;

        case 'awaiting_contact_info':
            await db.collection('users').updateOne({ userId: senderId }, { $set: { contactInfo: text, onboardingComplete: true } });
            userStates.delete(senderId); // End the onboarding session
            await sendMessageWithDelay(msg, `✅ *Setup Complete!* Your brand profile is all set.\n\nTo create your first receipt, just type the command:\n*'new receipt'*`);
            break;

        // RECEIPT FLOW
        case 'awaiting_template_choice':
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
        
        // (Add other receipt states here: items, prices, payment_method)
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


