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

// --- Helper Function to Parse User Input ---
function parseInputList(text) {
    const normalizedText = text.replace(/\n/g, ',');
    const parts = normalizedText.split(',').map(part => part.trim()).filter(part => part.length > 0);
    return parts;
}

// --- BUSINESS MODEL ---
const SUBSCRIPTION_FEE = 2000;
const FREE_TRIAL_LIMIT = 2;
const FREE_EDIT_LIMIT = 1;

// --- Configuration ---
const PP_API_KEY = process.env.PP_API_KEY;
const PP_SECRET_KEY = process.env.PP_SECRET_KEY;
const PP_BUSINESS_ID = process.env.PP_BUSINESS_ID;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const RECEIPT_BASE_URL = process.env.RECEIPT_BASE_URL;
const PORT = process.env.PORT || 3000;
const ADMIN_NUMBERS = ['2347016370067@c.us', '2348146817448@c.us'];

// --- State and Web Server ---
const app = express();
app.use(express.json());
const corsOptions = { origin: ['http://smartnaijaservices.com.ng', 'https://smartnaijaservices.com.ng'] };
app.use(cors(corsOptions));
let client;
const processingUsers = new Set(); 

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

app.get('/', (req, res) => res.status(200).send('SmartReceipt Bot Webhook Server is running.'));

app.post('/webhook', async (req, res) => {
    const db = getDB();
    try {
        console.log("Webhook received from PaymentPoint!");
        const data = req.body;
        
        // FIX #2: Added a robust check to prevent crashes on malformed webhook data.
        if (data && data.customer && typeof data.customer.email === 'string') {
            let phone = data.customer.email.split('@')[0];
            if (phone.startsWith('0') && phone.length === 11) { phone = '234' + phone.substring(1); }
            const userId = `${phone}@c.us`;
            console.log(`Payment successfully matched to user: ${userId}`);
            
            const expiryDate = new Date();
            expiryDate.setMonth(expiryDate.getMonth() + 6);

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
        } else {
            console.warn("Webhook received with missing or invalid customer email.", data);
        }
        res.status(200).send('Webhook processed');
    } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).send('Error processing webhook');
    }
});

client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', qr => console.log('HERE IS THE QR CODE TEXT TO COPY:', qr));
client.on('ready', () => console.log('WhatsApp client is ready!'));

const commands = ['new receipt', 'changereceipt', 'stats', 'history', 'edit', 'export', 'add product', 'products', 'format', 'mybrand', 'cancel', 'commands', 'support', 'backup', 'restore', 'settings'];
const premiumCommands = ['new receipt', 'edit', 'export']; 

