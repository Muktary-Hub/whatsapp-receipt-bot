// index.js - WhatsApp Receipt Bot
// ---------------------------------------------
// This is the main entry point for the bot.
// It initializes the WhatsApp client, connects to the database,
// and handles incoming messages.
// ---------------------------------------------

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { MongoClient } = require('mongodb');

// --- Configuration ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = 'receiptBot';

let db;

// --- Main Bot Logic ---

// Initialize MongoDB Connection
async function connectToDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db(DB_NAME);
        console.log('Successfully connected to MongoDB.');
    } catch (err) {
        console.error('Failed to connect to MongoDB', err);
        process.exit(1);
    }
}


// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(), // Use local session storage
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'], // Required for running on some servers
    },
});

// Event: QR Code generated for authentication
client.on('qr', (qr) => {
    console.log('QR Code Received, please scan with your phone.');
    qrcode.generate(qr, { small: true });
});

// Event: Authentication successful
client.on('authenticated', () => {
    console.log('Authentication successful!');
});

// Event: Client is ready
client.on('ready', () => {
    console.log('WhatsApp client is ready!');
});


// Event: Message received
client.on('message', async (msg) => {
    const from = msg.from;
    const body = msg.body.trim();

    try {
        // Simple command handler example
        if (body.toLowerCase() === 'ping') {
            await msg.reply('pong');
        }

        // Example: Check for a user in the database
        const usersCollection = db.collection('users');
        let user = await usersCollection.findOne({ whatsappNumber: from });

        if (!user) {
            console.log(`New user detected: ${from}. Creating entry.`);
            // This is where the onboarding flow would begin
            await usersCollection.insertOne({
                whatsappNumber: from,
                isPaid: false,
                conversationState: 'awaiting_brand_name', // Start onboarding
                createdAt: new Date(),
            });
            await msg.reply("Welcome to ReceiptBot! Let's set up your brand. What is your Brand Name?");
        } else {
            // Here you would handle existing users and their conversation states
            // For now, let's just log it
            console.log(`Message from existing user ${from}: ${body}`);

            // TODO: Implement the conversation state machine here
            // e.g., if (user.conversationState === 'awaiting_brand_name') { ... }
        }

    } catch (error) {
        console.error('Error processing message:', error);
        await msg.reply('Sorry, an error occurred. Please try again later.');
    }
});


// --- Start the Bot ---
async function startBot() {
    await connectToDB();
    client.initialize();
}

startBot();

