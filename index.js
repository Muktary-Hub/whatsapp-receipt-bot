// --- Dependencies ---
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient } = require('mongodb');
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

        // --- HISTORY RESEND LOGIC ---
        if (currentState === 'awaiting_history_choice') {
            const choice = parseInt(text, 10);
            if (choice >= 1 && choice <= userSession.history.length) {
                const selectedReceipt = userSession.history[choice - 1];

                await sendMessageWithDelay(msg, `Resending receipt for *${selectedReceipt.customerName}*...`);

                const urlParams = new URLSearchParams({
                    bn: user.brandName, bc: user.brandColor, logo: user.logoUrl || '',
                    cn: selectedReceipt.customerName, items: selectedReceipt.items.join('||'),
                    prices: selectedReceipt.prices.join(','), pm: selectedReceipt.paymentMethod,
                    addr: user.address || '', ci: user.contactInfo || ''
                });
                
                const fullUrl = `${RECEIPT_BASE_URL}template.${user.preferredTemplate}.html?${urlParams.toString()}`;
                
                const page = await client.pupBrowser.newPage();
                await page.setViewport({ width: 800, height: 800, deviceScaleFactor: 2 });
                await page.goto(fullUrl, { waitUntil: 'networkidle0' });
                const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
                await page.close();

                const media = new MessageMedia('image/png', screenshotBuffer.toString('base64'), 'SmartReceipt.png');
                await client.sendMessage(senderId, media, { caption: `Here is the receipt for ${selectedReceipt.customerName}.` });
                
                userStates.delete(senderId);
            } else {
                await sendMessageWithDelay(msg, "Invalid number. Please reply with a number from the list (1-5).");
            }
            return;
        }

        // --- COMMAND HANDLING ---
        if (lowerCaseText === 'stats') {
            if (user && user.onboardingComplete) {
                const now = new Date();
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
                const receipts = await db.collection('receipts').find({ userId: senderId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }).toArray();
                const totalSales = receipts.reduce((sum, receipt) => sum + receipt.totalAmount, 0);
                const receiptCount = receipts.length;
                const monthName = startOfMonth.toLocaleString('default', { month: 'long' });
                let statsMessage = `📊 *Your Stats for ${monthName}*\n\n*Receipts Generated:* ${receiptCount}\n*Total Sales:* ₦${totalSales.toLocaleString()}`;
                await sendMessageWithDelay(msg, statsMessage);
            } else {
                await sendMessageWithDelay(msg, "You need to complete your setup first to view stats.");
            }
            return;
        }

        if (lowerCaseText === 'history') {
            if (user && user.onboardingComplete) {
                const recentReceipts = await db.collection('receipts').find({ userId: senderId }).sort({ createdAt: -1 }).limit(5).toArray();
                if (recentReceipts.length === 0) {
                    await sendMessageWithDelay(msg, "You haven't generated any receipts yet.");
                    return;
                }
                let historyMessage = "🧾 *Your 5 Most Recent Receipts:*\n\n";
                recentReceipts.forEach((receipt, index) => {
                    historyMessage += `*${index + 1}.* Receipt for *${receipt.customerName}* - ₦${receipt.totalAmount.toLocaleString()}\n`;
                });
                historyMessage += "\nTo resend a receipt, just reply with its number (1-5).";
                userStates.set(senderId, { state: 'awaiting_history_choice', history: recentReceipts });
                await sendMessageWithDelay(msg, historyMessage);
            } else {
                await sendMessageWithDelay(msg, "You need to complete your setup first to view your history.");
            }
            return;
        }

        if (lowerCaseText === 'new receipt' && user && !isAdmin && !user.isPaid && user.receiptCount >= 1) {
            await sendMessageWithDelay(msg, "You have exhausted your free limit. To continue, please pay for lifetime access.");
            const accountDetails = await generateVirtualAccount(user);
            if (accountDetails && accountDetails.bankName) {
                const reply = `To get lifetime access for *₦${LIFETIME_FEE.toLocaleString()}*, please transfer to this account:\n\n` + `*Bank:* ${accountDetails.bankName}\n` + `*Account Number:* ${accountDetails.accountNumber}\n\n` + `Your access will be unlocked automatically after payment.`;
                await msg.reply(reply);
            } else {
                await msg.reply("Sorry, I couldn't generate a payment account right now. Please try again later.");
            }
            return;
        }

        if (['new receipt', 'changereceipt'].includes(lowerCaseText)) {
            if (user && user.onboardingComplete) {
                if (lowerCaseText === 'changereceipt' || !user.preferredTemplate) {
                    userStates.set(senderId, { state: 'awaiting_template_choice' });
                    await sendMessageWithDelay(msg, "Please choose your receipt template.\n\nView our 6 high-class designs in the catalog, then send the number of your choice (1-6).");
                } else {
                    userStates.set(senderId, { state: 'receipt_customer_name', receiptData: {} });
                    await sendMessageWithDelay(msg, '🧾 *New Receipt Started*\n\nWho is the customer?');
                }
            } else {
                userStates.set(senderId, { state: 'awaiting_brand_name' });
                await sendMessageWithDelay(msg, "👋 Welcome to SmartReceipt!\n\nLet's get your brand set up. First, what is your business name?");
            }
            return;
        }

        switch (currentState) {
            case 'awaiting_brand_name':
                await db.collection('users').deleteMany({ userId: senderId });
                await db.collection('users').insertOne({ userId: senderId, brandName: text, onboardingComplete: false, receiptCount: 0, isPaid: false, createdAt: new Date() });
                userStates.set(senderId, { state: 'awaiting_brand_color' });
                await sendMessageWithDelay(msg, `Great! Your brand is "${text}".\n\nWhat's your brand's main color? (e.g., #1D4ED8 or "blue")`);
                break;
            case 'awaiting_brand_color':
                await db.collection('users').updateOne({ userId: senderId }, { $set: { brandColor: text } });
                userStates.set(senderId, { state: 'awaiting_logo' });
                await sendMessageWithDelay(msg, `Color saved!\n\nNow, please upload your business logo. If you don't have one, just type *'skip'*.`);
                break;
            case 'awaiting_logo':
                if (msg.hasMedia) {
                    const media = await msg.downloadMedia();
                    await sendMessageWithDelay(msg, "Logo received! Uploading now, please wait...");
                    const logoUrl = await uploadLogo(media);
                    if (logoUrl) {
                        await db.collection('users').updateOne({ userId: senderId }, { $set: { logoUrl: logoUrl } });
                        await sendMessageWithDelay(msg, "Logo uploaded successfully!");
                    } else {
                        await sendMessageWithDelay(msg, "Sorry, I couldn't upload the logo. We'll proceed without it for now.");
                    }
                } else if (lowerCaseText !== 'skip') {
                    await sendMessageWithDelay(msg, "That's not an image. Please upload a logo file or type 'skip'.");
                    return;
                }
                userStates.set(senderId, { state: 'awaiting_address' });
                await sendMessageWithDelay(msg, `Logo step complete.\n\nNext, what is your business address?`);
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
                if (choice >= 1 && choice <= 6) {
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { preferredTemplate: choice } });
                    userStates.set(senderId, { state: 'receipt_customer_name', receiptData: {} });
                    await sendMessageWithDelay(msg, `✅ Template #${choice} saved!\n\nNow, let's create your receipt. Who is the customer?`);
                } else {
                    await sendMessageWithDelay(msg, "Invalid selection. Please send a single number between 1 and 6.");
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
                    await sendMessageWithDelay(msg, `⚠️ Items and prices don't match. Please enter the prices again.`);
                    return; 
                }
                userSession.state = 'receipt_payment_method';
                userStates.set(senderId, userSession);
                await sendMessageWithDelay(msg, `Prices saved.\n\nWhat was the payment method?`);
                break;
            case 'receipt_payment_method':
                userSession.receiptData.paymentMethod = text;
                await sendMessageWithDelay(msg, `✅ *Details collected!* Generating your high-class receipt, please wait...`);
                
                const subtotal = userSession.receiptData.prices.reduce((sum, price) => sum + parseFloat(price || 0), 0);

                const urlParams = new URLSearchParams({
                    bn: user.brandName, bc: user.brandColor, logo: user.logoUrl || '',
                    cn: userSession.receiptData.customerName, items: userSession.receiptData.items.join('||'),
                    prices: userSession.receiptData.prices.join(','), pm: userSession.receiptData.paymentMethod,
                    addr: user.address || '', ci: user.contactInfo || ''
                });
                
                const fullUrl = `${RECEIPT_BASE_URL}template.${user.preferredTemplate}.html?${urlParams.toString()}`;
                console.log(`Generating receipt from URL: ${fullUrl}`);

                const page = await client.pupBrowser.newPage();
                await page.setViewport({ width: 800, height: 800, deviceScaleFactor: 2 });
                await page.goto(fullUrl, { waitUntil: 'networkidle0' });
                const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
                await page.close();

                const media = new MessageMedia('image/png', screenshotBuffer.toString('base64'), 'SmartReceipt.png');
                await client.sendMessage(senderId, media, { caption: `Here is the receipt for ${userSession.receiptData.customerName}.` });
                
                await db.collection('receipts').insertOne({
                    userId: senderId,
                    createdAt: new Date(),
                    customerName: userSession.receiptData.customerName,
                    totalAmount: subtotal,
                    items: userSession.receiptData.items,
                    prices: userSession.receiptData.prices,
                    paymentMethod: userSession.receiptData.paymentMethod
                });

                if (!isAdmin && !user.isPaid) {
                    await db.collection('users').updateOne({ userId: senderId }, { $inc: { receiptCount: 1 } });
                    const accountDetails = await generateVirtualAccount(user);
                    if (accountDetails && accountDetails.bankName) {
                        const reply = `You have now used your 1 free receipt.\n\n` + `To get lifetime access for *₦${LIFETIME_FEE.toLocaleString()}*, please transfer to this account:\n\n` + `*Bank:* ${accountDetails.bankName}\n` + `*Account Number:* ${accountDetails.accountNumber}\n\n` + `Your access will be unlocked automatically after payment.`;
                        await sendMessageWithDelay(msg, reply);
                    }
                }
                
                userStates.delete(senderId);
                break;
            default:
                const existingUser = await db.collection('users').findOne({ userId: senderId });
                if (!existingUser || !existingUser.onboardingComplete) {
                    userStates.set(senderId, { state: 'awaiting_brand_name' });
                    await sendMessageWithDelay(msg, "👋 Welcome to SmartReceipt!\n\nTo get started, what is your business or brand name?");
                } else {
                    await sendMessageWithDelay(msg, `Welcome back, ${existingUser.brandName}!\n\nType *'new receipt'* or *'stats'* to see your monthly summary.`);
                }
        }
    } catch (err) {
        console.error("An error occurred in message handler:", err);
    }
});

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