client.on('message', async msg => {
    const chat = await msg.getChat();
    if (chat.isGroup) {
        return; 
    }

    const senderId = msg.from;
    
    if (processingUsers.has(senderId)) return; 
    processingUsers.add(senderId);

    try {
        const db = getDB();
        const text = msg.body.trim();
        const lowerCaseText = text.toLowerCase();
        
        let user = await db.collection('users').findOne({ userId: senderId });
        const isAdmin = ADMIN_NUMBERS.includes(senderId);
        
        // --- FIX #1: NEW USER ONBOARDING LOGIC MOVED TO THE TOP ---
        // This ensures any new user sending any message is onboarded correctly.
        if (!user && !lowerCaseText.startsWith('restore')) {
            const settings = await db.collection('settings').findOne({ _id: 'global_settings' });
            const registrationsOpen = settings ? settings.registrationsOpen : true; 

            if (!registrationsOpen) {
                await msg.reply("We apologize, but new user onboarding is not available at the moment. Please try again later.");
            } else {
                // --- FIX #4: ADDED A PROMINENT WARNING FOR THE GROUP ID ---
                // !!! IMPORTANT !!!
                // YOU MUST REPLACE THE PLACEHOLDER BELOW WITH YOUR ACTUAL WHATSAPP GROUP ID.
                // IF YOU DON'T, NEW USER REGISTRATION WILL FAIL FOR EVERYONE.
                // Example: '1234567890-12345678@g.us'
                const REQUIRED_WHATSAPP_GROUP_ID = 'YOUR_GROUP_ID@g.us'; 

                try {
                    const groupChat = await client.getChatById(REQUIRED_WHATSAPP_GROUP_ID);
                    const isUserInGroup = groupChat.participants.some(p => p.id._serialized === senderId);

                    if (isUserInGroup) {
                        const welcomePrompts = ["👋 Welcome! It looks like you're new here. Let's set up your brand first.\n\nWhat is your business name?"];
                        await sendMessageWithDelay(msg, getRandomReply(welcomePrompts));
                        await db.collection('conversations').insertOne({ userId: senderId, state: 'awaiting_brand_name', data: {} });
                    } else {
                        await msg.reply(`Access denied. To use this bot, you must be a member of the designated group. If you would like to join, please reach out to support through your referral.`);
                    }
                } catch (e) {
                    console.error("Could not check group membership. Is the bot in the group? Is the GROUP ID correct?", e);
                    await msg.reply("Sorry, I'm having trouble verifying new users right now. Please ensure you have joined the required group.");
                }
            }
            
            processingUsers.delete(senderId);
            return; // Stop further processing for a new user
        }
        
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
                await handleAdminCloseCommand(msg, text, ADMIN_NUMBERS, client);
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
            
            const subscriptionActive = isSubscriptionActive(user, ADMIN_NUMBERS);
            if (!subscriptionActive && premiumCommands.includes(lowerCaseText) && user && user.receiptCount >= FREE_TRIAL_LIMIT) {
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_payment_decision' } }, { upsert: true });
                const paywallMessage = `Dear *${user.brandName}*,\n\nYou have reached your limit of ${FREE_TRIAL_LIMIT} free receipts. To unlock unlimited access, please subscribe for just *₦${SUBSCRIPTION_FEE.toLocaleString()} for 6 months*.\n\n(Please reply *Yes* or *No*)`;
                await sendMessageWithDelay(msg, paywallMessage);
                processingUsers.delete(senderId);
                return;
            }
            
            const commandToRun = lowerCaseText.split(' ')[0];

            switch (commandToRun) {
                case 'settings':
                    if(isAdmin){
                        const settings = await db.collection('settings').findOne({ _id: 'global_settings' });
                        const regStatus = (settings && settings.registrationsOpen === false) ? 'CLOSED' : 'OPEN';
                        let settingsMessage = `*Admin Control Panel*\n\n1. New User Registrations (Currently: *${regStatus}*)\n\nReply with the number of the setting you want to change.`;
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_settings_choice' } }, { upsert: true });
                        await msg.reply(settingsMessage);
                    }
                    break;
                case 'new': // Catches 'new receipt'
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'receipt_customer_name', data: { receiptData: {} } } }, { upsert: true });
                    await msg.reply('🧾 *New Receipt Started*\n\nWho is the customer?');
                    break;
                case 'edit':
                    const lastReceipt = await db.collection('receipts').findOne({ userId: senderId }, { sort: { createdAt: -1 } });
                    if (!lastReceipt) { 
                        await msg.reply("You don't have any recent receipts to edit."); 
                    } else {
                        const receiptEditCount = lastReceipt.editCount || 0;
                        if (!subscriptionActive && receiptEditCount >= FREE_EDIT_LIMIT) {
                            await msg.reply("This receipt has reached its free edit limit. Please subscribe for unlimited edits.");
                        } else {
                            const editMessage = `Let's edit your last receipt (for *${lastReceipt.customerName}*).\n\nWhat would you like to change?\n*1.* Customer Name\n*2.* Items & Prices\n*3.* Payment Method`;
                            await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_edit_choice', data: { receiptToEdit: lastReceipt } } }, { upsert: true });
                            await msg.reply(editMessage);
                        }
                    }
                    break;
                case 'history':
                    const recentReceipts = await db.collection('receipts').find({ userId: senderId }).sort({ createdAt: -1 }).limit(5).toArray();
                    if (recentReceipts.length === 0) { 
                        await msg.reply("You haven't generated any receipts yet."); 
                    } else {
                        let historyMessage = "🧾 *Your 5 Most Recent Receipts:*\n\n";
                        recentReceipts.forEach((r, i) => { historyMessage += `*${i + 1}.* For *${r.customerName}* - ₦${r.totalAmount.toLocaleString()}\n`; });
                        historyMessage += "\nTo resend a receipt, just reply with its number (1-5).";
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_history_choice', data: { history: recentReceipts } } }, { upsert: true });
                        await msg.reply(historyMessage);
                    }
                    break;
                case 'stats':
                    const now = new Date();
                    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
                    const receipts = await db.collection('receipts').find({ userId: senderId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }).toArray();
                    const totalSales = receipts.reduce((sum, receipt) => sum + receipt.totalAmount, 0);
                    const receiptCount = receipts.length;
                    const monthName = startOfMonth.toLocaleString('default', { month: 'long' });
                    let statsMessage = `📊 *Your Stats for ${monthName}*\n\n*Receipts Generated:* ${receiptCount}\n*Total Sales:* ₦${totalSales.toLocaleString()}`;
                    await msg.reply(statsMessage);
                    break;
                case 'export':
                    await msg.reply("Gathering your data for this month...");
                    const exportNow = new Date();
                    const exportStartOfMonth = new Date(exportNow.getFullYear(), exportNow.getMonth(), 1);
                    const exportEndOfMonth = new Date(exportNow.getFullYear(), exportNow.getMonth() + 1, 0, 23, 59, 59);
                    const exportMonthName = exportStartOfMonth.toLocaleString('default', { month: 'long' });
                    const exportReceipts = await db.collection('receipts').find({ userId: senderId, createdAt: { $gte: exportStartOfMonth, $lte: exportEndOfMonth } }).sort({ createdAt: 1 }).toArray();
                    if (exportReceipts.length === 0) { await msg.reply("You have no receipts for this month to export."); } 
                    else {
                        let fileContent = `SmartReceipt - Sales Report for ${exportMonthName} ${exportNow.getFullYear()}\n`;
                        fileContent += `Brand: ${user.brandName}\n----------------------------------------\n\n`;
                        let totalSales = 0;
                        exportReceipts.forEach(receipt => {
                            fileContent += `Date: ${receipt.createdAt.toLocaleDateString('en-NG')}\nCustomer: ${receipt.customerName}\n`;
                            receipt.items.forEach((item, index) => {
                                fileContent += `  - ${item}: ₦${parseFloat(receipt.prices[index] || 0).toLocaleString()}\n`;
                            });
                            fileContent += `Total: ₦${receipt.totalAmount.toLocaleString()}\n--------------------\n`;
                            totalSales += receipt.totalAmount;
                        });
                        fileContent += `\nGRAND TOTAL FOR ${exportMonthName.toUpperCase()}: ₦${totalSales.toLocaleString()}`;
                        const buffer = Buffer.from(fileContent, 'utf-8');
                        const media = new MessageMedia('text/plain', buffer.toString('base64'), `SmartReceipt_Export_${exportMonthName}.txt`);
                        await client.sendMessage(senderId, media, { caption: `Here is your sales data for ${exportMonthName}.` });
                    }
                    break;
                case 'products':
                    const products = await db.collection('products').find({ userId: senderId }).sort({name: 1}).toArray();
                    if(products.length === 0) { await msg.reply("You haven't added any products. Use `add product` to start."); }
                    else {
                        let productList = "📦 *Your Product Catalog*\n\n";
                        products.forEach(p => { productList += `*${p.name}* - ₦${p.price.toLocaleString()}\n`; });
                        await msg.reply(productList);
                    }
                    break;
                case 'add': // catches 'add product'
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'adding_product_name' } }, { upsert: true });
                    await msg.reply("Let's add a new product. What is the product's name?");
                    break;
                case 'remove': // catches 'remove product'
                    // FIX #3: Corrected the logic to properly extract the product name.
                    const productName = text.substring('remove product'.length).trim().replace(/"/g, '');
                    if(productName) {
                        const result = await db.collection('products').deleteOne({ userId: senderId, name: { $regex: new RegExp(`^${productName}$`, 'i') } });
                        if(result.deletedCount > 0) { await msg.reply(`🗑️ Product "*${productName}*" has been removed.`); }
                        else { await msg.reply(`Could not find a product named "*${productName}*". Check spelling and capitalization.`); }
                    } else { await msg.reply('Invalid format. Please use: `remove product "Product Name"`'); }
                    break;
                case 'mybrand':
                    const brandMessage = `*Your Brand Settings*\n\nWhat would you like to update?\n*1.* Brand Name\n*2.* Brand Color\n*3.* Logo\n*4.* Address\n*5.* Contact Info`;
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_mybrand_choice' } }, { upsert: true });
                    await msg.reply(brandMessage);
                    break;
                case 'format':
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_format_choice' } }, { upsert: true });
                    const formatMessage = `What format would you like your receipts in?\n\n*1.* Image (PNG) - _Good for sharing_\n*2.* Document (PDF) - _Best for printing & official records_`;
                    await msg.reply(formatMessage);
                    break;
                case 'changereceipt':
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_template_choice' } }, { upsert: true });
                    await msg.reply("Please choose your new receipt template (1-6).");
                    break;
                case 'backup':
                    if (!user || !user.onboardingComplete) {
                        await msg.reply("You must complete your setup before you can create a backup.");
                    } else {
                        let backupCode = user.backupCode;
                        if (!backupCode) {
                            backupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
                            await db.collection('users').updateOne({ userId: senderId }, { $set: { backupCode: backupCode } });
                        }
                        const backupMessage = `🔒 *Your Account Backup Code*\n\nYour unique recovery code: *${backupCode}*\n\nKeep this code safe! If you change your WhatsApp number, use the \`restore\` command on the new number.`;
                        await msg.reply(backupMessage);
                    }
                    break;
                case 'restore':
                    const code = text.split(' ')[1];
                    if (!code) {
                        await msg.reply("Please provide a backup code. Example: `restore A1B2C3D4`");
                    } else {
                        const userToRestore = await db.collection('users').findOne({ backupCode: code.toUpperCase() });
                        if (!userToRestore) {
                            await msg.reply("Sorry, that backup code is not valid.");
                        } else if (userToRestore.userId === senderId) {
                            await msg.reply("This account is already linked to that backup code.");
                        } else {
                            await db.collection('users').deleteOne({ userId: senderId });
                            await db.collection('users').updateOne({ _id: userToRestore._id }, { $set: { userId: senderId } });
                            await msg.reply(`✅ *Account Restored!* Welcome back, ${userToRestore.brandName}. All your data has been transferred.`);
                        }
                    }
                    break;
                case 'commands':
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
                    await msg.reply(commandsList);
                    break;
                case 'cancel':
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await msg.reply("Action cancelled.");
                    break;
            }

        } else if (currentState) {
            const invalidChoiceReplies = ["Invalid choice. Please try again.", "That's not a valid option."];
            const updateSuccessReplies = ['✅ Updated successfully!', '✅ All set!', '✅ Done.'];

            switch (currentState) {
                // --- SUPPORT STATES ---
                case 'awaiting_support_message':
                    await handleNewTicket(msg, user, client, ADMIN_NUMBERS);
                    break;
                case 'in_support_conversation':
                    await handleTicketResponse(msg, userSession);
                    break;
                
                // --- ONBOARDING STATES ---
                case 'awaiting_brand_name':
                    await db.collection('users').insertOne({ userId: senderId, brandName: text, onboardingComplete: false, receiptCount: 0, isPaid: false, createdAt: new Date() });
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_brand_color' } });
                    await msg.reply(`Great! Your brand is "${text}".\n\nWhat's your brand's main color? (e.g., #1D4ED8 or "blue")`);
                    break;
                case 'awaiting_brand_color':
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { brandColor: text } });
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_logo' } });
                    await msg.reply(`Color saved!\n\nNow, please upload your business logo. If you don't have one, just type *'skip'*.`);
                    break;
                case 'awaiting_logo':
                    if (msg.hasMedia) {
                        const media = await msg.downloadMedia();
                        await msg.reply("Logo received! Uploading now, please wait...");
                        const logoUrl = await uploadLogo(media);
                        if (logoUrl) {
                            await db.collection('users').updateOne({ userId: senderId }, { $set: { logoUrl: logoUrl } });
                            await msg.reply("Logo uploaded successfully!");
                        } else {
                            await msg.reply("Sorry, I couldn't upload the logo. We'll proceed without it for now.");
                        }
                    } else if (lowerCaseText !== 'skip') {
                        await msg.reply("That's not an image. Please upload a logo file or type 'skip'.");
                        break;
                    }
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_address' } });
                    await msg.reply(`Logo step complete.\n\nNext, what is your business address?`);
                    break;
                case 'awaiting_address':
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { address: text } });
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_contact_info' } });
                    await msg.reply(`Address saved.\n\nFinally, what contact info should be on the receipt? (e.g., a phone number or email)`);
                    break;
                case 'awaiting_contact_info':
                    const fullContactText = text;
                    let contactEmail = null;
                    let contactPhone = null;
                    const emailMatch = fullContactText.match(/\S+@\S+\.\S+/);
                    if (emailMatch) { contactEmail = emailMatch[0]; }
                    const phoneText = fullContactText.replace(contactEmail || '', '').trim();
                    if (phoneText.match(/(\+)?\d+/)) { contactPhone = phoneText; }
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { contactInfo: text, contactEmail: contactEmail, contactPhone: contactPhone, onboardingComplete: true } });
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await msg.reply(`✅ *Setup Complete!* Your brand profile is all set.\n\nTo create your first receipt, just type:\n*'new receipt'*`);
                    break;

                // --- RECEIPT CREATION STATES ---
                case 'receipt_customer_name':
                    const hasProducts = await db.collection('products').findOne({ userId: senderId });
                    const prompt = hasProducts 
                        ? `Customer: *${text}*\n\nNow, add items. You can use your catalog (e.g., _Fanta x2_) or type items manually.\n\n*(Separate with commas or new lines)*`
                        : `Customer: *${text}*\n\nWhat item(s) did they purchase?\n\n*(Separate with commas or new lines)*`;
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'receipt_items', 'data.receiptData.customerName': text } });
                    await msg.reply(prompt);
                    break;
                case 'receipt_items':
                    const items = []; const prices = []; const manualItems = [];
                    const parts = parseInputList(text);
                    for (const part of parts) {
                        const trimmedPart = part.trim();
                        const quickAddMatch = /(.+)\s+x(\d+)/i.exec(trimmedPart);
                        if (quickAddMatch) {
                            const productName = quickAddMatch[1].trim();
                            const quantity = parseInt(quickAddMatch[2], 10);
                            const product = await db.collection('products').findOne({ userId: senderId, name: { $regex: new RegExp(`^${productName}$`, 'i') } });
                            if (product) {
                                for (let i = 0; i < quantity; i++) { items.push(product.name); prices.push(product.price); }
                            } else { manualItems.push(trimmedPart); }
                        } else if (trimmedPart) { manualItems.push(trimmedPart); }
                    }
                    if (manualItems.length > 0) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { 
                            state: 'receipt_manual_prices', 'data.receiptData.manualItems': manualItems,
                            'data.receiptData.quickAddItems': items, 'data.receiptData.quickAddPrices': prices
                        }});
                        await msg.reply(`Catalog items added. Now, please enter the prices for your manual items, *each on a new line or separated by commas*:\n\n*${manualItems.join('\n')}*`);
                    } else {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { 
                            state: 'receipt_payment_method', 'data.receiptData.items': items,
                            'data.receiptData.prices': prices.map(p => p.toString())
                        }});
                        await msg.reply(`Items and prices added from your catalog.\n\nWhat was the payment method?`);
                    }
                    break;
                case 'receipt_manual_prices':
                    const manualPrices = parseInputList(text);
                    if(manualPrices.length !== userSession.data.receiptData.manualItems.length) {
                        await msg.reply("The number of prices does not match the number of manual items. Please try again.");
                        break;
                    }
                    const finalItems = [...(userSession.data.receiptData.quickAddItems || []), ...(userSession.data.receiptData.manualItems || [])];
                    const finalPrices = [...(userSession.data.receiptData.quickAddPrices || []), ...manualPrices].map(p => p.toString());
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { 
                        state: 'receipt_payment_method', 'data.receiptData.items': finalItems, 'data.receiptData.prices': finalPrices
                    }});
                    await msg.reply(`Prices saved.\n\nWhat was the payment method?`);
                    break;
                case 'receipt_payment_method':
                    userSession.data.receiptData.paymentMethod = text;
                    if (!user.receiptFormat) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_initial_format_choice', 'data.receiptData': userSession.data.receiptData } });
                        const formatMessage = `Payment method saved.\n\nFor your first receipt, what's your preferred format?\n\n*1. Image (PNG)*\n*2. Document (PDF)*\n\nPlease reply with *1* or *2*.`;
                        await msg.reply(formatMessage);
                    } else {
                        await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptData, msg);
                    }
                    break;

                // --- EDITING STATES ---
                case 'awaiting_edit_choice':
                    const editChoice = parseInt(text, 10);
                    if (editChoice === 1) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'editing_customer_name' } });
                        await msg.reply('What is the new customer name?');
                    } else if (editChoice === 2) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'editing_items' } });
                        await msg.reply('Please re-enter all items, *separated by commas or on new lines*.');
                    } else if (editChoice === 3) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'editing_payment_method' } });
                        await msg.reply('What is the new payment method?');
                    } else {
                        await msg.reply(getRandomReply(invalidChoiceReplies));
                    }
                    break;
                case 'editing_customer_name':
                    userSession.data.receiptToEdit.customerName = text;
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptToEdit, msg, false, true);
                    break;
                case 'editing_items':
                    userSession.data.receiptToEdit.items = parseInputList(text);
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'editing_prices', 'data.receiptToEdit': userSession.data.receiptToEdit } });
                    await msg.reply("Items updated. Now, please re-enter all prices in the correct order.");
                    break;
                case 'editing_prices':
                    userSession.data.receiptToEdit.prices = parseInputList(text);
                    if (userSession.data.receiptToEdit.items.length !== userSession.data.receiptToEdit.prices.length) {
                        await msg.reply("The number of items and prices don't match. Please try editing again by typing 'edit'.");
                        await db.collection('conversations').deleteOne({ userId: senderId });
                        break;
                    }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptToEdit, msg, false, true);
                    break;
                case 'editing_payment_method':
                    userSession.data.receiptToEdit.paymentMethod = text;
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptToEdit, msg, false, true);
                    break;

                // --- MYBRAND STATES ---
                case 'awaiting_mybrand_choice':
                    const mybrandChoice = parseInt(text, 10);
                    let nextState = '', prompt = '';
                    if (mybrandChoice === 1) { nextState = 'updating_brand_name'; prompt = 'What is your new brand name?'; }
                    else if (mybrandChoice === 2) { nextState = 'updating_brand_color'; prompt = 'What is your new brand color?'; }
                    else if (mybrandChoice === 3) { nextState = 'updating_logo'; prompt = 'Please upload your new logo.'; }
                    else if (mybrandChoice === 4) { nextState = 'updating_address'; prompt = 'What is your new address?'; }
                    else if (mybrandChoice === 5) { nextState = 'updating_contact_info'; prompt = 'What is your new contact info?'; }
                    else { await msg.reply(getRandomReply(invalidChoiceReplies)); break; }
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: nextState } });
                    await msg.reply(prompt);
                    break;
                case 'updating_brand_name':
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { brandName: text } });
                    await msg.reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                case 'updating_brand_color':
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { brandColor: text } });
                    await msg.reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                case 'updating_logo':
                     if (msg.hasMedia) {
                        const media = await msg.downloadMedia();
                        await msg.reply("New logo received! Uploading...");
                        const logoUrl = await uploadLogo(media);
                        if (logoUrl) {
                            await db.collection('users').updateOne({ userId: senderId }, { $set: { logoUrl: logoUrl } });
                            await msg.reply("✅ Logo updated successfully!");
                        } else { await msg.reply("Sorry, the logo upload failed."); }
                    } else { await msg.reply("That's not an image. Please upload a logo file."); }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                case 'updating_address':
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { address: text } });
                    await msg.reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                case 'updating_contact_info':
                    const fullContactTextUpdate = text;
                    let contactEmailUpdate = null, contactPhoneUpdate = null;
                    const emailMatchUpdate = fullContactTextUpdate.match(/\S+@\S+\.\S+/);
                    if (emailMatchUpdate) { contactEmailUpdate = emailMatchUpdate[0]; }
                    const phoneTextUpdate = fullContactTextUpdate.replace(contactEmailUpdate || '', '').trim();
                    if (phoneTextUpdate.match(/(\+)?\d+/)) { contactPhoneUpdate = phoneTextUpdate; }
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { contactInfo: text, contactEmail: contactEmailUpdate, contactPhone: contactPhoneUpdate } });
                    await msg.reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;

                // --- OTHER CONVERSATION STATES ---
                case 'awaiting_history_choice':
                    const historyChoice = parseInt(text, 10);
                    if (historyChoice >= 1 && historyChoice <= userSession.data.history.length) {
                        const selectedReceipt = userSession.data.history[historyChoice - 1];
                        await db.collection('conversations').deleteOne({ userId: senderId });
                        await generateAndSendFinalReceipt(senderId, user, selectedReceipt, msg, true);
                    } else {
                        await msg.reply("Invalid number. Action cancelled.");
                        await db.collection('conversations').deleteOne({ userId: senderId });
                    }
                    break;
                case 'awaiting_template_choice':
                    const templateChoice = parseInt(text, 10);
                    if (templateChoice >= 1 && templateChoice <= 6) {
                        await db.collection('users').updateOne({ userId: senderId }, { $set: { preferredTemplate: templateChoice } });
                        await db.collection('conversations').deleteOne({ userId: senderId });
                        await msg.reply(`✅ Template #${templateChoice} is now your default.`);
                    } else {
                        await msg.reply("Invalid selection. Please send a number between 1 and 6.");
                    }
                    break;
                case 'adding_product_name':
                    if (lowerCaseText === 'done') {
                        await db.collection('conversations').deleteOne({ userId: senderId });
                        await msg.reply("Great! Your products have been saved.");
                        break;
                    }
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'adding_product_price', 'data.newProductName': text } });
                    await msg.reply(`Got it. What's the price for *${text}*?`);
                    break;
                case 'adding_product_price':
                    const price = parseFloat(text.trim().replace(/,/g, ''));
                    if (isNaN(price)) {
                        await msg.reply("That's not a valid price. Please send only a number.");
                        break;
                    }
                    const newProductName = userSession.data.newProductName;
                    await db.collection('products').updateOne(
                        { userId: senderId, name: { $regex: new RegExp(`^${newProductName}$`, 'i') } },
                        { $set: { price: price, name: newProductName, userId: senderId } },
                        { upsert: true }
                    );
                    await msg.reply(`✅ Saved: *${newProductName}* - ₦${price.toLocaleString()}.\n\nAdd another product's name, or type *'done'* to finish.`);
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'adding_product_name' }, $unset: { 'data.newProductName': '' } });
                    break;
                case 'awaiting_format_choice':
                case 'awaiting_initial_format_choice':
                    const formatChoice = text.trim();
                    let format = '';
                    if(formatChoice === '1') format = 'PNG';
                    else if (formatChoice === '2') format = 'PDF';
                    else {
                        await msg.reply("Invalid choice. Please reply with *1* for Image or *2* for Document.");
                        break;
                    }
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { receiptFormat: format } });
                    if(currentState === 'awaiting_initial_format_choice'){
                         const finalUser = await db.collection('users').findOne({ userId: senderId });
                         await generateAndSendFinalReceipt(senderId, finalUser, userSession.data.receiptData, msg);
                    } else {
                        await msg.reply(`✅ Preference saved! Receipts will now be generated as *${format}* files.`);
                        await db.collection('conversations').deleteOne({ userId: senderId });
                    }
                    break;
                case 'awaiting_payment_decision':
                    if (lowerCaseText === 'yes') {
                        await msg.reply("Great! Generating a secure payment account for you now...");
                        const accountDetails = await generateVirtualAccount(user);
                        if (accountDetails && accountDetails.bankName) {
                            const reply = `To get your 6-month subscription for *₦${SUBSCRIPTION_FEE.toLocaleString()}*, please transfer to:\n\n` + `*Bank:* ${accountDetails.bankName}\n` + `*Account Number:* ${accountDetails.accountNumber}\n\n` + `Your access will be unlocked automatically after payment.`;
                            await msg.reply(reply);
                        } else { await msg.reply("Sorry, I couldn't generate a payment account. Please contact support."); }
                    } else if (lowerCaseText === 'no') {
                        await msg.reply("Okay, no problem. Feel free to come back if you change your mind.");
                    } else {
                        await msg.reply("Please reply with just 'Yes' or 'No'.");
                        break;
                    }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                
                // --- ADMIN SETTINGS STATES ---
                case 'awaiting_settings_choice':
                    if (text === '1' && isAdmin) {
                        const settings = await db.collection('settings').findOne({ _id: 'global_settings' });
                        const regStatus = (settings && settings.registrationsOpen === false) ? 'CLOSED' : 'OPEN';
                        const action = regStatus === 'OPEN' ? 'CLOSE' : 'OPEN';
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_registration_toggle', data: { action: action } } });
                        await msg.reply(`Registrations are currently *${regStatus}*. Are you sure you want to *${action}* them? (Yes / No)`);
                    } else {
                        await msg.reply("Invalid selection. Action cancelled.");
                        await db.collection('conversations').deleteOne({ userId: senderId });
                    }
                    break;
                case 'awaiting_registration_toggle':
                    if (lowerCaseText === 'yes' && isAdmin) {
                        const action = userSession.data.action;
                        const newStatus = action === 'CLOSE' ? false : true;
                        await db.collection('settings').updateOne({ _id: 'global_settings' }, { $set: { registrationsOpen: newStatus } }, { upsert: true });
                        await msg.reply(`✅ Success! New user registrations are now *${action}D*.`);
                    } else {
                        await msg.reply("Action cancelled.");
                    }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
            }
        } else {
            // Fallback for existing users who are not in a conversation
            if (user) {
                await sendMessageWithDelay(msg, `Hi ${user.brandName}!\n\nHow can I help you today? Type *'commands'* to see all available options.`);
            }
        }
    } catch (err) {
        console.error("An error occurred in message handler:", err);
        await msg.reply("Sorry, an unexpected error occurred. Please try again or type 'support' to contact an admin.");
    } finally {
        processingUsers.delete(senderId);
    }
});


