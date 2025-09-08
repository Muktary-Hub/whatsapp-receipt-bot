// --- Dependencies ---
const { Client, LocalAuth } = require('whatsapp-web.js');
const { MongoClient } = require('mongodb');

// --- Configuration ---
// The MONGO_URI will be read from Railway's environment variables
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = 'receiptBot';

// This is a special line to help debug the MongoDB connection string on Railway.
console.log(`Attempting to connect with MONGO_URI: ${process.env.MONGO_URI}`);


// --- Database Connection ---
let db;
const userStates = new Map(); // In-memory state management for conversations

async function connectToDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db(DB_NAME);
        console.log('Successfully connected to MongoDB.');
    } catch (error) {
        console.error('Failed to connect to MongoDB', error);
        // Exit the process if the database connection fails, as the bot cannot function.
        process.exit(1); 
    }
}


// --- WhatsApp Client Initialization ---
const client = new Client({
    authStrategy: new LocalAuth(),
    // Puppeteer options are crucial for running in a container environment like Railway
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

// --- Event Handlers ---

// Event: QR Code Received - MODIFIED FOR LINK GENERATION
client.on('qr', qr => {
    console.log('QR CODE RECEIVED! To get a scannable image, follow these steps:');
    console.log('1. Copy the long string of text below (between the START and END lines).');
    console.log('2. Paste it at the end of this URL: https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=');
    console.log('3. Open the complete URL in a new browser tab to see the QR code image.');
    console.log('--- QR STRING START ---');
    console.log(qr); // This is the raw QR data
    console.log('--- QR STRING END ---');
});


// Event: Authentication Successful
client.on('authenticated', () => {
    console.log('Authentication successful!');
});

// Event: Authentication Failure
client.on('auth_failure', msg => {
    console.error('Authentication failed:', msg);
});

// Event: Client is Ready
client.on('ready', () => {
    console.log('WhatsApp client is ready!');
});

// Event: Message Received
client.on('message', async msg => {
    const chat = await msg.getChat();
    const senderId = msg.from;
    const text = msg.body.toLowerCase().trim();

    // Simple ping command to test if the bot is alive
    if (text === 'ping') {
        await client.sendMessage(senderId, 'pong');
        console.log(`Responded to ping from ${senderId}`);
    }

    // A simple "Hi" to start the onboarding process (placeholder)
    if (text === 'hi') {
        await client.sendMessage(senderId, 'Hello! Welcome to the Receipt Bot. (Onboarding process will start here).');
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


