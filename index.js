// --- Dependencies ---
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient, ObjectId } = require('mongodb');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const cors = require('cors');

// --- Configuration ---
const MONGO_URI = process.env.MONGO_URI;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY; 
const RECEIPT_BASE_URL = process.env.RECEIPT_BASE_URL;
const PP_API_KEY = process.env.PP_API_KEY;
const PP_SECRET_KEY = process.env.PP_SECRET_KEY;
const PP_BUSINESS_ID = process.env.PP_BUSINESS_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = 3000;

const DB_NAME = 'receiptBot';
const ADMIN_NUMBERS = ['2348146817448@c.us', '2347016370067@c.us'];
const LIFETIME_FEE = 5000;

// --- Database, State, and Web Server ---
let db;
const userStates = new Map();
const app = express();
app.use(express.json());
const corsOptions = { origin: ['http://smartnaijaservices.com.ng', 'https://smartnaijaservices.com.ng'] };
app.use(cors(corsOptions));

// --- Database Connection ---
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
        const response = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form, { headers: form.getHeaders() });
        return response.data.data.display_url;
    } catch (error) {
        console.error("ImgBB upload failed:", error.response ? error.response.data : error.message);
        return null;
    }
}

function formatPhoneNumberForApi(whatsappId) {
    let number = whatsappId.split('@')[0];
    number = number.replace(/\D/g, '');
    if (number.startsWith('234') && number.length === 13) {
        return '0' + number.substring(3);
    }
    if (number.length === 10 && !number.startsWith('0')) {
        return '0' + number;
    }
    if (number.length === 11 && number.startsWith('0')) {
        return number;
    }
    return "INVALID_PHONE_FORMAT"; 
}

// --- PAYMENTPOINT INTEGRATION ---
async function generateVirtualAccount(user) {
    const formattedPhone = formatPhoneNumberForApi(user.userId);
    if (formattedPhone === "INVALID_PHONE_FORMAT") {
        console.error(`Could not format phone number for user: ${user.userId}`);
        return null;
    }
    const options = {
        method: 'POST',
        url: 'https://api.paymentpoint.co/api/v1/createVirtualAccount',
        headers: {
            'Content-Type': 'application/json',
            'api-key': PP_API_KEY,
            'Authorization': `Bearer ${PP_SECRET_KEY}`
        },
        data: {
            name: user.brandName.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 30),
            email: `${formattedPhone}@smartreceipt.user`,
            phoneNumber: formattedPhone,
            bankCode: ['20946'],
            businessId: PP_BUSINESS_ID
        }
    };
    try {
        const response = await axios.request(options);
        if (response.data && response.data.bankAccounts && response.data.bankAccounts.length > 0) {
            return response.data.bankAccounts[0];
        }
        return null;
    } catch (error) {
        console.error("--- PAYMENTPOINT API ERROR ---");
        if (error.response) { console.error("Data:", JSON.stringify(error.response.data, null, 2)); }
        else { console.error('Error Message:', error.message); }
        console.error("--- END PAYMENTPOINT API ERROR ---");
        return null;
    }
}

// --- WEB SERVER ROUTES ---
app.get('/', (req, res) => res.status(200).send('SmartReceipt Bot Webhook Server is running.'));

app.post('/webhook', async (req, res) => {
    try {
        console.log("Webhook received from PaymentPoint!");
        const data = req.body;
        if (data && data.customer && data.customer.customer_phone_number) {
            let phone = data.customer.customer_phone_number;
            if (phone.startsWith('0') && phone.length === 11) {
                phone = '234' + phone.substring(1);
            }
            const userId = `${phone}@c.us`;
            console.log(`Payment received for user: ${userId}`);
            const result = await db.collection('users').updateOne({ userId: userId }, { $set: { isPaid: true } });
            if (result.modifiedCount > 0) {
                console.log(`User ${userId} unlocked successfully.`);
                await client.sendMessage(userId, `✅ *Payment Confirmed!* Thank you.\n\nYour SmartReceipt account now has lifetime access to unlimited receipts.`);
            }
        }
        res.status(200).send('Webhook processed');
    } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).send('Error processing webhook');
    }
});

