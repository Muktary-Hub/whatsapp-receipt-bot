// --- Dependencies ---
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient } = require('mongodb');
const { createCanvas } = require('canvas');

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

// --- Helper Functions ---
function sendMessageWithDelay(msg, text) {
    const delay = Math.floor(Math.random() * 1000) + 1500;
    return new Promise(resolve => {
        setTimeout(async () => {
            const sentMessage = await msg.reply(text);
            resolve(sentMessage);
        }, delay);
    });
}

// --- ✨ IMAGE GENERATION FUNCTION (Template #1 - Classic) ✨ ---
function generateReceiptImage(brandInfo, receiptData) {
    const width = 800;
    const height = 1200; // Adjusted for typical receipt length
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // --- Drawing Styles ---
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.font = '30px Arial';
    ctx.fillStyle = '#000000';

    let y = 80; // Starting Y position

    // 1. Header
    ctx.fillStyle = brandInfo.brandColor || '#000000';
    ctx.font = 'bold 60px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(brandInfo.brandName.toUpperCase(), width / 2, y);
    y += 80;

    ctx.fillStyle = '#555555';
    ctx.font = '24px Arial';
    ctx.fillText('Official Receipt', width / 2, y);
    y += 50;

    // 2. Business Info & Date
    ctx.textAlign = 'left';
    ctx.fillStyle = '#333333';
    ctx.font = '26px Arial';
    ctx.fillText(brandInfo.address || '', 50, y);
    const date = new Date().toLocaleString('en-NG');
    ctx.textAlign = 'right';
    ctx.fillText(date, width - 50, y);
    y += 40;

    ctx.textAlign = 'left';
    ctx.fillText(brandInfo.contactInfo || '', 50, y);
    y += 80;

    // 3. Customer Info
    ctx.fillStyle = '#888888';
    ctx.fillText('BILLED TO:', 50, y);
    y += 40;
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 30px Arial';
    ctx.fillText(receiptData.customerName, 50, y);
    y += 80;

    // 4. Items Table
    ctx.font = 'bold 28px Arial';
    ctx.fillText('ITEM', 50, y);
    ctx.textAlign = 'right';
    ctx.fillText('PRICE (₦)', width - 50, y);
    y += 40;
    ctx.beginPath();
    ctx.moveTo(50, y);
    ctx.lineTo(width - 50, y);
    ctx.strokeStyle = '#EEEEEE';
    ctx.lineWidth = 2;
    ctx.stroke();
    y += 40;

    ctx.font = '28px Arial';
    let total = 0;
    for (let i = 0; i < receiptData.items.length; i++) {
        const item = receiptData.items[i];
        const price = parseFloat(receiptData.prices[i]) || 0;
        total += price;

        ctx.textAlign = 'left';
        ctx.fillText(item, 50, y);
        ctx.textAlign = 'right';
        ctx.fillText(price.toLocaleString(), width - 50, y);
        y += 45;
    }

    // 5. Total
    y += 20;
    ctx.beginPath();
    ctx.moveTo(width / 2, y);
    ctx.lineTo(width - 50, y);
    ctx.strokeStyle = '#333333';
    ctx.stroke();
    y += 40;

    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('TOTAL', width / 2, y);
    ctx.textAlign = 'right';
    ctx.fillText(`₦${total.toLocaleString()}`, width - 50, y);
    y += 80;

    // 6. Footer
    ctx.textAlign = 'left';
    ctx.fillStyle = '#555555';
    ctx.font = '26px Arial';
    ctx.fillText(`Payment Method: ${receiptData.paymentMethod}`, 50, y);
    y += 60;
    
    ctx.textAlign = 'center';
    ctx.fillText('Thank you for your patronage!', width / 2, y);
    y += 40;
    ctx.font = '20px Arial';
    ctx.fillStyle = '#AAAAAA';
    ctx.fillText('Powered by SmartReceipt', width / 2, y);

    return canvas.toBuffer('image/png');
}


// --- WhatsApp Client Initialization ---
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

client.on('qr', qr => { console.log(qr); });
client.on('ready', () => { console.log('WhatsApp client is ready!'); });

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
                userStates.set(senderId, { state: 'awaiting_brand_name' });
                await sendMessageWithDelay(msg, "👋 Welcome to SmartReceipt!\n\nLet's get your brand set up. First, what is your business or brand name?");
            }
            return;
        }

        // --- State-Based Conversation Logic ---
        switch (currentState) {
            case 'awaiting_brand_name':
                await db.collection('users').deleteMany({ userId: senderId }); // Ensure clean slate
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
                userStates.delete(senderId);
                await sendMessageWithDelay(msg, `✅ *Setup Complete!* Your brand profile is all set.\n\nTo create your first receipt, just type the command:\n*'new receipt'*`);
                break;

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
                    await sendMessageWithDelay(msg, `⚠️ The number of items and prices don't match. Please enter the prices again.`);
                    return; 
                }
                userSession.state = 'receipt_payment_method';
                userStates.set(senderId, userSession);
                await sendMessageWithDelay(msg, `Prices saved.\n\nWhat was the payment method?`);
                break;

            case 'receipt_payment_method':
                userSession.receiptData.paymentMethod = text;
                await sendMessageWithDelay(msg, `✅ *Details collected!* Generating your receipt now...`);
                
                // Fetch user's brand info
                const user = await db.collection('users').findOne({ userId: senderId });
                // Generate the image buffer
                const receiptImageBuffer = generateReceiptImage(user, userSession.receiptData);
                // Create a MessageMedia object
                const media = new MessageMedia('image/png', receiptImageBuffer.toString('base64'), 'receipt.png');
                // Send the image
                await client.sendMessage(senderId, media, { caption: 'Here is your receipt!' });
                
                userStates.delete(senderId); // Clean up the session
                break;

            default:
                const existingUser = await db.collection('users').findOne({ userId: senderId });
                if (!existingUser) {
                    userStates.set(senderId, { state: 'awaiting_brand_name' });
                    await sendMessageWithDelay(msg, "👋 Welcome to SmartReceipt!\n\nLet's get your brand set up. First, what is your business or brand name?");
                } else {
                    await sendMessageWithDelay(msg, `Welcome back, ${existingUser.brandName}!\n\nType *'new receipt'* to begin.`);
                }
        }
    } catch (err) {
        console.error("An error occurred:", err);
        await client.sendMessage(msg.from, "Sorry, something went wrong on my end. Please try again.");
    }
});


// --- Main Function ---
async function startBot() {
    await connectToDB();
    client.initialize();
}

startBot();


