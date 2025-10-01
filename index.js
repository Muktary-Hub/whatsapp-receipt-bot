// index.js (FINAL & COMPLETE - MIGRATED TO WHATSAPP CLOUD API)

// --- Dependencies ---
import pino from 'pino';
import axios from 'axios';
import FormData from 'form-data';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import puppeteer from 'puppeteer';

// --- Local Modules ---
import { connectToDB, getDB, ObjectId } from './db.js';
import { sendMessageWithDelay, getRandomReply, isSubscriptionActive } from './helpers.js';

// --- Configuration ---
const PP_API_KEY = process.env.PP_API_KEY;
const PP_SECRET_KEY = process.env.PP_SECRET_KEY;
const PP_BUSINESS_ID = process.env.PP_BUSINESS_ID;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const RECEIPT_BASE_URL = process.env.RECEIPT_BASE_URL;
const PORT = process.env.PORT || 3000;
const ADMIN_NUMBERS = ['2347016370068', '2348146817448']; // NOTE: No "@c.us" for Cloud API
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// --- State and Web Server ---
const app = express();
app.use(express.json());
const corsOptions = { origin: ['http://smartnaijaservices.com.ng', 'https://smartnaijaservices.com.ng'] };
app.use(cors(corsOptions));
let receiptBrowser;
const processingUsers = new Set();

// --- NEW WHATSAPP CLOUD API HELPER FUNCTIONS ---

async function sendMessage(recipientPhoneNumber, messageText) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: recipientPhoneNumber, text: { body: messageText } },
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (error) {
    console.error("Error sending text message:", error.response?.data || error.message);
  }
}