app.post('/admin-data', async (req, res) => {
    try {
        const { password } = req.body;
        if (password !== ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'Unauthorized: Incorrect password.' });
        }
        const usersCollection = db.collection('users');
        const totalUsers = await usersCollection.countDocuments();
        const paidUsers = await usersCollection.countDocuments({ isPaid: true });
        const recentUsers = await usersCollection.find().sort({ createdAt: -1 }).limit(10).toArray();
        const totalRevenue = paidUsers * LIFETIME_FEE;
        res.status(200).json({
            totalUsers,
            paidUsers,
            totalRevenue,
            recentUsers
        });
    } catch (error) {
        console.error("Error fetching admin data:", error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// --- WhatsApp Client Initialization ---
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] }
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
        
        const user = await db.collection('users').findOne({ userId: senderId });
        const isAdmin = ADMIN_NUMBERS.includes(senderId);
        const userSession = userStates.get(senderId) || {};
        const currentState = userSession.state;

        // --- EDITING FLOW ---
        if (currentState && currentState.startsWith('editing_')) {
            const choice = parseInt(text, 10);
            let nextState = '';
            let prompt = '';
            switch (currentState) {
                case 'awaiting_edit_choice':
                    if (choice === 1) {
                        nextState = 'editing_customer_name';
                        prompt = 'What is the new customer name?';
                    } else if (choice === 2) {
                        nextState = 'editing_items';
                        prompt = 'Please re-enter all the items for the receipt, separated by commas.';
                    } else if (choice === 3) {
                        nextState = 'editing_payment_method';
                        prompt = 'What is the new payment method?';
                    } else {
                        await sendMessageWithDelay(msg, "Invalid choice. Please send a number (1-3).");
                        return;
                    }
                    userSession.state = nextState;
                    userStates.set(senderId, userSession);
                    await sendMessageWithDelay(msg, prompt);
                    break;
                case 'editing_customer_name':
                    userSession.receiptToEdit.customerName = text;
                    await regenerateAndSend(senderId, user, userSession.receiptToEdit, msg);
                    break;
                case 'editing_items':
                    userSession.receiptToEdit.items = text.split(',').map(item => item.trim());
                    userSession.state = 'editing_prices';
                    userStates.set(senderId, userSession);
                    await sendMessageWithDelay(msg, "Items updated. Now, please re-enter all the prices in the correct order.");
                    break;
                case 'editing_prices':
                    userSession.receiptToEdit.prices = text.split(',').map(p => p.trim());
                    if (userSession.receiptToEdit.items.length !== userSession.receiptToEdit.prices.length) {
                        await sendMessageWithDelay(msg, "The number of items and prices don't match. Please try editing again by typing 'edit'.");
                        userStates.delete(senderId);
                        return;
                    }
                    await regenerateAndSend(senderId, user, userSession.receiptToEdit, msg);
                    break;
                case 'editing_payment_method':
                    userSession.receiptToEdit.paymentMethod = text;
                    await regenerateAndSend(senderId, user, userSession.receiptToEdit, msg);
                    break;
            }
            return;
        }

        // --- HISTORY RESEND LOGIC ---
        if (currentState === 'awaiting_history_choice') { /* ... unchanged ... */ }

        // --- COMMANDS ---
        if (lowerCaseText === 'stats') { /* ... unchanged ... */ }
        if (lowerCaseText === 'history') { /* ... unchanged ... */ }
        
        if (lowerCaseText === 'edit') {
            if (user && user.onboardingComplete) {
                const lastReceipt = await db.collection('receipts').findOne({ userId: senderId }, { sort: { createdAt: -1 } });
                if (!lastReceipt) {
                    await sendMessageWithDelay(msg, "You don't have any recent receipts to edit.");
                    return;
                }
                const editMessage = `Let's edit your last receipt (for *${lastReceipt.customerName}*).\n\nWhat would you like to change?\n*1.* Customer Name\n*2.* Items & Prices\n*3.* Payment Method`;
                userStates.set(senderId, { state: 'awaiting_edit_choice', receiptToEdit: lastReceipt });
                await sendMessageWithDelay(msg, editMessage);
            } else {
                await sendMessageWithDelay(msg, "Please complete your setup before using this command.");
            }
            return;
        }
        
        // [PAYWALL AND NEW RECEIPT/CHANGERECEIPT LOGIC IS UNCHANGED]
        // [ALL OTHER CASES (ONBOARDING, RECEIPT CREATION) ARE UNCHANGED]

    } catch (err) {
        console.error("An error occurred in message handler:", err);
    }
});

// --- REGENERATION FUNCTION ---
async function regenerateAndSend(senderId, user, receiptData, msg) {
    await sendMessageWithDelay(msg, `✅ Got it! Regenerating your receipt now...`);
    const subtotal = receiptData.prices.reduce((sum, price) => sum + parseFloat(price || 0), 0);
    await db.collection('receipts').updateOne(
        { _id: new ObjectId(receiptData._id) },
        { $set: {
            customerName: receiptData.customerName,
            items: receiptData.items,
            prices: receiptData.prices,
            paymentMethod: receiptData.paymentMethod,
            totalAmount: subtotal
        }}
    );
    const urlParams = new URLSearchParams({
        bn: user.brandName, bc: user.brandColor, logo: user.logoUrl || '',
        cn: receiptData.customerName, items: receiptData.items.join('||'),
        prices: receiptData.prices.join(','), pm: receiptData.paymentMethod,
        addr: user.address || '', ci: user.contactInfo || ''
    });
    const fullUrl = `${RECEIPT_BASE_URL}template.${user.preferredTemplate}.html?${urlParams.toString()}`;
    const page = await client.pupBrowser.newPage();
    await page.setViewport({ width: 800, height: 800, deviceScaleFactor: 2 });
    await page.goto(fullUrl, { waitUntil: 'networkidle0' });
    const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
    await page.close();
    const media = new MessageMedia('image/png', screenshotBuffer.toString('base64'), 'SmartReceipt.png');
    await client.sendMessage(senderId, media, { caption: `Here is the updated receipt for ${receiptData.customerName}.` });
    userStates.delete(senderId);
}

// --- Main Function ---
async function startBot() {
    if (!MONGO_URI || !IMGBB_API_KEY || !RECEIPT_BASE_URL || !PP_API_KEY || !PP_SECRET_KEY || !PP_BUSINESS_ID || !ADMIN_PASSWORD) {
        console.error("FATAL ERROR: Missing required environment variables.");
        process.exit(1);
    }
    app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
    await connectToDB();
    client.initialize();
}

startBot();

