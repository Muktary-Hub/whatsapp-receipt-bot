// --- Dependencies ---
const { Client, LocalAuth } = require('whatsapp-web.js');
const { MongoClient } = require('mongodb');

// --- Configuration ---
const MONGO_URI = process.env.MONGO_URI; // Read from Railway's environment variables
const DB_NAME = 'receiptBot';

// --- Database Connection & State Management ---
let db;
// This map acts as our bot's short-term memory for conversations.
// It will store states like: { 'whatsapp_number': 'awaiting_brand_name' }
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
    // This QR logic is kept for the rare case you need to re-authenticate.
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
    const senderId = msg.from;
    const text = msg.body.trim();
    const lowerCaseText = text.toLowerCase();

    // The 'ping' command should always work, regardless of state.
    if (lowerCaseText === 'ping') {
        await msg.reply('pong');
        console.log(`Responded to ping from ${senderId}`);
        return; // Stop further processing
    }

    // Get the user's current conversation state from our short-term memory
    const currentState = userStates.get(senderId);

    // --- State-Based Conversation Logic ---

    // 1. Handle user responding with their BRAND NAME
    if (currentState === 'awaiting_brand_name') {
        const brandName = text;
        console.log(`Received brand name "${brandName}" from ${senderId}`);
        
        // Create a new user record in the database
        await db.collection('users').insertOne({
            userId: senderId,
            brandName: brandName,
            onboardingComplete: false,
            createdAt: new Date()
        });

        await msg.reply(`Great! Your brand is "${brandName}".\n\nNow, what is your brand's main color? (e.g., #FF5733 or "orange")`);
        
        // Update user's state to the next step
        userStates.set(senderId, 'awaiting_brand_color');
        return;
    }

    // 2. Handle user responding with their BRAND COLOR
    if (currentState === 'awaiting_brand_color') {
        const brandColor = text;
        console.log(`Received brand color "${brandColor}" from ${senderId}`);

        // Update their record in the database
        await db.collection('users').updateOne(
            { userId: senderId },
            { $set: { brandColor: brandColor } }
        );

        await msg.reply(`Got it! Your brand color is ${brandColor}.\n\n*Onboarding complete!* You can now start creating receipts. (This feature is coming next).`);
        
        // Onboarding for this stage is done, so we clear their state.
        userStates.delete(senderId);
        return;
    }

    // --- Default Logic for New or Idle Users ---

    // Check if the user exists in the database
    const existingUser = await db.collection('users').findOne({ userId: senderId });

    if (!existingUser) {
        // This is a completely new user. Start the onboarding process.
        console.log(`New user detected: ${senderId}. Starting onboarding.`);
        await msg.reply("👋 Welcome to the Receipt Bot!\n\nLet's get your brand set up in about 30 seconds.");
        await msg.reply("First, what is your business or brand name?");

        // Set the state for this user so we know what to expect next
        userStates.set(senderId, 'awaiting_brand_name');
    } else {
        // This is an existing user who is not in the middle of a conversation.
        // We'll add a menu here later.
        console.log(`Existing user ${senderId} sent a message.`);
        await msg.reply("Welcome back! Type *'new receipt'* to begin. (Feature coming soon!)");
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


