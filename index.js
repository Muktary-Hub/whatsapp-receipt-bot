// --- Dependencies ---
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient } = require('mongodb');
const { createCanvas, registerFont } = require('canvas');
const path = require('path');

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

// --- ✨ NEW HIGH-CLASS IMAGE GENERATION ✨ ---
function generateReceiptImage(brandInfo, receiptData) {
    // We'll add a switch here later for the 5 templates.
    // For now, everyone gets the new "Modern" template.

    const width = 800;
    const height = 1400; // More space for better layout
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // -- Fonts -- (Using system fonts for now, can add custom fonts later)
    const fontBold = 'bold 36px Arial';
    const fontRegular = '30px Arial';
    const fontSmall = '24px Arial';
    const fontTitle = 'bold 52px Arial';

    // -- Colors --
    const bgColor = '#FFFFFF';
    const textColor = '#1A202C'; // A dark grey, softer than black
    const secondaryTextColor = '#718096';
    const brandColor = brandInfo.brandColor || '#3182CE'; // Default to a nice blue

    // 1. Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    let y = 100;

    // 2. Header
    ctx.font = fontTitle;
    ctx.fillStyle = brandColor;
    ctx.textAlign = 'center';
    ctx.fillText(brandInfo.brandName.toUpperCase(), width / 2, y);
    y += 50;
    
    ctx.font = fontSmall;
    ctx.fillStyle = secondaryTextColor;
    ctx.fillText('OFFICIAL E-RECEIPT', width / 2, y);
    y += 100;

    // 3. Info Section
    ctx.textAlign = 'left';
    ctx.font = fontRegular;
    ctx.fillStyle = secondaryTextColor;
    ctx.fillText('Billed To', 50, y);

    ctx.textAlign = 'right';
    ctx.fillText('Date Issued', width - 50, y);
    y += 40;

    ctx.font = fontBold;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.fillText(receiptData.customerName, 50, y);

    ctx.textAlign = 'right';
    const date = new Date().toLocaleDateString('en-NG', { year: 'numeric', month: 'short', day: 'numeric' });
    ctx.fillText(date, width - 50, y);
    y += 80;

    // 4. Items Table Header
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = '#E2E8F0'; // Lighter border color
    ctx.lineWidth = 2;

    // Draw a rounded rectangle for the header
    ctx.beginPath();
    ctx.moveTo(50 + 10, y);
    ctx.lineTo(width - 50 - 10, y);
    ctx.quadraticCurveTo(width - 50, y, width - 50, y + 10);
    ctx.lineTo(width - 50, y + 60 - 10);
    ctx.quadraticCurveTo(width - 50, y + 60, width - 50 - 10, y + 60);
    ctx.lineTo(50 + 10, y + 60);
    ctx.quadraticCurveTo(50, y + 60, 50, y + 60 - 10);
    ctx.lineTo(50, y + 10);
    ctx.quadraticCurveTo(50, y, 50 + 10, y);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#F7FAFC'; // Very light grey header background
    ctx.fill();
    
    y += 40;
    ctx.font = fontBold;
    ctx.fillStyle = secondaryTextColor;
    ctx.textAlign = 'left';
    ctx.fillText('DESCRIPTION', 70, y);
    ctx.textAlign = 'right';
    ctx.fillText('AMOUNT (₦)', width - 70, y);
    y += 60;

    // 5. Items List
    let total = 0;
    ctx.font = fontRegular;
    ctx.fillStyle = textColor;
    for (let i = 0; i < receiptData.items.length; i++) {
        const item = receiptData.items[i];
        const price = parseFloat(receiptData.prices[i]) || 0;
        total += price;

        ctx.textAlign = 'left';
        ctx.fillText(item, 70, y);
        ctx.textAlign = 'right';
        ctx.fillText(price.toLocaleString(), width - 70, y);
        y += 50;
    }
    
    // 6. Total Section
    y += 50;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(width / 2, y);
    ctx.lineTo(width - 50, y);
    ctx.strokeStyle = '#E2E8F0';
    ctx.stroke();
    y += 50;

    ctx.font = fontRegular;
    ctx.fillStyle = secondaryTextColor;
    ctx.textAlign = 'left';
    ctx.fillText('Subtotal', width/2, y);
    ctx.textAlign = 'right';
    ctx.fillText(`₦${total.toLocaleString()}`, width - 50, y);
    y += 50;

    ctx.font = fontBold;
    ctx.fillStyle = brandColor;
    ctx.textAlign = 'left';
    ctx.fillText('TOTAL DUE', width / 2, y);
    ctx.textAlign = 'right';
    ctx.fillText(`₦${total.toLocaleString()}`, width - 50, y);
    y += 100;

    // 7. Footer
    ctx.textAlign = 'center';
    ctx.font = fontRegular;
    ctx.fillStyle = secondaryTextColor;
    ctx.fillText(`Paid via ${receiptData.paymentMethod}`, width / 2, y);
    y += 50;
    
    ctx.fillText(brandInfo.contactInfo, width / 2, y);
    y += 50;

    ctx.font = fontSmall;
    ctx.fillText('Thank you for your business!', width / 2, y);
    
    return canvas.toBuffer('image/png');
}

// --- WhatsApp Client Initialization & Main Logic ---
// (The rest of the bot's code remains largely the same as the previous version)
// I'm including the full code here for a complete copy-paste replacement.

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

client.on('qr', qr => { console.log(qr); });
client.on('ready', () => { console.log('WhatsApp client is ready!'); });

client.on('message', async msg => {
    try {
        const chat = await msg.getChat();
        if (chat.isGroup || msg.isStatus) return;

        const senderId = msg.from;
        const text = msg.body.trim();
        const lowerCaseText = text.toLowerCase();
        
        const userSession = userStates.get(senderId) || {};
        const currentState = userSession.state;

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

        switch (currentState) {
            case 'awaiting_brand_name':
                await db.collection('users').deleteMany({ userId: senderId });
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
                await sendMessageWithDelay(msg, `✅ *Setup Complete!* Your brand profile is all set.\n\nTo create your first receipt, just type:\n*'new receipt'*`);
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
                await sendMessageWithDelay(msg, `✅ *Details collected!* Generating your high-class receipt now...`);
                
                const user = await db.collection('users').findOne({ userId: senderId });
                const receiptImageBuffer = generateReceiptImage(user, userSession.receiptData);
                const media = new MessageMedia('image/png', receiptImageBuffer.toString('base64'), 'SmartReceipt.png');
                
                await client.sendMessage(senderId, media, { caption: `Here is the receipt for ${userSession.receiptData.customerName}.` });
                
                userStates.delete(senderId);
                break;
            default:
                const existingUser = await db.collection('users').findOne({ userId: senderId });
                if (!existingUser || !existingUser.onboardingComplete) {
                    userStates.set(senderId, { state: 'awaiting_brand_name' });
                    await sendMessageWithDelay(msg, "👋 Welcome to SmartReceipt!\n\nLet's get your brand set up. First, what is your business or brand name?");
                } else {
                    await sendMessageWithDelay(msg, `Welcome back, ${existingUser.brandName}!\n\nType *'new receipt'* to begin.`);
                }
        }
    } catch (err) {
        console.error("An error occurred in message handler:", err);
        await msg.reply("Sorry, something went wrong on my end. Please try again.");
    }
});

// --- Main Function ---
async function startBot() {
    await connectToDB();
    client.initialize();
}

startBot();