async function uploadWhatsAppMedia(buffer, mimeType) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', buffer, { contentType: mimeType, filename: 'upload.file' });

    try {
        const response = await axios.post(
            `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/media`,
            form,
            { headers: { ...form.getHeaders(), 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
        );
        return response.data.id;
    } catch (error) {
        console.error('Error uploading media to WhatsApp:', error.response?.data || error.message);
        return null;
    }
}

async function sendMediaMessage(recipientPhoneNumber, buffer, mimeType, caption = '', fileName = '') {
    const mediaId = await uploadWhatsAppMedia(buffer, mimeType);
    if (!mediaId) {
        await sendMessage(recipientPhoneNumber, "Sorry, there was an error sending the file. Please try again.");
        return;
    }

    let messageBody = {};
    if (mimeType.startsWith('image/')) {
        messageBody = { type: 'image', image: { id: mediaId, caption: caption } };
    } else {
        messageBody = { type: 'document', document: { id: mediaId, caption: caption, filename: fileName } };
    }

    try {
        await axios.post(
            `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', to: recipientPhoneNumber, ...messageBody },
            { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
        );
    } catch (error) {
        console.error('Error sending media message:', error.response?.data || error.message);
    }
}

async function downloadCloudApiMedia(mediaId) {
    try {
        const urlResponse = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
        const mediaUrl = urlResponse.data.url;
        const downloadResponse = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        return Buffer.from(downloadResponse.data, 'binary');
    } catch (error) {
        console.error("Failed to download media:", error.response ? error.response.data : error.message);
        return null;
    }
}

// --- EXISTING HELPER FUNCTIONS ---
function parseInputList(text) {
    const normalizedText = text.replace(/\n/g, ',');
    return normalizedText.split(',').map(part => part.trim()).filter(part => part.length > 0);
}

const SUBSCRIPTION_FEE = 2000;
const FREE_TRIAL_LIMIT = 2;
const FREE_EDIT_LIMIT = 1;

async function uploadLogo(mediaBuffer) {
    try {
        const form = new FormData();
        form.append('image', mediaBuffer, { filename: 'logo.png' });
        const response = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form, { headers: form.getHeaders() });
        return response.data.data.display_url;
    } catch (error) {
        console.error("ImgBB upload failed:", error.response ? error.response.data : error.message);
        return null;
    }
}

function formatPhoneNumberForApi(whatsappId) {
    let number = whatsappId.replace(/\D/g, '');
    if (number.startsWith('234')) return '0' + number.substring(3);
    return "INVALID_PHONE_FORMAT";
}

async function generateVirtualAccount(user) {
    const formattedPhone = formatPhoneNumberForApi(user.userId);
    if (formattedPhone === "INVALID_PHONE_FORMAT") return null;
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
        console.error("PAYMENTPOINT API ERROR:", error.response?.data || error.message);
        return null;
    }
}

// --- WEBHOOK ENDPOINTS ---
app.get('/', (req, res) => res.status(200).send('SmartReceipt Bot Webhook Server is running.'));

app.post('/payment-webhook', async (req, res) => {
    res.status(200).send('Webhook processed');
    const db = getDB();
    try {
        const data = req.body;
        if (data?.customer?.email) {
            let phone = data.customer.email.split('@')[0];
            if (phone.startsWith('0') && phone.length === 11) phone = '234' + phone.substring(1);
            const userId = phone;
            const expiryDate = new Date();
            expiryDate.setMonth(expiryDate.getMonth() + 6);
            const result = await db.collection('users').updateOne({ userId: userId }, { $set: { isPaid: true, subscriptionExpiryDate: expiryDate } });
            if (result.modifiedCount > 0) {
                const successMessage = `✅ *Payment Confirmed!* Thank you.\n\nYour SmartReceipt subscription is now active until ${expiryDate.toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })}`;
                await sendMessage(userId, successMessage);
            }
        }
    } catch (error) { console.error("Error in payment webhook:", error); }
});

app.get("/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
        res.status(200).send(req.query["hub.challenge"]);
    } else { res.sendStatus(403); }
});

app.post("/webhook", async (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    if (body.object === "whatsapp_business_account" && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        await processIncomingMessage(body.entry[0].changes[0].value.messages[0]);
    }
});

// --- REWRITTEN RECEIPT GENERATION & SENDING ---
async function generateAndSendFinalReceipt(senderId, user, receiptData, isResend = false, isEdit = false) {
    const db = getDB();
    if (!isEdit) {
        await sendMessage(senderId, isResend ? 'Recreating that receipt for you...' : 'Generating your receipt...');
    }
    const format = user.receiptFormat || 'PNG';
    const subtotal = receiptData.prices.reduce((sum, price) => sum + parseFloat(price || 0), 0);

    let finalReceiptId = receiptData._id ? new ObjectId(receiptData._id) : null;
    if (!isResend) {
        if (isEdit && finalReceiptId) {
            await db.collection('receipts').updateOne({ _id: finalReceiptId }, {
                $set: { customerName: receiptData.customerName, items: receiptData.items, prices: receiptData.prices.map(p => p.toString()), paymentMethod: receiptData.paymentMethod, totalAmount: subtotal },
                $inc: { editCount: 1 }
            });
        } else {
            const result = await db.collection('receipts').insertOne({
                userId: senderId, createdAt: new Date(), customerName: receiptData.customerName, totalAmount: subtotal, items: receiptData.items,
                prices: receiptData.prices.map(p => p.toString()), paymentMethod: receiptData.paymentMethod, editCount: 0
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
        page = await receiptBrowser.newPage();
        await page.goto(fullUrl, { waitUntil: 'networkidle0' });

        const caption = `Here is the receipt for ${receiptData.customerName}.`;
        if (format === 'PDF') {
            const fileBuffer = await page.pdf({ printBackground: true, width: '800px' });
            await sendMediaMessage(senderId, fileBuffer, 'application/pdf', caption, `SmartReceipt_${receiptData.customerName}.pdf`);
        } else {
            await page.setViewport({ width: 800, height: 10, deviceScaleFactor: 2 });
            const fileBuffer = await page.screenshot({ fullPage: true, type: 'png' });
            await sendMediaMessage(senderId, fileBuffer, 'image/png', caption);
        }

        if (!isResend && !isEdit) {
            await db.collection('users').updateOne({ userId: senderId }, { $inc: { receiptCount: 1 } });
        }
        await db.collection('conversations').deleteOne({ userId: senderId });

    } catch (err) {
        console.error("Error during receipt generation:", err);
        await sendMessage(senderId, "Sorry, a technical error occurred while creating the receipt file.");
        await db.collection('conversations').deleteOne({ userId: senderId });
    } finally {
        if (page && !page.isClosed()) await page.close();
    }
}


// --- MAIN BOT LOGIC ---
async function processIncomingMessage(msg) {
    const senderId = msg.from;
    const msgType = msg.type;
    let text = '', mediaId = null;

    if (msgType === 'text') { text = msg.text.body.trim(); }
    else if (msgType === 'image') { text = msg.image.caption ? msg.image.caption.trim() : ''; mediaId = msg.image.id; }
    else if (msgType === 'video') { text = msg.video.caption ? msg.video.caption.trim() : ''; }
    else { return; }

    if (processingUsers.has(senderId)) return;
    processingUsers.add(senderId);

    try {
        const lowerCaseText = text.toLowerCase();
        const db = getDB();
        
        let user = await db.collection('users').findOne({ userId: senderId });
        let userSession = await db.collection('conversations').findOne({ userId: senderId });
        const isAdmin = ADMIN_NUMBERS.includes(senderId);

        const reply = (messageText) => sendMessage(senderId, messageText);

        if (!user && !userSession && !lowerCaseText.startsWith('restore')) {
            await reply("👋 Welcome! It looks like you're new here. Let's set up your brand first.\n\nWhat is your business name?");
            await db.collection('conversations').insertOne({ userId: senderId, state: 'awaiting_brand_name', data: {} });
            processingUsers.delete(senderId);
            return;
        }

        const currentState = userSession ? userSession.state : null;
        
        // IMPORTANT: Support and Admin commands require rewriting support.js. They are temporarily disabled.
        if (isAdmin && (lowerCaseText === 'tickets' || lowerCaseText.startsWith('reply ') || lowerCaseText.startsWith('close '))) {
            await reply("Admin commands for the support system are under maintenance during this upgrade. Please manage tickets directly for now.");
            processingUsers.delete(senderId);
            return;
        }
        if (lowerCaseText === 'support') {
            await reply("The support ticket system is currently under maintenance as we upgrade our systems. Please try again later.");
            processingUsers.delete(senderId);
            return;
        }

        const commands = ['new receipt', 'changereceipt', 'stats', 'history', 'edit', 'export', 'add product', 'products', 'format', 'mybrand', 'cancel', 'commands', 'backup', 'restore', 'settings'];
        const isCommand = commands.includes(lowerCaseText) || lowerCaseText.startsWith('remove product') || lowerCaseText.startsWith('restore');

        if (isCommand) {
            if (currentState) {
                await db.collection('conversations').deleteOne({ userId: senderId });
                userSession = null;
            }

            const subscriptionActive = isSubscriptionActive(user, ADMIN_NUMBERS);
            if (!subscriptionActive && ['new receipt', 'edit', 'export'].includes(lowerCaseText) && user?.receiptCount >= FREE_TRIAL_LIMIT) {
                await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_payment_decision' } }, { upsert: true });
                const paywallMessage = `Dear *${user.brandName}*,\n\nYou have reached your limit of ${FREE_TRIAL_LIMIT} free receipts. To unlock unlimited access, please subscribe for just *₦${SUBSCRIPTION_FEE.toLocaleString()} for 6 months*.\n\n(Please reply *Yes* or *No*)`;
                await reply(paywallMessage);
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
                        await reply(settingsMessage);
                    }
                    break;
                case 'new':
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'receipt_customer_name', data: { receiptData: {} } } }, { upsert: true });
                    await reply('🧾 *New Receipt Started*\n\nWho is the customer?');
                    break;
                case 'edit':
                    const lastReceipt = await db.collection('receipts').findOne({ userId: senderId }, { sort: { createdAt: -1 } });
                    if (!lastReceipt) {
                        await reply("You don't have any recent receipts to edit.");
                    } else {
                        if (!subscriptionActive && (lastReceipt.editCount || 0) >= FREE_EDIT_LIMIT) {
                            await reply("This receipt has reached its free edit limit. Please subscribe for unlimited edits.");
                        } else {
                            const editMessage = `Let's edit your last receipt (for *${lastReceipt.customerName}*).\n\nWhat would you like to change?\n*1.* Customer Name\n*2.* Items & Prices\n*3.* Payment Method`;
                            await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_edit_choice', data: { receiptToEdit: lastReceipt } } }, { upsert: true });
                            await reply(editMessage);
                        }
                    }
                    break;
                case 'history':
                    const recentReceipts = await db.collection('receipts').find({ userId: senderId }).sort({ createdAt: -1 }).limit(5).toArray();
                    if (recentReceipts.length === 0) { await reply("You haven't generated any receipts yet."); }
                    else {
                        let historyMessage = "🧾 *Your 5 Most Recent Receipts:*\n\n";
                        recentReceipts.forEach((r, i) => { historyMessage += `*${i + 1}.* For *${r.customerName}* - ₦${r.totalAmount.toLocaleString()}\n`; });
                        historyMessage += "\nTo resend a receipt, just reply with its number (1-5).";
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_history_choice', data: { history: recentReceipts } } }, { upsert: true });
                        await reply(historyMessage);
                    }
                    break;
                case 'stats':
                    const now = new Date(); const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                    const receipts = await db.collection('receipts').find({ userId: senderId, createdAt: { $gte: startOfMonth } }).toArray();
                    const totalSales = receipts.reduce((sum, r) => sum + r.totalAmount, 0);
                    let statsMessage = `📊 *Your Stats for ${startOfMonth.toLocaleString('default', { month: 'long' })}*\n\n*Receipts Generated:* ${receipts.length}\n*Total Sales:* ₦${totalSales.toLocaleString()}`;
                    await reply(statsMessage);
                    break;
                case 'export':
                    await reply("Gathering your data for this month...");
                    const exportNow = new Date(); const exportStartOfMonth = new Date(exportNow.getFullYear(), exportNow.getMonth(), 1);
                    const exportMonthName = exportStartOfMonth.toLocaleString('default', { month: 'long' });
                    const exportReceipts = await db.collection('receipts').find({ userId: senderId, createdAt: { $gte: exportStartOfMonth } }).sort({ createdAt: 1 }).toArray();
                    if (exportReceipts.length === 0) { await reply("You have no receipts for this month to export."); }
                    else {
                        let fileContent = `SmartReceipt - Sales Report for ${exportMonthName} ${exportNow.getFullYear()}\nBrand: ${user.brandName}\n----------------------------------------\n\n`;
                        let totalSales = 0;
                        exportReceipts.forEach(r => {
                            fileContent += `Date: ${r.createdAt.toLocaleDateString('en-NG')}\nCustomer: ${r.customerName}\n`;
                            r.items.forEach((item, i) => { fileContent += `  - ${item}: ₦${parseFloat(r.prices[i] || 0).toLocaleString()}\n`; });
                            fileContent += `Total: ₦${r.totalAmount.toLocaleString()}\n--------------------\n`;
                            totalSales += r.totalAmount;
                        });
                        fileContent += `\nGRAND TOTAL FOR ${exportMonthName.toUpperCase()}: ₦${totalSales.toLocaleString()}`;
                        const buffer = Buffer.from(fileContent, 'utf-8');
                        await sendMediaMessage(senderId, buffer, 'text/plain', `Here is your sales data for ${exportMonthName}.`, `SmartReceipt_Export_${exportMonthName}.txt`);
                    }
                    break;
                case 'products':
                    const products = await db.collection('products').find({ userId: senderId }).sort({name: 1}).toArray();
                    if(products.length === 0) { await reply("You haven't added any products. Use `add product` to start."); }
                    else {
                        let productList = "📦 *Your Product Catalog*\n\n";
                        products.forEach(p => { productList += `*${p.name}* - ₦${p.price.toLocaleString()}\n`; });
                        await reply(productList);
                    }
                    break;
                case 'add':
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'adding_product_name' } }, { upsert: true });
                    await reply("Let's add a new product. What is the product's name?");
                    break;
                case 'remove':
                    const productName = text.substring('remove product'.length).trim().replace(/"/g, '');
                    if(productName) {
                        const result = await db.collection('products').deleteOne({ userId: senderId, name: { $regex: new RegExp(`^${productName}$`, 'i') } });
                        if(result.deletedCount > 0) { await reply(`🗑️ Product "*${productName}*" has been removed.`); }
                        else { await reply(`Could not find a product named "*${productName}*". Check spelling and capitalization.`); }
                    } else { await reply('Invalid format. Please use: `remove product "Product Name"`'); }
                    break;
                case 'mybrand':
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_mybrand_choice' } }, { upsert: true });
                    await reply(`*Your Brand Settings*\n\nWhat would you like to update?\n*1.* Brand Name\n*2.* Brand Color\n*3.* Logo\n*4.* Address\n*5.* Contact Info`);
                    break;
                case 'format':
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_format_choice' } }, { upsert: true });
                    await reply(`What format would you like your receipts in?\n\n*1.* Image (PNG) - _Good for sharing_\n*2.* Document (PDF) - _Best for printing & official records_`);
                    break;
                case 'changereceipt':
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_template_choice' } }, { upsert: true });
                    await reply("Please choose your new receipt template (1-6).");
                    break;
                case 'backup':
                    if (!user || !user.onboardingComplete) { await reply("You must complete your setup before you can create a backup."); }
                    else {
                        let backupCode = user.backupCode || crypto.randomBytes(4).toString('hex').toUpperCase();
                        await db.collection('users').updateOne({ userId: senderId }, { $set: { backupCode: backupCode } });
                        await reply(`🔒 *Your Account Backup Code*\n\nYour unique recovery code: *${backupCode}*\n\nKeep this code safe! If you change your WhatsApp number, use the \`restore\` command on the new number.`);
                    }
                    break;
                case 'restore':
                    const code = text.split(' ')[1];
                    if (!code) { await reply("Please provide a backup code. Example: `restore A1B2C3D4`"); }
                    else {
                        const userToRestore = await db.collection('users').findOne({ backupCode: code.toUpperCase() });
                        if (!userToRestore) { await reply("Sorry, that backup code is not valid."); }
                        else if (userToRestore.userId === senderId) { await reply("This account is already linked to that backup code."); }
                        else {
                            await db.collection('users').deleteOne({ userId: senderId });
                            await db.collection('users').updateOne({ _id: new ObjectId(userToRestore._id) }, { $set: { userId: senderId } });
                            await reply(`✅ *Account Restored!* Welcome back, ${userToRestore.brandName}. All your data has been transferred.`);
                        }
                    }
                    break;
                case 'commands':
                    await reply("Here are the available commands:\n\n*new receipt*\n*edit*\n*history*\n*stats*\n*export*\n\n*products*\n*add product*\n*remove product \"Name\"*\n\n*mybrand*\n*changereceipt*\n*format*\n*backup*\n*restore [code]*\n\n*cancel* - Stop any current action.");
                    break;
                case 'cancel':
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await reply("Action cancelled.");
                    break;
            }

        } else if (currentState) {
            const updateSuccessReplies = ['✅ Updated successfully!', '✅ All set!', '✅ Done.'];

            switch (currentState) {
                // ONBOARDING
                case 'awaiting_brand_name':
                    await db.collection('users').insertOne({ userId: senderId, brandName: text, onboardingComplete: false, receiptCount: 0, isPaid: false, createdAt: new Date() });
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_brand_color' } });
                    await reply(`Great! Your brand is "${text}".\n\nWhat's your brand's main color? (e.g., #1D4ED8 or "blue")`);
                    break;
                case 'awaiting_brand_color':
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { brandColor: text } });
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_logo' } });
                    await reply(`Color saved!\n\nNow, please upload your business logo. If you don't have one, just type *'skip'*.`);
                    break;
                case 'awaiting_logo':
                    if (mediaId && msgType === 'image') {
                        await reply("Logo received! Uploading now, please wait...");
                        const buffer = await downloadCloudApiMedia(mediaId);
                        if (buffer) {
                            const logoUrl = await uploadLogo(buffer);
                            if (logoUrl) {
                                await db.collection('users').updateOne({ userId: senderId }, { $set: { logoUrl: logoUrl } });
                                await reply("Logo uploaded successfully!");
                            } else { await reply("Sorry, I couldn't upload the logo."); }
                        } else { await reply("Sorry, there was an error downloading your logo."); }
                    } else if (lowerCaseText !== 'skip') {
                        await reply("That's not an image. Please upload a logo file or type 'skip'.");
                        processingUsers.delete(senderId); return;
                    }
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_address' } });
                    await reply(`Logo step complete.\n\nNext, what is your business address?`);
                    break;
                case 'awaiting_address':
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { address: text } });
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_contact_info' } });
                    await reply(`Address saved.\n\nFinally, what contact info should be on the receipt? (e.g., a phone number or email)`);
                    break;
                case 'awaiting_contact_info':
                    const emailMatch = text.match(/\S+@\S+\.\S+/);
                    const contactEmail = emailMatch ? emailMatch[0] : null;
                    const contactPhone = text.replace(contactEmail || '', '').trim().match(/(\+)?\d+/) ? text.replace(contactEmail || '', '').trim() : null;
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { contactInfo: text, contactEmail, contactPhone, onboardingComplete: true } });
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await reply(`✅ *Setup Complete!* Your brand profile is all set.\n\nTo create your first receipt, just type:\n*'new receipt'*`);
                    break;

                // RECEIPT CREATION
                case 'receipt_customer_name':
                    const hasProducts = await db.collection('products').countDocuments({ userId: senderId }) > 0;
                    const prompt = hasProducts ? `Customer: *${text}*\n\nNow, add items. You can use your catalog (e.g., _Fanta x2_) or type items manually.\n\n*(Separate with commas or new lines)*` : `Customer: *${text}*\n\nWhat item(s) did they purchase?\n\n*(Separate with commas or new lines)*`;
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'receipt_items', 'data.receiptData.customerName': text } });
                    await reply(prompt);
                    break;
                case 'receipt_items':
                    const items = [], prices = [], manualItems = [];
                    for (const part of parseInputList(text)) {
                        const quickAddMatch = /(.+)\s+x(\d+)/i.exec(part.trim());
                        if (quickAddMatch) {
                            const product = await db.collection('products').findOne({ userId: senderId, name: { $regex: new RegExp(`^${quickAddMatch[1].trim()}$`, 'i') } });
                            if (product) {
                                for (let i = 0; i < parseInt(quickAddMatch[2], 10); i++) { items.push(product.name); prices.push(product.price); }
                            } else { manualItems.push(part.trim()); }
                        } else if (part.trim()) { manualItems.push(part.trim()); }
                    }
                    if (manualItems.length > 0) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'receipt_manual_prices', 'data.receiptData.manualItems': manualItems, 'data.receiptData.quickAddItems': items, 'data.receiptData.quickAddPrices': prices }});
                        await reply(`Catalog items added. Now, please enter the prices for your manual items, *each on a new line or separated by commas*:\n\n*${manualItems.join('\n')}*`);
                    } else {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'receipt_payment_method', 'data.receiptData.items': items, 'data.receiptData.prices': prices.map(p => p.toString()) }});
                        await reply(`Items and prices added from your catalog.\n\nWhat was the payment method?`);
                    }
                    break;
                case 'receipt_manual_prices':
                    const manualPrices = parseInputList(text);
                    if(manualPrices.length !== userSession.data.receiptData.manualItems.length) {
                        await reply("The number of prices does not match the number of manual items. Please try again.");
                        break;
                    }
                    const finalItems = [...(userSession.data.receiptData.quickAddItems || []), ...(userSession.data.receiptData.manualItems || [])];
                    const finalPrices = [...(userSession.data.receiptData.quickAddPrices || []), ...manualPrices].map(p => p.toString());
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'receipt_payment_method', 'data.receiptData.items': finalItems, 'data.receiptData.prices': finalPrices }});
                    await reply(`Prices saved.\n\nWhat was the payment method?`);
                    break;
                case 'receipt_payment_method':
                    userSession.data.receiptData.paymentMethod = text;
                    if (!user.receiptFormat) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_initial_format_choice', 'data.receiptData': userSession.data.receiptData } });
                        await reply(`Payment method saved.\n\nFor your first receipt, what's your preferred format?\n\n*1. Image (PNG)*\n*2. Document (PDF)*\n\nPlease reply with *1* or *2*.`);
                    } else {
                        await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptData);
                    }
                    break;

                // EDITING
                case 'awaiting_edit_choice':
                    const editChoice = parseInt(text, 10);
                    if (editChoice === 1) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'editing_customer_name' } });
                        await reply('What is the new customer name?');
                    } else if (editChoice === 2) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'editing_items' } });
                        await reply('Please re-enter all items, *separated by commas or on new lines*.');
                    } else if (editChoice === 3) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'editing_payment_method' } });
                        await reply('What is the new payment method?');
                    } else { await reply("Invalid choice. Please try again."); }
                    break;
                case 'editing_customer_name':
                    userSession.data.receiptToEdit.customerName = text;
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptToEdit, false, true);
                    break;
                case 'editing_items':
                    userSession.data.receiptToEdit.items = parseInputList(text);
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'editing_prices' } });
                    await reply("Items updated. Now, please re-enter all prices in the correct order.");
                    break;
                case 'editing_prices':
                    userSession.data.receiptToEdit.prices = parseInputList(text);
                    if (userSession.data.receiptToEdit.items.length !== userSession.data.receiptToEdit.prices.length) {
                        await reply("The number of items and prices don't match. Action cancelled.");
                        await db.collection('conversations').deleteOne({ userId: senderId });
                        break;
                    }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptToEdit, false, true);
                    break;
                case 'editing_payment_method':
                    userSession.data.receiptToEdit.paymentMethod = text;
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptToEdit, false, true);
                    break;

                // MYBRAND
                case 'awaiting_mybrand_choice':
                    const choice = parseInt(text, 10);
                    const states = { 1: 'updating_brand_name', 2: 'updating_brand_color', 3: 'updating_logo', 4: 'updating_address', 5: 'updating_contact_info' };
                    const prompts = { 1: 'What is your new brand name?', 2: 'What is your new brand color?', 3: 'Please upload your new logo.', 4: 'What is your new address?', 5: 'What is your new contact info?' };
                    if (states[choice]) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: states[choice] } });
                        await reply(prompts[choice]);
                    } else { await reply("Invalid choice. Please try again."); }
                    break;
                case 'updating_brand_name':
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { brandName: text } });
                    await reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                case 'updating_brand_color':
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { brandColor: text } });
                    await reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                case 'updating_logo':
                    if (mediaId && msgType === 'image') {
                        await reply("New logo received! Uploading...");
                        const buffer = await downloadCloudApiMedia(mediaId);
                        if(buffer) {
                            const logoUrl = await uploadLogo(buffer);
                            await db.collection('users').updateOne({ userId: senderId }, { $set: { logoUrl: logoUrl } });
                            await reply("✅ Logo updated successfully!");
                        } else { await reply("Sorry, the logo upload failed."); }
                    } else { await reply("That's not an image. Please upload a logo file."); }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                case 'updating_address':
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { address: text } });
                    await reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                case 'updating_contact_info':
                    const emailMatchUpdate = text.match(/\S+@\S+\.\S+/);
                    const contactEmailUpdate = emailMatchUpdate ? emailMatchUpdate[0] : null;
                    const phoneTextUpdate = text.replace(contactEmailUpdate || '', '').trim();
                    const contactPhoneUpdate = phoneTextUpdate.match(/(\+)?\d+/) ? phoneTextUpdate : null;
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { contactInfo: text, contactEmail: contactEmailUpdate, contactPhone: contactPhoneUpdate } });
                    await reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;

                // OTHER
                case 'awaiting_history_choice':
                    const historyChoice = parseInt(text, 10);
                    if (historyChoice >= 1 && historyChoice <= userSession.data.history.length) {
                        await generateAndSendFinalReceipt(senderId, user, userSession.data.history[historyChoice - 1], true);
                    } else { await reply("Invalid number. Action cancelled."); }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                case 'awaiting_template_choice':
                    const templateChoice = parseInt(text, 10);
                    if (templateChoice >= 1 && templateChoice <= 6) {
                        await db.collection('users').updateOne({ userId: senderId }, { $set: { preferredTemplate: templateChoice } });
                        await reply(`✅ Template #${templateChoice} is now your default.`);
                    } else { await reply("Invalid selection. Please send a number between 1 and 6."); }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;
                case 'adding_product_name':
                    if (lowerCaseText === 'done') {
                        await reply("Great! Your products have been saved.");
                        await db.collection('conversations').deleteOne({ userId: senderId });
                        break;
                    }
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'adding_product_price', 'data.newProductName': text } });
                    await reply(`Got it. What's the price for *${text}*?`);
                    break;
                case 'adding_product_price':
                    const price = parseFloat(text.trim().replace(/,/g, ''));
                    if (isNaN(price)) { await reply("That's not a valid price. Please send only a number."); break; }
                    const newProductName = userSession.data.newProductName;
                    await db.collection('products').updateOne({ userId: senderId, name: { $regex: new RegExp(`^${newProductName}$`, 'i') } }, { $set: { price: price, name: newProductName, userId: senderId } }, { upsert: true });
                    await reply(`✅ Saved: *${newProductName}* - ₦${price.toLocaleString()}.\n\nAdd another product's name, or type *'done'* to finish.`);
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'adding_product_name' }, $unset: { 'data.newProductName': '' } });
                    break;
                case 'awaiting_format_choice':
                case 'awaiting_initial_format_choice':
                    let format = '';
                    if(text.trim() === '1') format = 'PNG';
                    else if (text.trim() === '2') format = 'PDF';
                    else { await reply("Invalid choice. Please reply with *1* for Image or *2* for Document."); break; }
                    await db.collection('users').updateOne({ userId: senderId }, { $set: { receiptFormat: format } });
                    if(currentState === 'awaiting_initial_format_choice'){
                        const finalUser = await db.collection('users').findOne({ userId: senderId });
                        await generateAndSendFinalReceipt(senderId, finalUser, userSession.data.receiptData);
                    } else {
                        await reply(`✅ Preference saved! Receipts will now be generated as *${format}* files.`);
                        await db.collection('conversations').deleteOne({ userId: senderId });
                    }
                    break;
                case 'awaiting_payment_decision':
                    if (lowerCaseText === 'yes') {
                        await reply("Great! Generating a secure payment account for you now...");
                        const accountDetails = await generateVirtualAccount(user);
                        if (accountDetails?.bankName) {
                            await reply(`To get your 6-month subscription for *₦${SUBSCRIPTION_FEE.toLocaleString()}*, please transfer to:\n\n*Bank:* ${accountDetails.bankName}\n*Account Number:* ${accountDetails.accountNumber}\n\nYour access will be unlocked automatically after payment.`);
                        } else { await reply("Sorry, I couldn't generate a payment account. Please contact support."); }
                    } else if (lowerCaseText === 'no') {
                        await reply("Okay, no problem. Feel free to come back if you change your mind.");
                    } else { await reply("Please reply with just 'Yes' or 'No'."); }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;

                // ADMIN SETTINGS
                case 'awaiting_settings_choice':
                    if (text === '1' && isAdmin) {
                        const settings = await db.collection('settings').findOne({ _id: 'global_settings' });
                        const regStatus = (settings?.registrationsOpen === false) ? 'CLOSED' : 'OPEN';
                        const action = regStatus === 'OPEN' ? 'CLOSE' : 'OPEN';
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_registration_toggle', data: { action: action } } });
                        await reply(`Registrations are currently *${regStatus}*. Are you sure you want to *${action}* them? (Yes / No)`);
                    } else {
                        await reply("Invalid selection. Action cancelled.");
                        await db.collection('conversations').deleteOne({ userId: senderId });
                    }
                    break;
                case 'awaiting_registration_toggle':
                    if (lowerCaseText === 'yes' && isAdmin) {
                        const action = userSession.data.action;
                        const newStatus = action === 'CLOSE' ? false : true;
                        await db.collection('settings').updateOne({ _id: 'global_settings' }, { $set: { registrationsOpen: newStatus } }, { upsert: true });
                        await reply(`✅ Success! New user registrations are now *${action}D*.`);
                    } else { await reply("Action cancelled."); }
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    break;

                default:
                    await db.collection('conversations').deleteOne({ userId: senderId });
                    await reply("Sorry, I got confused. Your previous action has been cancelled. Please try again.");
                    break;
            }
        } else {
            if (user) {
                await sendMessageWithDelay({ sendMessage: reply }, senderId, `Hi ${user.brandName}!\n\nHow can I help you today? Type *'commands'* to see all available options.`);
            }
        }
    } catch (err) {
        console.error("Error in processIncomingMessage:", err);
        await sendMessage(senderId, "Sorry, an unexpected error occurred.");
    } finally {
        processingUsers.delete(senderId);
    }
}


// --- SERVER STARTUP ---
async function startServer() {
    await connectToDB();
    console.log('Launching browser for receipt generation...');
    receiptBrowser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    console.log('Receipt browser launched successfully.');
    app.listen(PORT, () => console.log(`Webhook server is listening on port ${PORT}`));
}

startServer();
