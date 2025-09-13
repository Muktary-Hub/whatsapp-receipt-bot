// --- Dependencies ---
import pkg from 'whatsapp-web.js'; const { Client, LocalAuth, MessageMedia } = pkg;
import axios from 'axios';
import FormData from 'form-data';
import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode-terminal';
import crypto from 'crypto';

// --- Local Modules ---
import { connectToDB, getDB, ObjectId } from './db.js';
import { sendMessageWithDelay, getRandomReply, isSubscriptionActive } from './helpers.js';
import { 
    handleSupportCommand, 
    handleNewTicket, 
    handleTicketResponse, 
    handleAdminTicketsCommand, 
    handleAdminReplyCommand, 
    handleAdminCloseCommand 
} from './support.js';

// --- BUSINESS MODEL ---
const YEARLY_FEE = 2000;
const FREE_TRIAL_LIMIT = 3;
const FREE_EDIT_LIMIT = 2;

// --- Configuration ---
const PP_API_KEY = process.env.PP_API_KEY;
const PP_SECRET_KEY = process.env.PP_SECRET_KEY;
const PP_BUSINESS_ID = process.env.PP_BUSINESS_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const RECEIPT_BASE_URL = process.env.RECEIPT_BASE_URL;
const PORT = 3000;
const ADMIN_NUMBERS = ['2347016370067@c.us'];

// --- State and Web Server ---
const app = express();
app.use(express.json());
const corsOptions = { origin: ['http://smartnaijaservices.com.ng', 'https://smartnaijaservices.com.ng'] };
app.use(cors(corsOptions));
let client;
const processingUsers = new Set(); 

