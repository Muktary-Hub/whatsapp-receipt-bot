// --- Dependencies ---
const { Client, LocalAuth } = require('whatsapp-web.js');
const { MongoClient } = require('mongodb');

// --- Configuration ---
const MONGO_URI = process.env.MONGO_URI; 
const DB_NAME = 'receiptBot';

// --- Database Connection & State Management ---
let db;
// We now store an object to track state and temporary data
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
    authStrategy: new LocalAuth({
        dataPath: '/app/.wwebjs_auth' // Tell it to use the persistent volume
    }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

// --- Event Handlers ---
client.on('qr', qr => {
    // This will now only run on the very first scan
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

    // Check for a simple 'ping' command for testing
    if (lowerCaseText === 'ping') {
        await msg.reply('pong');
        console.log(`Responded to ping from ${senderId}`);
        return;
    }

    const userSession = userStates.get(senderId) || {};
    const currentState = userSession.state;

    // --- ONBOARDING CONVERSATION ---
    if (currentState && currentState.startsWith('awaiting_')) {
        // (The onboarding logic we already built goes here, but we can simplify)
        // For now, let's assume onboarding is complete to focus on receipts.
        // A more robust implementation would handle both conversations.
    }

    // Check for the "new receipt" command
    if (lowerCaseText === 'new receipt') {
        const user = await db.collection('users').findOne({ userId: senderId });
        if (user && user.onboardingComplete) {
            console.log(`Starting new receipt process for ${senderId}`);
            userStates.set(senderId, { 
                state: 'receipt_customer_name', 
                receiptData: {} 
            });
            await msg.reply('🧾 *New Receipt Started*\n\nWho is the customer?');
        } else {
            await msg.reply("You need to complete your brand setup first! Just send any message to get started.");
        }
        return;
    }

    // --- RECEIPT CREATION CONVERSATION ---
    if (currentState && currentState.startsWith('receipt_')) {
        switch (currentState) {
            case 'receipt_customer_name':
                userSession.receiptData.customerName = text;
                userSession.state = 'receipt_items';
                userStates.set(senderId, userSession);
                await msg.reply(`Customer: ${text}\n\nWhat item(s) did they purchase? (You can list multiple items, e.g., "Rice, Beans, Plantain")`);
                break;

            case 'receipt_items':
                userSession.receiptData.items = text.split(',').map(item => item.trim());
                userSession.state = 'receipt_prices';
                userStates.set(senderId, userSession);
                await msg.reply(`Items saved.\n\nNow, enter the price for each item in the same order, separated by commas. (e.g., "500, 300, 200")`);
                break;

            case 'receipt_prices':
                userSession.receiptData.prices = text.split(',').map(price => price.trim());
                userSession.state = 'receipt_payment_method';
                userStates.set(senderId, userSession);
                await msg.reply(`Prices saved.\n\nWhat was the payment method? (e.g., "Cash", "Bank Transfer", "POS")`);
                break;

            case 'receipt_payment_method':
                userSession.receiptData.paymentMethod = text;
                console.log('--- COMPLETE RECEIPT DATA COLLECTED ---');
                console.log(userSession.receiptData);
                console.log('------------------------------------');
                
                await msg.reply(`✅ *Receipt details collected!* Generating your image now... (This is the next feature we will build!)`);
                userStates.delete(senderId); // End the session
                break;
        }
        return;
    }
    
    // --- Default Logic for New or Onboarded Users ---
    const existingUser = await db.collection('users').findOne({ userId: senderId });

    if (!existingUser) {
        // Start onboarding for new users (we will merge this logic back in later)
        await msg.reply("👋 Welcome to SmartReceipt!\n\nSend any message to get your brand set up.");
        // For simplicity, we assume they have to complete it before 'new receipt'
    } else if (existingUser.onboardingComplete) {
        await msg.reply(`Welcome back, ${existingUser.brandName}!\n\nType *'new receipt'* to begin.`);
    } else {
        await msg.reply("Please complete your brand setup first. What is your business or brand name?");
        userStates.set(senderId, { state: 'awaiting_brand_name' }); // Simplified onboarding trigger
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


