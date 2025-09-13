// --- Dependencies ---
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const crypto = require('crypto');

// --- Local Modules ---
const { connectToDB, getDB, ObjectId } = require('./db.js');
const { sendMessageWithDelay, getRandomReply, isSubscriptionActive } = require('./helpers.js');
const { 
    handleSupportCommand, 
    handleNewTicket, 
    handleTicketResponse, 
    handleAdminTicketsCommand, 
    handleAdminReplyCommand, 
    handleAdminCloseCommand 
} = require('./support.js');

// --- BUSINESS MODEL ---
const YEARLY_FEE = 2000;
const FREE_TRIAL_LIMIT = 3;
const FREE_EDIT_LIMIT = 2;

// --- Configuration ---
const PP_API_KEY = process.env.PP_API_KEY;
const PP_SECRET_KEY = process.env.PP_SECRET_KEY;
const PP_BUSINESS_ID = process.env.PP_BUSINESS_ID;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const RECEIPT_BASE_URL = process.env.RECEIPT_BASE_URL;
const PORT = 3000;
const ADMIN_NUMBERS = ['2347016370067@c.us', '2348146817448@c.us'];

// --- State and Web Server ---
const app = express();
app.use(express.json());
const corsOptions = { origin: ['http://smartnaijaservices.com.ng', 'https://smartnaijaservices.com.ng'] };
app.use(cors(corsOptions));
let client;
const processingUsers = new Set(); 

// --- Helper Functions Specific to this file ---
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
        return response.data?.bankAccounts?.[0] || null;
    } catch (error) {
        console.error("--- PAYMENTPOINT API ERROR ---", error.response?.data || error.message);
        return null;
    }
}

// --- WEB SERVER ROUTES ---
app.get('/', (req, res) => res.status(200).send('SmartReceipt Bot Webhook Server is running.'));

app.post('/webhook', async (req, res) => {
    const db = getDB();
    try {
        console.log("Webhook received from PaymentPoint!");
        const data = req.body;
        console.log("Full Webhook Body:", JSON.stringify(data, null, 2));

        if (data?.customer?.email) {
            let phone = data.customer.email.split('@')[0];
            if (phone.startsWith('0') && phone.length === 11) { phone = '234' + phone.substring(1); }
            const userId = `${phone}@c.us`;
            console.log(`Payment successfully matched to user: ${userId}`);
            
            const expiryDate = new Date();
            expiryDate.setFullYear(expiryDate.getFullYear() + 1);

            const result = await db.collection('users').updateOne(
                { userId: userId }, 
                { $set: { isPaid: true, subscriptionExpiryDate: expiryDate } }
            );

            if (result.modifiedCount > 0) {
                console.log(`User ${userId} unlocked successfully until ${expiryDate.toLocaleDateString()}.`);
                await client.sendMessage(userId, `✅ *Payment Confirmed!* Thank you.\n\nYour SmartReceipt subscription is now active until ${expiryDate.toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })}.`);
            } else {
                 console.log(`Webhook processed, but no user found in DB with ID: ${userId}`);
            }
        }
        res.status(200).send('Webhook processed');
    } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).send('Error processing webhook');
    }
});

// --- WhatsApp Client Initialization ---
client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});
client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('WhatsApp client is ready!'));

// --- Main Message Handling Logic ---
const commands = ['new receipt', 'changereceipt', 'stats', 'history', 'edit', 'export', 'add product', 'products', 'format', 'mybrand', 'cancel', 'commands', 'support', 'backup', 'restore'];
const premiumCommands = ['new receipt', 'edit', 'export']; 