// --- Helper Functions Specific to this file ---
async function uploadLogo(media) {
    const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
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
    const db = getDB();
    try {
        console.log("Webhook received from PaymentPoint!");
        const data = req.body;
        console.log("Full Webhook Body:", JSON.stringify(data, null, 2));

        if (data && data.customer && data.customer.email) {
            let phone = data.customer.email.split('@')[0];
            
            if (phone.startsWith('0') && phone.length === 11) { 
                phone = '234' + phone.substring(1); 
            }
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

app.post('/admin-data', async (req, res) => {
    const db = getDB();
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
    const db = getDB();
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
                processingUsers.delete(senderId);
                return;
            }
            if (lowerCaseText.startsWith('reply ')) {
                await handleAdminReplyCommand(msg, text, client);
                processingUsers.delete(senderId);
                return;
            }
            if (lowerCaseText.startsWith('close ')) {
                await handleAdminCloseCommand(msg, text);
                processingUsers.delete(senderId);
                return;
            }
        }

        if (lowerCaseText === 'support') {
            await handleSupportCommand(msg, senderId);
            processingUsers.delete(senderId);
            return;
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

            if (lowerCaseText === 'backup') {
                if (!user || !user.onboardingComplete) {
                    await sendMessageWithDelay(msg, "You must complete your setup before you can create a backup.");
                    processingUsers.delete(senderId);
                    return;
                }
                
                let backupCode = user.backupCode;
                if (!backupCode) {
                    backupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { backupCode: backupCode } });
                }
                
                const backupMessage = `🔒 *Your Account Backup Code*\n\nHere is your unique recovery code: *${backupCode}*\n\nKeep this code safe! If you ever change your WhatsApp number, use the \`restore\` command on the new number to get all your data and subscription back.`;
                await sendMessageWithDelay(msg, backupMessage);

            } else if (lowerCaseText.startsWith('restore ')) {
                const code = text.split(' ')[1];
                if (!code) {
                    await sendMessageWithDelay(msg, "Please provide your backup code. Example: `restore A1B2C3D4`");
                    processingUsers.delete(senderId);
                    return;
                }
                
                const userToRestore = await db.collection('users').findOne({ backupCode: code.toUpperCase() });

                if (!userToRestore) {
                    await sendMessageWithDelay(msg, "Sorry, that backup code is not valid.");
                    processingUsers.delete(senderId);
                    return;
                }

                if (userToRestore.userId === senderId) {
                    await sendMessageWithDelay(msg, "This account is already linked to that backup code.");
                    processingUsers.delete(senderId);
                    return;
                }

                await db.collection('users').deleteOne({ userId: senderId });
                await db.collection('users').updateOne({ _id: userToRestore._id }, { $set: { userId: senderId } });
                
                await sendMessageWithDelay(msg, `✅ *Account Restored!* Welcome back, ${userToRestore.brandName}. All your settings and subscription have been transferred to this number.`);

            } else if (lowerCaseText === 'new receipt') {
                const newReceiptPrompts = [
                    '🧾 *New Receipt Started*\n\nWho is the customer?',
                    'Alright, a new receipt. What is the customer\'s name?',
                    'Let\'s create a receipt. Who is this for?'
                ];
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'receipt_customer_name', userId: senderId, data: { receiptData: {} } } }, { upsert: true });
                await sendMessageWithDelay(msg, getRandomReply(newReceiptPrompts));
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
                if (recentReceipts.length === 0) { 
                    const noHistoryReplies = ["You haven't generated any receipts yet.", "There's no receipt history to show yet."];
                    await sendMessageWithDelay(msg, getRandomReply(noHistoryReplies)); 
                } else {
                    let historyMessage = "🧾 *Your 5 Most Recent Receipts:*\n\n";
                    recentReceipts.forEach((r, i) => { historyMessage += `*${i + 1}.* For *${r.customerName}* - ₦${r.totalAmount.toLocaleString()}\n`; });
                    historyMessage += "\nTo resend a receipt, just reply with its number (1-5).";
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_history_choice', userId: senderId, data: { history: recentReceipts } } }, { upsert: true });
                    await sendMessageWithDelay(msg, historyMessage);
                }
            } else if (lowerCaseText === 'edit') {
                const lastReceipt = await db.collection('receipts').findOne({ userId: senderId }, { sort: { createdAt: -1 } });
                if (!lastReceipt) { 
                    const noEditReplies = ["You don't have any recent receipts to edit.", "There are no receipts to edit yet."];
                    await sendMessageWithDelay(msg, getRandomReply(noEditReplies)); 
                } else {
                    const receiptEditCount = lastReceipt.editCount || 0;
                    if (!isSubscriptionActive(user, ADMIN_NUMBERS) && receiptEditCount >= FREE_EDIT_LIMIT) {
                        await sendMessageWithDelay(msg, "This receipt has reached its free edit limit of 2 changes. Please subscribe for unlimited edits.");
                    } else {
                        const editMessage = `Let's edit your last receipt (for *${lastReceipt.customerName}*).\n\nWhat would you like to change?\n*1.* Customer Name\n*2.* Items & Prices\n*3.* Payment Method`;
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_edit_choice', userId: senderId, data: { receiptToEdit: lastReceipt } } }, { upsert: true });
                        await sendMessageWithDelay(msg, editMessage);
                    }
                }
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
                
                // All other existing states are now included below
                case 'awaiting_mybrand_choice': {
                    const choice = parseInt(text, 10);
                    let nextState = '';
                    let prompt = '';
                    if (choice === 1) { nextState = 'updating_brand_name'; prompt = 'What is your new brand name?'; }
                    else if (choice === 2) { nextState = 'updating_brand_color'; prompt = 'What is your new brand color?'; }
                    else if (choice === 3) { nextState = 'updating_logo'; prompt = 'Please upload your new logo.'; }
                    else if (choice === 4) { nextState = 'updating_address'; prompt = 'What is your new address?'; }
                    else if (choice === 5) { nextState = 'updating_contact_info'; prompt = 'What is your new contact info?'; }
                    else { await sendMessageWithDelay(msg, getRandomReply(invalidChoiceReplies)); break; }
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: nextState } });
                    await sendMessageWithDelay(msg, prompt);
                    break;
                }
                case 'updating_brand_name': {
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { brandName: text } });
                    await sendMessageWithDelay(msg, getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                }
                case 'updating_brand_color': {
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { brandColor: text } });
                    await sendMessageWithDelay(msg, getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne({ userId: senderId });
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
                    customerName: receiptData.customerName, 
                    items: receiptData.items, 
                    prices: receiptData.prices.map(p => p.toString()),
                    paymentMethod: receiptData.paymentMethod, 
                    totalAmount: subtotal
                }
            });
        } else {
             finalReceiptId = (await db.collection('receipts').insertOne({
                userId: senderId, 
                createdAt: new Date(), 
                customerName: receiptData.customerName,
                totalAmount: subtotal, 
                items: receiptData.items,
                prices: receiptData.prices.map(p=>p.toString()), 
                paymentMethod: receiptData.paymentMethod,
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
            await sendMessageWithDelay(msg, `Sorry, there was an error preparing your receipt template. Please check your template files or contact support.`);
            if (page) await page.close();
            if(!isEdit) await db.collection('conversations').deleteOne({ userId: senderId });
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

    } catch(err) {
        console.error("Error during receipt generation:", err);
        if (page && !page.isClosed()) {
             await page.close();
        }
        const generationErrorReplies = ["Sorry, a technical error occurred while generating the receipt file. Please try again later.", "Apologies, something went wrong while creating your receipt. Please try the command again."];
        await sendMessageWithDelay(msg, getRandomReply(generationErrorReplies));
        if(!isEdit) await db.collection('conversations').deleteOne({ userId: senderId });
    }
}

// --- Main Function ---
async function startBot() {
    await connectToDB();
    client.initialize();
    app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
}

startBot();
