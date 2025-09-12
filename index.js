// --- Dependencies ---
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient, ObjectId } = require('mongodb');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const crypto = require('crypto');

// --- BUSINESS MODEL ---
const YEARLY_FEE = 2000;
const FREE_TRIAL_LIMIT = 3;
const FREE_EDIT_LIMIT = 2;

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

// --- Database, State, and Web Server ---
let db;
const app = express();
// FIX: Use express.raw for webhook signature verification
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
const corsOptions = { origin: ['http://smartnaijaservices.com.ng', 'https://smartnaijaservices.com.ng'] };
app.use(cors(corsOptions));
let client;
const processingUsers = new Set(); // FIX #4: In-memory lock to prevent race conditions

// --- Database Connection ---
async function connectToDB() {
    try {
        const mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
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

function isSubscriptionActive(user) {
    if (!user) return false;
    if (ADMIN_NUMBERS.includes(user.userId)) return true;
    if (!user.isPaid || !user.subscriptionExpiryDate) {
        return false;
    }
    return new Date() < new Date(user.subscriptionExpiryDate);
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
    if (number.startsWith('234') && number.length === 13) { return '0' + number.substring(3); }
    if (number.length === 10 && !number.startsWith('0')) { return '0' + number; }
    if (number.length === 11 && number.startsWith('0')) { return number; }
    return "INVALID_PHONE_FORMAT"; 
}

// --- PAYMENTPOINT INTEGRATION ---
async function generateVirtualAccount(user) {
    const formattedPhone = formatPhoneNumberForApi(user.userId);
    if (formattedPhone === "INVALID_PHONE_FORMAT") { console.error(`Could not format phone number for user: ${user.userId}`); return null; }
    const options = {
        method: 'POST',
        url: 'https://api.paymentpoint.co/api/v1/createVirtualAccount',
        headers: { 'Content-Type': 'application/json', 'api-key': PP_API_KEY, 'Authorization': `Bearer ${PP_SECRET_KEY}` },
        data: {
            name: user.brandName.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 30),
            email: `${formattedPhone}@smartreceipt.user`, phoneNumber: formattedPhone,
            bankCode: ['20946'], businessId: PP_BUSINESS_ID
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
    // Webhook security should be implemented here if PaymentPoint provides signatures
    try {
        console.log("Webhook received from PaymentPoint!");
        const data = req.body;
        if (data && data.customer && data.customer.customer_phone_number) {
            let phone = data.customer.customer_phone_number;
            if (phone.startsWith('0') && phone.length === 11) { phone = '234' + phone.substring(1); }
            const userId = `${phone}@c.us`;
            console.log(`Payment received for user: ${userId}`);
            
            const expiryDate = new Date();
            expiryDate.setFullYear(expiryDate.getFullYear() + 1);

            const result = await db.collection('users').updateOne(
                { userId: userId }, 
                { $set: { isPaid: true, subscriptionExpiryDate: expiryDate } }
            );

            if (result.modifiedCount > 0) {
                console.log(`User ${userId} unlocked successfully until ${expiryDate.toLocaleDateString()}.`);
                await client.sendMessage(userId, `✅ *Payment Confirmed!* Thank you.\n\nYour SmartReceipt subscription is now active until ${expiryDate.toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })}.`);
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
        if (password !== ADMIN_PASSWORD) { return res.status(401).json({ error: 'Unauthorized: Incorrect password.' }); }
        const usersCollection = db.collection('users');
        const totalUsers = await usersCollection.countDocuments();
        const paidUsers = await usersCollection.countDocuments({ isPaid: true });
        const recentUsers = await usersCollection.find().sort({ createdAt: -1 }).limit(10).toArray();
        const totalRevenue = paidUsers * YEARLY_FEE;
        res.status(200).json({ totalUsers, paidUsers, totalRevenue, recentUsers });
    } catch (error) {
        console.error("Error fetching admin data:", error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/verify-receipt', async (req, res) => {
    try {
        const { id } = req.query;
        if (!id || !ObjectId.isValid(id)) { return res.status(400).json({ error: 'Invalid or missing receipt ID.' }); }
        const receipt = await db.collection('receipts').findOne({ _id: new ObjectId(id) });
        if (!receipt) { return res.status(404).json({ error: 'Receipt not found.' }); }
        res.status(200).json({ customerName: receipt.customerName, totalAmount: receipt.totalAmount, createdAt: receipt.createdAt });
    } catch (error) {
        console.error("Error verifying receipt:", error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// --- WhatsApp Client Initialization ---
client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] }
});
client.on('qr', qr => { qrcode.generate(qr, { small: true }); });
client.on('ready', () => console.log('WhatsApp client is ready!'));

// --- Main Message Handling Logic ---
const commands = ['new receipt', 'changereceipt', 'stats', 'history', 'edit', 'export', 'add product', 'products', 'format', 'mybrand', 'cancel', 'commands'];
const premiumCommands = ['new receipt', 'edit', 'export']; // Commands that require subscription

client.on('message', async msg => {
    const senderId = msg.from;
    
    // FIX #4: Prevent race conditions by processing one message at a time per user
    if (processingUsers.has(senderId)) {
        return; // Ignore message if one is already being processed for this user
    }
    processingUsers.add(senderId);

    try {
        const text = msg.body.trim();
        const lowerCaseText = text.toLowerCase();
        
        let user = await db.collection('users').findOne({ userId: senderId });
        const isAdmin = ADMIN_NUMBERS.includes(senderId);
        
        const userSession = await db.collection('conversations').findOne({ userId: senderId });
        const currentState = userSession ? userSession.state : null;
        
        // RESTRUCTURED LOGIC: Prioritize commands to allow users to break out of conversations
        const isCommand = commands.includes(lowerCaseText) || lowerCaseText.startsWith('remove product');

        if (isCommand) {
            if (currentState) {
                await db.collection('conversations').deleteOne({ userId: senderId });
            }
            if (!user && lowerCaseText !== 'cancel') {
                await sendMessageWithDelay(msg, "👋 Welcome! Please set up your brand first.\n\nWhat is your business name?");
                await db.collection('conversations').insertOne({ userId: senderId, state: 'awaiting_brand_name', data: {} });
                return;
            }

            // FIX #1: Implement Paywall/Free Trial Limit Check
            const subscriptionActive = isSubscriptionActive(user);
            if (!subscriptionActive && premiumCommands.includes(lowerCaseText) && user.receiptCount >= FREE_TRIAL_LIMIT) {
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_payment_decision' } }, { upsert: true });
                const paywallMessage = `Dear *${user.brandName}*,\n\nYou have reached your limit of ${FREE_TRIAL_LIMIT} free receipts. To unlock unlimited access, please subscribe for just *₦${YEARLY_FEE.toLocaleString()} per year*.\n\nThis will give you unlimited receipts and full access to all features. Would you like to subscribe?\n\n(Please reply *Yes* or *No*)`;
                await sendMessageWithDelay(msg, paywallMessage);
                return;
            }

            // --- Command Handling ---
            if (lowerCaseText === 'new receipt') {
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'receipt_customer_name', userId: senderId, data: { receiptData: {} } } }, { upsert: true });
                await sendMessageWithDelay(msg, '🧾 *New Receipt Started*\n\nWho is the customer?');
            } else if (lowerCaseText === 'changereceipt') {
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_template_choice', userId: senderId } }, { upsert: true });
                await sendMessageWithDelay(msg, "Please choose your new receipt template.\n\nView our 6 high-class designs in the catalog, then send the number of your choice (1-6).");
            } else if (lowerCaseText === 'stats') {
                const now = new Date();
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
                const receipts = await db.collection('receipts').find({ userId: senderId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }).toArray();
                const totalSales = receipts.reduce((sum, receipt) => sum + receipt.totalAmount, 0);
                const receiptCount = receipts.length;
                const monthName = startOfMonth.toLocaleString('default', { month: 'long' });
                let statsMessage = `📊 *Your Stats for ${monthName}*\n\n*Receipts Generated:* ${receiptCount}\n*Total Sales:* ₦${totalSales.toLocaleString()}`;
                await sendMessageWithDelay(msg, statsMessage);
            } else if (lowerCaseText === 'history') {
                const recentReceipts = await db.collection('receipts').find({ userId: senderId }).sort({ createdAt: -1 }).limit(5).toArray();
                if (recentReceipts.length === 0) { await sendMessageWithDelay(msg, "You haven't generated any receipts yet."); return; }
                let historyMessage = "🧾 *Your 5 Most Recent Receipts:*\n\n";
                recentReceipts.forEach((r, i) => { historyMessage += `*${i + 1}.* For *${r.customerName}* - ₦${r.totalAmount.toLocaleString()}\n`; });
                historyMessage += "\nTo resend a receipt, just reply with its number (1-5).";
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_history_choice', userId: senderId, data: { history: recentReceipts } } }, { upsert: true });
                await sendMessageWithDelay(msg, historyMessage);
            } else if (lowerCaseText === 'edit') {
                const lastReceipt = await db.collection('receipts').findOne({ userId: senderId }, { sort: { createdAt: -1 } });
                if (!lastReceipt) { await sendMessageWithDelay(msg, "You don't have any recent receipts to edit."); return; }
                const editMessage = `Let's edit your last receipt (for *${lastReceipt.customerName}*).\n\nWhat would you like to change?\n*1.* Customer Name\n*2.* Items & Prices\n*3.* Payment Method`;
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_edit_choice', userId: senderId, data: { receiptToEdit: lastReceipt, editCount: 0 } } }, { upsert: true });
                await sendMessageWithDelay(msg, editMessage);
            } else if (lowerCaseText === 'export') {
                await sendMessageWithDelay(msg, "Gathering your data for this month. Please wait a moment...");
                const now = new Date();
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
                const monthName = startOfMonth.toLocaleString('default', { month: 'long' });
                const receipts = await db.collection('receipts').find({ userId: senderId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }).sort({ createdAt: 1 }).toArray();
                if (receipts.length === 0) { await sendMessageWithDelay(msg, "You have no receipts for this month to export."); return; }
                let fileContent = `SmartReceipt - Sales Report for ${monthName} ${now.getFullYear()}\n`;
                fileContent += `Brand: ${user.brandName}\n`;
                fileContent += `Total Receipts: ${receipts.length}\n`;
                fileContent += "----------------------------------------\n\n";
                let totalSales = 0;
                receipts.forEach(receipt => {
                    const date = receipt.createdAt.toLocaleDateString('en-NG');
                    fileContent += `Date: ${date}\n`;
                    fileContent += `Customer: ${receipt.customerName}\n`;
                    fileContent += `Items:\n`;
                    receipt.items.forEach((item, index) => {
                        const price = parseFloat(receipt.prices[index] || 0);
                        fileContent += `  - ${item}: ₦${price.toLocaleString()}\n`;
                    });
                    fileContent += `Total: ₦${receipt.totalAmount.toLocaleString()}\n`;
                    fileContent += `Payment Method: ${receipt.paymentMethod}\n`;
                    fileContent += "--------------------\n";
                    totalSales += receipt.totalAmount;
                });
                fileContent += `\nGRAND TOTAL FOR ${monthName.toUpperCase()}: ₦${totalSales.toLocaleString()}`;
                const buffer = Buffer.from(fileContent, 'utf-8');
                const media = new MessageMedia('text/plain', buffer.toString('base64'), `SmartReceipt_Export_${monthName}.txt`);
                await client.sendMessage(senderId, media, { caption: `Here is your sales data for ${monthName}.` });
            } else if (lowerCaseText === 'add product') {
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'adding_product_name', userId: senderId } }, { upsert: true });
                await sendMessageWithDelay(msg, "Let's add a new product. What is the product's name?");
            } else if (lowerCaseText.startsWith('remove product')) {
                const productName = text.substring(14).trim().replace(/"/g, '');
                if(productName) {
                    const result = await db.collection('products').deleteOne({ userId: senderId, name: { $regex: new RegExp(`^${productName}$`, 'i') } });
                    if(result.deletedCount > 0) { await sendMessageWithDelay(msg, `🗑️ Product "*${productName}*" has been removed.`); }
                    else { await sendMessageWithDelay(msg, `Could not find a product named "*${productName}*".`); }
                } else { await sendMessageWithDelay(msg, 'Invalid format. Please use: `remove product "Product Name"`'); }
            } else if (lowerCaseText === 'products') {
                const products = await db.collection('products').find({ userId: senderId }).sort({name: 1}).toArray();
                if(products.length === 0) { await sendMessageWithDelay(msg, "You haven't added any products to your catalog yet. Use `add product` to start."); return; }
                let productList = "📦 *Your Product Catalog*\n\n";
                products.forEach(p => { productList += `*${p.name}* - ₦${p.price.toLocaleString()}\n`; });
                await sendMessageWithDelay(msg, productList);
            } else if (lowerCaseText === 'format') {
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_format_choice', userId: senderId } }, { upsert: true });
                const formatMessage = `What format would you like your receipts in?\n\n*1.* Image (PNG) - _Good for sharing_\n*2.* Document (PDF) - _Best for printing & official records_`;
                await sendMessageWithDelay(msg, formatMessage);
            } else if (lowerCaseText === 'mybrand') {
                const brandMessage = `*Your Brand Settings*\n\nWhat would you like to update?\n*1.* Brand Name\n*2.* Brand Color\n*3.* Logo\n*4.* Address\n*5.* Contact Info`;
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_mybrand_choice', userId: senderId } }, { upsert: true });
                await sendMessageWithDelay(msg, brandMessage);
            } else if (lowerCaseText === 'cancel') {
                // The conversation was already deleted above, so we just send a confirmation.
                await sendMessageWithDelay(msg, "Action cancelled.");
            } else if (lowerCaseText === 'commands') {
                const commandsList = "Here are the available commands:\n\n" +
                    "*new receipt* - Start creating a new receipt.\n" +
                    "*edit* - Edit the last receipt you created.\n" +
                    "*history* - See your last 5 receipts.\n" +
                    "*stats* - View your sales stats for the current month.\n" +
                    "*export* - Get a text file of this month's sales data.\n\n" +
                    "_*Catalog Management*_\n" +
                    "*products* - View all your saved products.\n" +
                    "*add product* - Add a new product to your catalog.\n" +
                    "*remove product \"Name\"* - Remove a product.\n\n" +
                    "_*Settings*_\n" +
                    "*mybrand* - Update your brand name, logo, etc.\n" +
                    "*changereceipt* - Change your receipt template design.\n" +
                    "*format* - Set your default receipt format (PNG or PDF).\n\n" +
                    "*cancel* - Stop any current action.";
                await sendMessageWithDelay(msg, commandsList);
            }

        } else if (currentState) {
            // --- STATE-BASED CONVERSATIONS (if not a command)---
            // (The entire switch block from your original code goes here, unchanged)
            // ... [I've collapsed this for brevity, it's the same as your original switch(currentState) block]
            switch (currentState) {
                case 'awaiting_mybrand_choice': {
                    const choice = parseInt(text, 10);
                    let nextState = '';
                    let prompt = '';
                    if (choice === 1) { nextState = 'updating_brand_name'; prompt = 'What is your new brand name?'; }
                    else if (choice === 2) { nextState = 'updating_brand_color'; prompt = 'What is your new brand color?'; }
                    else if (choice === 3) { nextState = 'updating_logo'; prompt = 'Please upload your new logo.'; }
                    else if (choice === 4) { nextState = 'updating_address'; prompt = 'What is your new address?'; }
                    else if (choice === 5) { nextState = 'updating_contact_info'; prompt = 'What is your new contact info?'; }
                    else { await sendMessageWithDelay(msg, "Invalid choice. Please send a number from 1-5."); return; }
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: nextState } });
                    await sendMessageWithDelay(msg, prompt);
                    break;
                }
                case 'updating_brand_name': {
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { brandName: text } });
                    await sendMessageWithDelay(msg, '✅ Brand name updated successfully!');
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                }
                case 'updating_brand_color': {
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { brandColor: text } });
                    await sendMessageWithDelay(msg, '✅ Brand color updated successfully!');
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                }
                case 'updating_logo': {
                    if (msg.hasMedia) {
                        const media = await msg.downloadMedia();
                        await sendMessageWithDelay(msg, "New logo received! Uploading...");
                        const logoUrl = await uploadLogo(media);
                        if (logoUrl) {
                            await db.collection('users').updateOne({ userId: senderId }, { $set: { logoUrl: logoUrl } });
                            await sendMessageWithDelay(msg, "✅ Logo updated successfully!");
                        } else { await sendMessageWithDelay(msg, "Sorry, the logo upload failed."); }
                    } else { await sendMessageWithDelay(msg, "That's not an image. Please upload a logo file."); }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                }
                case 'updating_address': {
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { address: text } });
                    await sendMessageWithDelay(msg, '✅ Address updated successfully!');
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                }
                case 'updating_contact_info': {
                    const fullContactText = text;
                    let contactEmail = null;
                    let contactPhone = null;
                    const emailMatchUpdate = fullContactText.match(/\S+@\S+\.\S+/);
                    if (emailMatchUpdate) { contactEmail = emailMatchUpdate[0]; }
                    const phoneText = fullContactText.replace(contactEmail || '', '').trim();
                    if (phoneText.match(/(\+)?\d+/)) { contactPhone = phoneText; }
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { contactInfo: text, contactEmail: contactEmail, contactPhone: contactPhone } });
                    await sendMessageWithDelay(msg, '✅ Contact info updated successfully!');
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                }
                case 'awaiting_edit_choice': {
                    const editCount = userSession.data.editCount || 0;
                    const subscriptionActive = isSubscriptionActive(user);
                    if (!subscriptionActive && editCount >= FREE_EDIT_LIMIT) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_payment_decision' } });
                        await sendMessageWithDelay(msg, `You have reached the edit limit for this receipt. To make unlimited edits and create unlimited receipts, please subscribe.`);
                        return;
                    }
                    const editChoice = parseInt(text, 10);
                    let nextState = '';
                    let prompt = '';
                    if (editChoice === 1) { nextState = 'editing_customer_name'; prompt = 'What is the new customer name?'; }
                    else if (editChoice === 2) { nextState = 'editing_items'; prompt = 'Please re-enter all items, separated by commas.'; }
                    else if (editChoice === 3) { nextState = 'editing_payment_method'; prompt = 'What is the new payment method?'; }
                    else { await sendMessageWithDelay(msg, "Invalid choice. Please send a number (1-3)."); return; }
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: nextState } });
                    await sendMessageWithDelay(msg, prompt);
                    break;
                }
                case 'editing_customer_name': {
                    userSession.data.receiptToEdit.customerName = text;
                    const newEditCount = (userSession.data.editCount || 0) + 1;
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { 'data.editCount': newEditCount, 'data.receiptToEdit': userSession.data.receiptToEdit }});
                    await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptToEdit, msg, false, true);
                    break;
                }
                case 'editing_items': {
                    userSession.data.receiptToEdit.items = text.split(',').map(item => item.trim());
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'editing_prices', 'data.receiptToEdit': userSession.data.receiptToEdit } });
                    await sendMessageWithDelay(msg, "Items updated. Now, please re-enter all prices in the correct order.");
                    break;
                }
                case 'editing_prices': {
                    userSession.data.receiptToEdit.prices = text.split(',').map(p => p.trim());
                    if (userSession.data.receiptToEdit.items.length !== userSession.data.receiptToEdit.prices.length) {
                        await sendMessageWithDelay(msg, "The number of items and prices don't match. Please try editing again by typing 'edit'.");
                        await db.collection('conversations').deleteOne({ userId: senderId });
                        return;
                    }
                    const newEditCount = (userSession.data.editCount || 0) + 1;
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { 'data.editCount': newEditCount, 'data.receiptToEdit': userSession.data.receiptToEdit }});
                    await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptToEdit, msg, false, true);
                    break;
                }
                case 'editing_payment_method': {
                    userSession.data.receiptToEdit.paymentMethod = text;
                    const newEditCount = (userSession.data.editCount || 0) + 1;
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { 'data.editCount': newEditCount, 'data.receiptToEdit': userSession.data.receiptToEdit }});
                    await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptToEdit, msg, false, true);
                    break;
                }
                case 'awaiting_history_choice': {
                    const historyChoice = parseInt(text, 10);
                    if (historyChoice >= 1 && historyChoice <= userSession.data.history.length) {
                        const selectedReceipt = userSession.data.history[historyChoice - 1];
                        await generateAndSendFinalReceipt(senderId, user, selectedReceipt, msg, true);
                    } else {
                        await sendMessageWithDelay(msg, "Invalid number. Please reply with a number from the list (1-5).");
                        await db.collection('conversations').deleteOne({ userId: senderId }); // End conversation on invalid choice
                    }
                    break;
                }
                case 'awaiting_brand_name': {
                    const existingBrand = await db.collection('users').findOne({ brandName: { $regex: new RegExp(`^${text}$`, 'i') } });
                    if (existingBrand) {
                        await sendMessageWithDelay(msg, "Sorry, that business name is already registered. Please choose a different name.");
                        return;
                    }
                    await db.collection('users').deleteMany({ userId: senderId });
                    await db.collection('users').insertOne({ userId: senderId, brandName: text, onboardingComplete: false, receiptCount: 0, isPaid: false, createdAt: new Date() });
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_brand_color' } });
                    await sendMessageWithDelay(msg, `Great! Your brand is "${text}".\n\nWhat's your brand's main color? (e.g., #1D4ED8 or "blue")`);
                    break;
                }
                case 'awaiting_brand_color': {
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { brandColor: text } });
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_logo' } });
                    await sendMessageWithDelay(msg, `Color saved!\n\nNow, please upload your business logo. If you don't have one, just type *'skip'*.`);
                    break;
                }
                case 'awaiting_logo': {
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
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_address' } });
                    await sendMessageWithDelay(msg, `Logo step complete.\n\nNext, what is your business address?`);
                    break;
                }
                case 'awaiting_address': {
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { address: text } });
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_contact_info' } });
                    await sendMessageWithDelay(msg, `Address saved.\n\nFinally, what contact info should be on the receipt? (e.g., a phone number, an email, or both)`);
                    break;
                }
                case 'awaiting_contact_info': {
                    const fullContactText = text;
                    let contactEmail = null;
                    let contactPhone = null;
                    const emailMatchOnboard = fullContactText.match(/\S+@\S+\.\S+/);
                    if (emailMatchOnboard) { contactEmail = emailMatchOnboard[0]; }
                    const phoneText = fullContactText.replace(contactEmail || '', '').trim();
                    if (phoneText.match(/(\+)?\d+/)) { contactPhone = phoneText; }
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { contactInfo: text, contactEmail: contactEmail, contactPhone: contactPhone, onboardingComplete: true } });
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await sendMessageWithDelay(msg, `✅ *Setup Complete!* Your brand profile is all set.\n\nTo create your first receipt, just type:\n*'new receipt'*`);
                    break;
                }
                case 'adding_product_name': {
                    if (lowerCaseText === 'done') {
                        await db.collection('conversations').deleteOne({ userId: senderId });
                        await sendMessageWithDelay(msg, "Great! Your products have been saved to your catalog.");
                        return;
                    }
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'adding_product_price', 'data.newProductName': text } });
                    await sendMessageWithDelay(msg, `Got it. What's the price for *${text}*?`);
                    break;
                }
                case 'adding_product_price': {
                    const price = parseFloat(text);
                    if (isNaN(price)) {
                        await sendMessageWithDelay(msg, "That's not a valid price. Please send only a number.");
                        return;
                    }
                    const productName = userSession.data.newProductName;
                    await db.collection('products').updateOne(
                        { userId: senderId, name: { $regex: new RegExp(`^${productName}$`, 'i') } },
                        { $set: { price: price, name: productName, userId: senderId } },
                        { upsert: true }
                    );
                    await sendMessageWithDelay(msg, `✅ Saved: *${productName}* - ₦${price.toLocaleString()}.\n\nTo add another, send the next product's name. When you're done, just type *'done'*`);
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'adding_product_name' }, $unset: { 'data.newProductName': '' } });
                    break;
                }
                case 'awaiting_format_choice': {
                    const formatChoice = text.trim();
                    let format = '';
                    if(formatChoice === '1') format = 'PNG';
                    else if (formatChoice === '2') format = 'PDF';
                    else {
                        await sendMessageWithDelay(msg, "Invalid choice. Please reply with *1* for Image or *2* for Document.");
                        return;
                    }
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { receiptFormat: format } });
                    await sendMessageWithDelay(msg, `✅ Preference saved! Your receipts will now be generated as *${format}* files.`);
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                }
                case 'awaiting_initial_format_choice': {
                    const initialFormatChoice = text.trim();
                    let initialFormat = '';
                    if(initialFormatChoice === '1') initialFormat = 'PNG';
                    else if (initialFormatChoice === '2') initialFormat = 'PDF';
                    else {
                        await sendMessageWithDelay(msg, "Invalid choice. Please reply with *1* for Image or *2* for Document.");
                        return;
                    }
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { receiptFormat: initialFormat } });
                    const finalUser = await db.collection('users').findOne({ userId: senderId });
                    await generateAndSendFinalReceipt(senderId, finalUser, userSession.data.receiptData, msg);
                    break;
                }
                case 'awaiting_template_choice': {
                    const templateChoice = parseInt(text, 10);
                    if (templateChoice >= 1 && templateChoice <= 6) {
                        await db.collection('users').updateOne({ userId: senderId }, { $set: { preferredTemplate: templateChoice } });
                        await db.collection('conversations').deleteOne({ userId: senderId });
                        await sendMessageWithDelay(msg, `✅ Template #${templateChoice} is now your default.`);
                    } else {
                        await sendMessageWithDelay(msg, "Invalid selection. Please send a single number between 1 and 6.");
                    }
                    break;
                }
                case 'receipt_customer_name': {
                    const hasProducts = await db.collection('products').findOne({ userId: senderId });
                    const prompt = hasProducts 
                        ? `Customer: *${text}*\n\nNow, add items. Use your catalog (e.g., _Fanta x2_) or type items manually (e.g., _Rice, Beans_).`
                        : `Customer: *${text}*\n\nWhat item(s) did they purchase? (Separate with commas)`;
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'receipt_items', 'data.receiptData.customerName': text } });
                    await sendMessageWithDelay(msg, prompt);
                    break;
                }
                case 'receipt_items': {
                    const items = [];
                    const prices = [];
                    const manualItems = [];
                    const parts = text.split(',');
                    for (const part of parts) {
                        const trimmedPart = part.trim();
                        const quickAddMatch = /(.+)\s+x(\d+)/i.exec(trimmedPart);
                        if (quickAddMatch) {
                            const productName = quickAddMatch[1].trim();
                            const quantity = parseInt(quickAddMatch[2], 10);
                            const product = await db.collection('products').findOne({ userId: senderId, name: { $regex: new RegExp(`^${productName}$`, 'i') } });
                            if (product) {
                                for (let i = 0; i < quantity; i++) { items.push(product.name); prices.push(product.price); }
                            } else {
                                await sendMessageWithDelay(msg, `⚠️ Product not in catalog: "*${productName}*". It will be treated as a manual item.`);
                                manualItems.push(trimmedPart);
                            }
                        } else if (trimmedPart) { manualItems.push(trimmedPart); }
                    }
                    if (manualItems.length > 0) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { 
                            state: 'receipt_manual_prices', 
                            'data.receiptData.manualItems': manualItems,
                            'data.receiptData.quickAddItems': items,
                            'data.receiptData.quickAddPrices': prices
                        }});
                        await sendMessageWithDelay(msg, `Catalog items added. Now, please enter the prices for your manual items:\n\n*${manualItems.join(', ')}*`);
                    } else {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { 
                            state: 'receipt_payment_method', 
                            'data.receiptData.items': items,
                            'data.receiptData.prices': prices.map(p => p.toString())
                        }});
                        await sendMessageWithDelay(msg, `Items and prices added from your catalog.\n\nWhat was the payment method?`);
                    }
                    break;
                }
                case 'receipt_manual_prices': {
                    const manualPrices = text.split(',').map(p => p.trim());
                    if(manualPrices.length !== userSession.data.receiptData.manualItems.length) {
                        await sendMessageWithDelay(msg, "The number of prices does not match the number of manual items. Please try again.");
                        return;
                    }
                    const finalItems = [...userSession.data.receiptData.quickAddItems, ...userSession.data.receiptData.manualItems];
                    const finalPrices = [...userSession.data.receiptData.quickAddPrices, ...manualPrices].map(p => p.toString());
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { 
                        state: 'receipt_payment_method',
                        'data.receiptData.items': finalItems,
                        'data.receiptData.prices': finalPrices
                    }});
                    await sendMessageWithDelay(msg, `Prices saved.\n\nWhat was the payment method?`);
                    break;
                }
                case 'receipt_payment_method': {
                    userSession.data.receiptData.paymentMethod = text;
                     // FIX #6: Removed inefficient DB call here, using the 'user' object from the top of the handler
                    if (!user.receiptFormat) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_initial_format_choice', 'data.receiptData': userSession.data.receiptData } });
                        const formatMessage = `Payment method saved.\n\nOne last thing for your first receipt! What's your preferred format?\n\n*1. Image (PNG)*\n_Good for quick sharing. A standard receipt size._\n\n*2. Document (PDF)*\n_Best for official records or if you sell many items that need a longer receipt._\n\nPlease reply with *1* or *2*.`;
                        await sendMessageWithDelay(msg, formatMessage);
                        return;
                    }
                    await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptData, msg);
                    break;
                }
                 case 'awaiting_payment_decision': {
                    if (lowerCaseText === 'yes') {
                        await sendMessageWithDelay(msg, "Great! Generating a secure payment account for you now...");
                        const accountDetails = await generateVirtualAccount(user);
                        if (accountDetails && accountDetails.bankName) {
                            const reply = `To get your yearly subscription for *₦${YEARLY_FEE.toLocaleString()}*, please transfer to this account:\n\n` + `*Bank:* ${accountDetails.bankName}\n` + `*Account Number:* ${accountDetails.accountNumber}\n\n` + `Your access will be unlocked automatically after payment.`;
                            await msg.reply(reply);
                        } else { await msg.reply("Sorry, I couldn't generate a payment account right now. Please contact support."); }
                    } else if (lowerCaseText === 'no') {
                        await sendMessageWithDelay(msg, "Okay, thank you for trying SmartReceipt! Your access is now limited. Feel free to come back if you change your mind.");
                    } else {
                        await sendMessageWithDelay(msg, "Please reply with just 'Yes' or 'No'.");
                        return;
                    }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                }
            }
        
        } else {
            // --- Fallback for non-command, non-state messages ---
            if (!user) {
                await sendMessageWithDelay(msg, "👋 Welcome to SmartReceipt!\n\nLet's get you set up. First, what is your business name?");
                await db.collection('conversations').insertOne({ userId: senderId, state: 'awaiting_brand_name', data: {} });
            } else {
                // FIX #7: Improved "Welcome Back" message to be less repetitive
                await sendMessageWithDelay(msg, `Hi ${user.brandName}!\n\nHow can I help you today? Type *'commands'* to see all available options.`);
            }
        }
    } catch (err) {
        console.error("An error occurred in message handler:", err);
    } finally {
        // FIX #4: Always release the user lock
        processingUsers.delete(senderId);
    }
});