client.on('message', async msg => {
    const senderId = msg.from;
    
    if (processingUsers.has(senderId)) return; 
    processingUsers.add(senderId);

    try {
        const db = getDB();
        const text = msg.body.trim();
        const lowerCaseText = text.toLowerCase();
        
        let user = await db.collection('users').findOne({ userId: senderId });
        const isAdmin = ADMIN_NUMBERS.includes(senderId);
        
        let userSession = await db.collection('conversations').findOne({ userId: senderId });
        const currentState = userSession ? userSession.state : null;
        
        if (isAdmin) {
            if (lowerCaseText === 'tickets') {
                await handleAdminTicketsCommand(msg);
                processingUsers.delete(senderId); return;
            }
            if (lowerCaseText.startsWith('reply ')) {
                await handleAdminReplyCommand(msg, text, client);
                processingUsers.delete(senderId); return;
            }
            if (lowerCaseText.startsWith('close ')) {
                await handleAdminCloseCommand(msg, text);
                processingUsers.delete(senderId); return;
            }
        }

        if (lowerCaseText === 'support') {
            await handleSupportCommand(msg, senderId);
            processingUsers.delete(senderId); return;
        }
        
        const isCommand = commands.includes(lowerCaseText) || lowerCaseText.startsWith('remove product') || lowerCaseText.startsWith('restore');

        if (isCommand) {
            if (currentState) {
                await db.collection('conversations').deleteOne({ userId: senderId });
                userSession = null;
            }
            if (!user && !['cancel', 'restore'].some(c => lowerCaseText.startsWith(c))) {
                const welcomePrompts = [
                    "👋 Welcome! It looks like you're new here. Let's set up your brand first.\n\nWhat is your business name?",
                    "Hello! To get started, please tell me your business name."
                ];
                await sendMessageWithDelay(msg, getRandomReply(welcomePrompts));
                await db.collection('conversations').insertOne({ userId: senderId, state: 'awaiting_brand_name', data: {} });
                processingUsers.delete(senderId);
                return;
            }

            const subscriptionActive = isSubscriptionActive(user, ADMIN_NUMBERS);
            if (!subscriptionActive && premiumCommands.includes(lowerCaseText) && user && user.receiptCount >= FREE_TRIAL_LIMIT) {
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_payment_decision' } }, { upsert: true });
                const paywallMessage = `Dear *${user.brandName}*,\n\nYou have reached your limit of ${FREE_TRIAL_LIMIT} free receipts. To unlock unlimited access, please subscribe for just *₦${YEARLY_FEE.toLocaleString()} per year*.\n\nThis will give you unlimited receipts and full access to all features. Would you like to subscribe?\n\n(Please reply *Yes* or *No*)`;
                await sendMessageWithDelay(msg, paywallMessage);
                processingUsers.delete(senderId);
                return;
            }

            if (lowerCaseText === 'new receipt') {
                const newReceiptPrompts = [
                    '🧾 *New Receipt Started*\n\nWho is the customer?', 'Alright, a new receipt. What is the customer\'s name?', 'Let\'s create a receipt. Who is this for?'
                ];
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'receipt_customer_name', data: { receiptData: {} } } }, { upsert: true });
                await sendMessageWithDelay(msg, getRandomReply(newReceiptPrompts));
            } else if (lowerCaseText === 'edit') {
                const lastReceipt = await db.collection('receipts').findOne({ userId: senderId }, { sort: { createdAt: -1 } });
                if (!lastReceipt) { 
                    const noEditReplies = ["You don't have any recent receipts to edit.", "There are no receipts to edit yet."];
                    await sendMessageWithDelay(msg, getRandomReply(noEditReplies)); 
                } else {
                    const receiptEditCount = lastReceipt.editCount || 0;
                    if (!subscriptionActive && receiptEditCount >= FREE_EDIT_LIMIT) {
                        await sendMessageWithDelay(msg, "This receipt has reached its free edit limit of 2 changes. Please subscribe for unlimited edits.");
                    } else {
                        const editMessage = `Let's edit your last receipt (for *${lastReceipt.customerName}*).\n\nWhat would you like to change?\n*1.* Customer Name\n*2.* Items & Prices\n*3.* Payment Method`;
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_edit_choice', data: { receiptToEdit: lastReceipt } } }, { upsert: true });
                        await sendMessageWithDelay(msg, editMessage);
                    }
                }
            } else if (lowerCaseText === 'history') {
                const recentReceipts = await db.collection('receipts').find({ userId: senderId }).sort({ createdAt: -1 }).limit(5).toArray();
                if (recentReceipts.length === 0) { 
                    const noHistoryReplies = ["You haven't generated any receipts yet.", "There's no receipt history to show yet."];
                    await sendMessageWithDelay(msg, getRandomReply(noHistoryReplies)); 
                } else {
                    let historyMessage = "🧾 *Your 5 Most Recent Receipts:*\n\n";
                    recentReceipts.forEach((r, i) => { historyMessage += `*${i + 1}.* For *${r.customerName}* - ₦${r.totalAmount.toLocaleString()}\n`; });
                    historyMessage += "\nTo resend a receipt, just reply with its number (1-5).";
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_history_choice', data: { history: recentReceipts } } }, { upsert: true });
                    await sendMessageWithDelay(msg, historyMessage);
                }
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
            } else if (lowerCaseText === 'export') {
                await sendMessageWithDelay(msg, "Gathering your data for this month. Please wait a moment...");
                const now = new Date();
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
                const monthName = startOfMonth.toLocaleString('default', { month: 'long' });
                const receipts = await db.collection('receipts').find({ userId: senderId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }).sort({ createdAt: 1 }).toArray();
                if (receipts.length === 0) { await sendMessageWithDelay(msg, "You have no receipts for this month to export."); } 
                else {
                    let fileContent = `SmartReceipt - Sales Report for ${monthName} ${now.getFullYear()}\n`;
                    fileContent += `Brand: ${user.brandName}\n----------------------------------------\n\n`;
                    let totalSales = 0;
                    receipts.forEach(receipt => {
                        fileContent += `Date: ${receipt.createdAt.toLocaleDateString('en-NG')}\nCustomer: ${receipt.customerName}\n`;
                        receipt.items.forEach((item, index) => {
                            fileContent += `  - ${item}: ₦${parseFloat(receipt.prices[index] || 0).toLocaleString()}\n`;
                        });
                        fileContent += `Total: ₦${receipt.totalAmount.toLocaleString()}\n--------------------\n`;
                        totalSales += receipt.totalAmount;
                    });
                    fileContent += `\nGRAND TOTAL FOR ${monthName.toUpperCase()}: ₦${totalSales.toLocaleString()}`;
                    const buffer = Buffer.from(fileContent, 'utf-8');
                    const media = new MessageMedia('text/plain', buffer.toString('base64'), `SmartReceipt_Export_${monthName}.txt`);
                    await client.sendMessage(senderId, media, { caption: `Here is your sales data for ${monthName}.` });
                }
            } else if (lowerCaseText === 'products') {
                const products = await db.collection('products').find({ userId: senderId }).sort({name: 1}).toArray();
                if(products.length === 0) { await sendMessageWithDelay(msg, "You haven't added any products to your catalog yet. Use `add product` to start."); }
                else {
                    let productList = "📦 *Your Product Catalog*\n\n";
                    products.forEach(p => { productList += `*${p.name}* - ₦${p.price.toLocaleString()}\n`; });
                    await sendMessageWithDelay(msg, productList);
                }
            } else if (lowerCaseText === 'add product') {
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'adding_product_name' } }, { upsert: true });
                await sendMessageWithDelay(msg, "Let's add a new product. What is the product's name?");
            } else if (lowerCaseText.startsWith('remove product')) {
                const productName = text.substring(14).trim().replace(/"/g, '');
                if(productName) {
                    const result = await db.collection('products').deleteOne({ userId: senderId, name: { $regex: new RegExp(`^${productName}$`, 'i') } });
                    if(result.deletedCount > 0) { await sendMessageWithDelay(msg, `🗑️ Product "*${productName}*" has been removed.`); }
                    else { await sendMessageWithDelay(msg, `Could not find a product named "*${productName}*".`); }
                } else { await sendMessageWithDelay(msg, 'Invalid format. Please use: `remove product "Product Name"`'); }
            } else if (lowerCaseText === 'mybrand') {
                const brandMessage = `*Your Brand Settings*\n\nWhat would you like to update?\n*1.* Brand Name\n*2.* Brand Color\n*3.* Logo\n*4.* Address\n*5.* Contact Info`;
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_mybrand_choice' } }, { upsert: true });
                await sendMessageWithDelay(msg, brandMessage);
            } else if (lowerCaseText === 'format') {
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_format_choice' } }, { upsert: true });
                const formatMessage = `What format would you like your receipts in?\n\n*1.* Image (PNG) - _Good for sharing_\n*2.* Document (PDF) - _Best for printing & official records_`;
                await sendMessageWithDelay(msg, formatMessage);
            } else if (lowerCaseText === 'changereceipt') {
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_template_choice' } }, { upsert: true });
                await sendMessageWithDelay(msg, "Please choose your new receipt template.\n\nView our 6 high-class designs in the catalog, then send the number of your choice (1-6).");
            } else if (lowerCaseText === 'backup') {
                if (!user || !user.onboardingComplete) {
                    await sendMessageWithDelay(msg, "You must complete your setup before you can create a backup.");
                } else {
                    let backupCode = user.backupCode;
                    if (!backupCode) {
                        backupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
                        await db.collection('users').updateOne({ userId: senderId }, { $set: { backupCode: backupCode } });
                    }
                    const backupMessage = `🔒 *Your Account Backup Code*\n\nHere is your unique recovery code: *${backupCode}*\n\nKeep this code safe! If you ever change your WhatsApp number, use the \`restore\` command on the new number to get all your data and subscription back.`;
                    await sendMessageWithDelay(msg, backupMessage);
                }
            } else if (lowerCaseText.startsWith('restore ')) {
                const code = text.split(' ')[1];
                if (!code) {
                    await sendMessageWithDelay(msg, "Please provide your backup code. Example: `restore A1B2C3D4`");
                } else {
                    const userToRestore = await db.collection('users').findOne({ backupCode: code.toUpperCase() });
                    if (!userToRestore) {
                        await sendMessageWithDelay(msg, "Sorry, that backup code is not valid.");
                    } else if (userToRestore.userId === senderId) {
                        await sendMessageWithDelay(msg, "This account is already linked to that backup code.");
                    } else {
                        await db.collection('users').deleteOne({ userId: senderId });
                        await db.collection('users').updateOne({ _id: userToRestore._id }, { $set: { userId: senderId } });
                        await sendMessageWithDelay(msg, `✅ *Account Restored!* Welcome back, ${userToRestore.brandName}. All your settings and subscription have been transferred to this number.`);
                    }
                }
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
                    "*format* - Set your default receipt format (PNG or PDF).\n" +
                    "*backup* - Get a code to restore your account on a new number.\n" +
                    "*restore [code]* - Restore your account on this number.\n" +
                    "*support* - Create a support ticket to talk to an admin.\n\n" +
                    "*cancel* - Stop any current action.";
                await sendMessageWithDelay(msg, commandsList);
            } else if (lowerCaseText === 'cancel') {
                const cancelReplies = ["Action cancelled.", "Okay, I've stopped the current process.", "No problem, that has been cancelled."];
                await sendMessageWithDelay(msg, getRandomReply(cancelReplies));
            }

        } else if (currentState) {
            const invalidChoiceReplies = ["Invalid choice. Please try again.", "That's not a valid option. Please choose from the list."];
            const updateSuccessReplies = ['✅ Updated successfully!', '✅ All set!', '✅ Done. Your changes have been saved.'];

            switch (currentState) {
                case 'awaiting_support_message':
                    await handleNewTicket(msg, user, client, ADMIN_NUMBERS);
                    break;
                case 'in_support_conversation':
                    await handleTicketResponse(msg, userSession);
                    break;
                
                case 'awaiting_brand_name': {
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
                        break;
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
                    const emailMatch = fullContactText.match(/\S+@\S+\.\S+/);
                    if (emailMatch) { contactEmail = emailMatch[0]; }
                    const phoneText = fullContactText.replace(contactEmail || '', '').trim();
                    if (phoneText.match(/(\+)?\d+/)) { contactPhone = phoneText; }
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { contactInfo: text, contactEmail: contactEmail, contactPhone: contactPhone, onboardingComplete: true } });
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await sendMessageWithDelay(msg, `✅ *Setup Complete!* Your brand profile is all set.\n\nTo create your first receipt, just type:\n*'new receipt'*`);
                    break;
                }
            }
        } else {
            if (!user) {
                await sendMessageWithDelay(msg, "👋 Welcome to SmartReceipt!\n\nLet's get you set up. First, what is your business name?");
                await db.collection('conversations').insertOne({ userId: senderId, state: 'awaiting_brand_name', data: {} });
            } else {
                await sendMessageWithDelay(msg, `Hi ${user.brandName}!\n\nHow can I help you today? Type *'commands'* to see all available options.`);
            }
        }
    } catch (err) {
        console.error("An error occurred in message handler:", err);
    } finally {
        processingUsers.delete(senderId);
    }
});


