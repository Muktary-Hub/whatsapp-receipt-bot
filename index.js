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

// --- WhatsApp Client Initialization ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

// --- Event Handlers ---
client.on('qr', qr => {
    console.log('QR CODE RECEIVED! See instructions below to scan.');
    console.log('URL: https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=');
    console.log('--- QR STRING START ---');
    console.log(qr);
    console.log('--- QR STRING END ---');
});

client.on('authenticated', () => {
    console.log('Authentication successful!');
});

client.on('ready', () => {
    console.log('WhatsApp client is ready!');
});

// --- Main Message Handling Logic ---
client.on('message', async msg => {
    const chat = await msg.getChat();
    // Ignore messages from groups AND any message that is a status update.
    if (chat.isGroup || msg.isStatus) {
        return; 
    }

    const senderId = msg.from;
    const text = msg.body.trim();
    const lowerCaseText = text.toLowerCase();

    if (lowerCaseText === 'ping') {
        await msg.reply('pong');
        console.log(`Responded to ping from ${senderId}`);
        return;
    }

    const currentState = userStates.get(senderId);

    // --- State-Based Conversation Logic ---

    // 1. Handle user responding with their BRAND NAME
    if (currentState === 'awaiting_brand_name') {
        const brandName = text;
        console.log(`Received brand name "${brandName}" from ${senderId}`);
        
        await db.collection('users').insertOne({
            userId: senderId,
            brandName: brandName,
            onboardingComplete: false,
            createdAt: new Date()
        });

        await msg.reply(`Great! Your brand is "${brandName}".\n\nNow, what is your brand's main color? (e.g., #FF5733 or "orange")`);
        userStates.set(senderId, 'awaiting_brand_color');
        return;
    }

    // 2. Handle user responding with their BRAND COLOR
    if (currentState === 'awaiting_brand_color') {
        const brandColor = text;
        console.log(`Received brand color "${brandColor}" from ${senderId}`);

        await db.collection('users').updateOne(
            { userId: senderId },
            { $set: { brandColor: brandColor } }
        );

        await msg.reply(`Got it! Your brand color is ${brandColor}.\n\nNext, please provide your business address. This will appear on the receipt.`);
        userStates.set(senderId, 'awaiting_address');
        return;
    }

    // 3. Handle user responding with their ADDRESS
    if (currentState === 'awaiting_address') {
        const address = text;
        console.log(`Received address "${address}" from ${senderId}`);

        await db.collection('users').updateOne(
            { userId: senderId },
            { $set: { address: address } }
        );

        await msg.reply(`Address saved.\n\nFinally, what contact info should be on the receipt? (e.g., your phone number or email)`);
        userStates.set(senderId, 'awaiting_contact_info');
        return;
    }

    // 4. Handle user responding with their CONTACT INFO
    if (currentState === 'awaiting_contact_info') {
        const contactInfo = text;
        console.log(`Received contact info "${contactInfo}" from ${senderId}`);

        await db.collection('users').updateOne(
            { userId: senderId },
            { $set: { contactInfo: contactInfo, onboardingComplete: true } }
        );

        await msg.reply(`✅ *Setup Complete!* Your brand profile is all set.\n\nTo create your first receipt, just type the command:\n*'new receipt'*`);
        userStates.delete(senderId);
        return;
    }

    // --- Default Logic for New or Idle Users ---
    const existingUser = await db.collection('users').findOne({ userId: senderId });

    if (!existingUser) {
        console.log(`New user detected: ${senderId}. Starting onboarding.`);
        // ----> NAME CHANGE IS HERE <----
        await msg.reply("👋 Welcome to SmartReceipt!\n\nLet's get your brand set up in about 30 seconds.");
        await msg.reply("First, what is your business or brand name?");
        userStates.set(senderId, 'awaiting_brand_name');
    } else {
        console.log(`Existing user ${senderId} sent a message.`);
        await msg.reply(`Welcome back, ${existingUser.brandName}!\n\nType *'new receipt'* to begin.`);
    }
});

// --- Main Function ---
async function startBot() {
    console.log('Connecting to database...');
    await connectToDB();
    
    console.log('Initializing WhatsApp client...');
    client.initialize();
}

// Start the bot
startBot();