// --- GENERATION & REGENERATION FUNCTION ---
async function generateAndSendFinalReceipt(senderId, user, receiptData, msg, isResend = false, isEdit = false) {
    const message = isEdit ? 'Regenerating your updated receipt...' : (isResend ? 'Generating your receipt...' : 'Generating your receipt...');
    await sendMessageWithDelay(msg, `✅ Got it! ${message}`);

    const format = user.receiptFormat || 'PNG'; 
    const subtotal = receiptData.prices.reduce((sum, price) => sum + parseFloat(price || 0), 0);
    
    let finalReceiptId = receiptData._id;
    if (!isResend) {
        if (isEdit) {
            await db.collection('receipts').updateOne({ _id: new ObjectId(receiptData._id) }, { $set: {
                customerName: receiptData.customerName, items: receiptData.items, prices: receiptData.prices.map(p => p.toString()),
                paymentMethod: receiptData.paymentMethod, totalAmount: subtotal
            }});
        } else {
             finalReceiptId = (await db.collection('receipts').insertOne({
                userId: senderId, createdAt: new Date(), customerName: receiptData.customerName,
                totalAmount: subtotal, items: receiptData.items,
                prices: receiptData.prices.map(p=>p.toString()), paymentMethod: receiptData.paymentMethod
            })).insertedId;
        }
    }
    
    const urlParams = new URLSearchParams({
        bn: user.brandName, bc: user.brandColor, logo: user.logoUrl || '',
        cn: receiptData.customerName, items: receiptData.items.join('||'),
        prices: receiptData.prices.join(','), pm: receiptData.paymentMethod,
        addr: user.address || '', ciPhone: user.contactPhone || '', ciEmail: user.contactEmail || '',
        rid: finalReceiptId.toString()
    });
    
    const fullUrl = `${RECEIPT_BASE_URL}template.${user.preferredTemplate || 1}.html?${urlParams.toString()}`;
    
    let page;
    try {
        // FIX #2: Move page creation inside the try block
        page = await client.pupBrowser.newPage();
        const response = await page.goto(fullUrl, { waitUntil: 'networkidle0' });
        
        if (!response.ok()) {
            console.error(`Failed to load receipt page: ${response.status()} for URL: ${fullUrl}`);
            await sendMessageWithDelay(msg, `Sorry, there was an error preparing your receipt template. Please check your template files or contact support.`);
            if (page) await page.close();
            await db.collection('conversations').deleteOne({ userId: senderId });
            return;
        }

        let fileBuffer, mimeType, fileName;

        if (format === 'PDF') {
            fileBuffer = await page.pdf({ printBackground: true, width: '800px' });
            mimeType = 'application/pdf';
            fileName = `SmartReceipt_${receiptData.customerName}.pdf`;
        } else {
            await page.setViewport({ width: 800, height: 10, deviceScaleFactor: 2 });
            fileBuffer = await page.screenshot({ fullPage: true, type: 'png' });
            mimeType = 'image/png';
            fileName = 'SmartReceipt.png';
        }
        await page.close();
        
        const media = new MessageMedia(mimeType, fileBuffer.toString('base64'), fileName);
        const caption = `Here is the receipt for ${receiptData.customerName}.`;
        await client.sendMessage(senderId, media, { caption: caption });
        
        // This logic is now separate from the paywall check, which happens before generation
        if (!isResend && !isEdit) {
            await db.collection('users').updateOne({ userId: senderId }, { $inc: { receiptCount: 1 } });
        }

        await db.collection('conversations').deleteOne({ userId: senderId });

    } catch(err) {
        console.error("Error during receipt generation:", err);
        if (page && !page.isClosed()) {
             await page.close();
        }
        await db.collection('conversations').deleteOne({ userId: senderId });
        await sendMessageWithDelay(msg, "Sorry, a technical error occurred while generating the receipt file. Please try again later.");
    }
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