// --- GENERATION & REGENERATION FUNCTION ---
async function generateAndSendFinalReceipt(senderId, user, receiptData, msg, isResend = false, isEdit = false) {
    const db = getDB();

    if (!isEdit) {
        const genStarts = ["✅ Got it!", "✅ Okay!", "✅ Perfect."];
        const message = isResend ? 'Recreating that receipt for you...' : 'Generating your receipt...';
        await sendMessageWithDelay(msg, `${getRandomReply(genStarts)} ${message}`);
    }

    const format = user.receiptFormat || 'PNG'; 
    const subtotal = receiptData.prices.reduce((sum, price) => sum + parseFloat(price || 0), 0);
    
    let finalReceiptId = receiptData._id;
    if (!isResend) {
        if (isEdit) {
            await db.collection('receipts').updateOne({ _id: new ObjectId(receiptData._id) }, { 
                $set: {
                    customerName: receiptData.customerName, items: receiptData.items, 
                    prices: receiptData.prices.map(p => p.toString()),
                    paymentMethod: receiptData.paymentMethod, totalAmount: subtotal
                },
                $inc: { editCount: 1 }
            });
        } else {
             finalReceiptId = (await db.collection('receipts').insertOne({
                userId: senderId, createdAt: new Date(), customerName: receiptData.customerName,
                totalAmount: subtotal, items: receiptData.items,
                prices: receiptData.prices.map(p=>p.toString()), paymentMethod: receiptData.paymentMethod,
                editCount: 0 
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
        page = await client.pupBrowser.newPage();
        const response = await page.goto(fullUrl, { waitUntil: 'networkidle0' });
        
        if (!response.ok()) {
            console.error(`Failed to load receipt page: ${response.status()} for URL: ${fullUrl}`);
            await sendMessageWithDelay(msg, `Sorry, there was an error preparing your receipt template. Please contact support.`);
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
        
        if (!isResend && !isEdit) {
            await db.collection('users').updateOne({ userId: senderId }, { $inc: { receiptCount: 1 } });
        }
        await db.collection('conversations').deleteOne({ userId: senderId });

    } catch(err) {
        console.error("Error during receipt generation:", err);
        if (page && !page.isClosed()) { await page.close(); }
        const generationErrorReplies = ["Sorry, a technical error occurred while creating the receipt file. Please try again.", "Apologies, something went wrong with the receipt generation. Please try again."];
        await sendMessageWithDelay(msg, getRandomReply(generationErrorReplies));
        await db.collection('conversations').deleteOne({ userId: senderId });
    }
}

// --- Main Function ---
async function startBot() {
    await connectToDB();
    client.initialize();
    app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
}

startBot();