async function generateAndSendFinalReceipt(senderId, user, receiptData, msg, isResend = false, isEdit = false) {
    const db = getDB();
    if (!isEdit) {
        const message = isResend ? 'Recreating that receipt for you...' : 'Generating your receipt...';
        await sendMessageWithDelay(msg, `✅ Got it! ${message}`);
    }
    const format = user.receiptFormat || 'PNG'; 
    const subtotal = receiptData.prices.reduce((sum, price) => sum + parseFloat(price || 0), 0);
    
    let finalReceiptId = receiptData._id; 
    if (!isResend) {
        if (isEdit) {
            await db.collection('receipts').updateOne({ _id: finalReceiptId }, { 
                $set: { customerName: receiptData.customerName, items: receiptData.items, prices: receiptData.prices.map(p => p.toString()), paymentMethod: receiptData.paymentMethod, totalAmount: subtotal },
                $inc: { editCount: 1 }
            });
        } else {
             const result = await db.collection('receipts').insertOne({
                userId: senderId, createdAt: new Date(), customerName: receiptData.customerName, totalAmount: subtotal, items: receiptData.items,
                prices: receiptData.prices.map(p=>p.toString()), paymentMethod: receiptData.paymentMethod, editCount: 0 
            });
            finalReceiptId = result.insertedId;
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
            throw new Error(`Failed to load receipt page: ${response.status()}`);
        }

        let fileBuffer;
        if (format === 'PDF') {
            fileBuffer = await page.pdf({ printBackground: true, width: '800px' });
            const media = new MessageMedia('application/pdf', fileBuffer.toString('base64'), `SmartReceipt_${receiptData.customerName}.pdf`);
            await client.sendMessage(senderId, media, { caption: `Here is the receipt for ${receiptData.customerName}.` });
        } else {
            await page.setViewport({ width: 800, height: 10, deviceScaleFactor: 2 });
            fileBuffer = await page.screenshot({ fullPage: true, type: 'png' });
            const media = new MessageMedia('image/png', fileBuffer.toString('base64'), 'SmartReceipt.png');
            await client.sendMessage(senderId, media, { caption: `Here is the receipt for ${receiptData.customerName}.` });
        }
        
        if (!isResend && !isEdit) {
            await db.collection('users').updateOne({ userId: senderId }, { $inc: { receiptCount: 1 } });
        }
        await db.collection('conversations').deleteOne({ userId: senderId });

    } catch(err) {
        console.error("Error during receipt generation:", err);
        await msg.reply("Sorry, a technical error occurred while creating the receipt file. Please try again.");
        await db.collection('conversations').deleteOne({ userId: senderId });
    } finally {
        if (page && !page.isClosed()) { await page.close(); }
    }
}

async function startBot() {
    await connectToDB();
    client.initialize();
    app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
}

startBot();
