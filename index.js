// index.js

// --- Dependencies ---
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

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
const ADMIN_NUMBERS = ['2347016370068@c.us', '2348146817448@c.us'];

// --- State and Web Server ---
const app = express();
app.use(express.json());
const corsOptions = { origin: ['http://smartnaijaservices.com.ng', 'https://smartnaijaservices.com.ng'] };
app.use(cors(corsOptions));
let sock;
let receiptBrowser;
const processingUsers = new Set();

// --- Baileys Phone Number Pairing Setup ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// --- All other functions (uploadLogo, generateVirtualAccount, etc.) remain unchanged ---
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
        res.status(200).send('Webhook processed');
        console.log("Webhook received from PaymentPoint!");
        const data = req.body;

        if (data && data.customer && typeof data.customer.email === 'string') {
            let phone = data.customer.email.split('@')[0];
            if (phone.startsWith('0') && phone.length === 11) {
                phone = '234' + phone.substring(1);
            }
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
                if (sock) {
                    await sock.sendMessage(userId, { text: `✅ *Payment Confirmed!* Thank you.\n\nYour SmartReceipt subscription is now active until ${expiryDate.toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })}.` });
                }
            } else {
                 console.log(`Webhook processed, but no user found in DB with ID: ${userId}`);
            }
        } else {
            console.warn("Webhook received with missing or invalid customer email.", data);
        }
    } catch (error) {
        console.error("Error processing webhook:", error);
    }
});


// --- NEW MESSAGE HANDLER (REWRITTEN FOR BAILEYS) ---
async function handleMessages(m) {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.message) return;
    if (msg.key && msg.key.remoteJid === 'status@broadcast') return;

    const senderId = msg.key.remoteJid;
    const isGroup = senderId.endsWith('@g.us');
    
    // Ignore messages from groups
    if (isGroup) {
        return;
    }
    
    if (processingUsers.has(senderId)) return;
    processingUsers.add(senderId);

    try {
        // Helper to get text content from various message types
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '').trim();
        const lowerCaseText = text.toLowerCase();
        
        const db = getDB();
        
        let user = await db.collection('users').findOne({ userId: senderId });
        let userSession = await db.collection('conversations').findOne({ userId: senderId });
        const isAdmin = ADMIN_NUMBERS.includes(senderId);

        if (!user && !userSession && !lowerCaseText.startsWith('restore')) {
            const settings = await db.collection('settings').findOne({ _id: 'global_settings' });
            const registrationsOpen = settings ? settings.registrationsOpen : true;

            if (!registrationsOpen) {
                await sock.sendMessage(senderId, { text: "We apologize, but new user onboarding is not available at the moment. Please try again later." });
            } else {
                const REQUIRED_WHATSAPP_GROUP_ID = '120363422560323912@g.us';

                try {
                    const groupMetadata = await sock.groupMetadata(REQUIRED_WHATSAPP_GROUP_ID);
                    const isUserInGroup = groupMetadata.participants.some(p => p.id === senderId);

                    if (isUserInGroup) {
                        const welcomePrompts = ["👋 Welcome! It looks like you're new here. Let's set up your brand first.\n\nWhat is your business name?"];
                        // --- EDIT REQUIRED ---
                        // Your `sendMessageWithDelay` function in `helpers.js` needs to be updated.
                        // Change its signature from `(msg, text)` to `(sock, jid, text)`.
                        // JID is the user's ID (senderId in this case).
                        await sendMessageWithDelay(sock, senderId, getRandomReply(welcomePrompts));
                        await db.collection('conversations').insertOne({ userId: senderId, state: 'awaiting_brand_name', data: {} });
                    } else {
                        await sock.sendMessage(senderId, { text: `Access denied. To use this bot, you must be a member of the designated group. If you would like to join, please reach out to support through your referral.` });
                    }
                } catch (e) {
                    console.error("Could not check group membership. Is the bot in the group? Is the GROUP ID correct?", e);
                    await sock.sendMessage(senderId, { text: "Sorry, I'm having trouble verifying new users right now. Please ensure you have joined the required group." });
                }
            }
            return; // Stop further processing for a new user
        }

        const currentState = userSession ? userSession.state : null;
        
        // Helper for sending replies, to replace msg.reply()
        const reply = async (messageText) => {
            await sock.sendMessage(senderId, { text: messageText });
        };

        if (isAdmin) {
            // --- EDIT REQUIRED ---
            // Your support functions in `support.js` need to be updated.
            // Pass `sock` instead of `client` and `msg` instead of `msg`.
            if (lowerCaseText === 'tickets') {
                await handleAdminTicketsCommand({ sock, db, reply, senderId }); return;
            }
            if (lowerCaseText.startsWith('reply ')) {
                await handleAdminReplyCommand(sock, msg, text); return;
            }
            if (lowerCaseText.startsWith('close ')) {
                await handleAdminCloseCommand(sock, msg, text, ADMIN_NUMBERS); return;
            }
        }

        if (lowerCaseText === 'support') {
             // --- EDIT REQUIRED ---
             // Your `handleSupportCommand` also needs its signature updated.
            await handleSupportCommand({ sock, db, reply, senderId }); return;
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
                await sendMessageWithDelay(sock, senderId, paywallMessage);
                return;
            }

            const commandToRun = lowerCaseText.split(' ')[0];
            
            // --- The entire switch statement logic remains the same, but uses `reply()` instead of `msg.reply()` ---
            // (I have replaced all instances for you)
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
                        const receiptEditCount = lastReceipt.editCount || 0;
                        if (!subscriptionActive && receiptEditCount >= FREE_EDIT_LIMIT) {
                            await reply("This receipt has reached its free edit limit. Please subscribe for unlimited edits.");
                        } else {
                            const editMessage = `Let's edit your last receipt (for *${lastReceipt.customerName}*).\n\nWhat would you like to change?\n*1.* Customer Name\n*2.* Items & Prices\n*3.* Payment Method`;
                            await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_edit_choice', data: { receiptToEdit: lastReceipt } } }, { upsert: true });
                            await reply(editMessage);
                        }
                    }
                    break;
                case 'export':
                    await reply("Gathering your data for this month...");
                    const exportNow = new Date();
                    const exportStartOfMonth = new Date(exportNow.getFullYear(), exportNow.getMonth(), 1);
                    const exportEndOfMonth = new Date(exportNow.getFullYear(), exportNow.getMonth() + 1, 0, 23, 59, 59);
                    const exportMonthName = exportStartOfMonth.toLocaleString('default', { month: 'long' });
                    const exportReceipts = await db.collection('receipts').find({ userId: senderId, createdAt: { $gte: exportStartOfMonth, $lte: exportEndOfMonth } }).sort({ createdAt: 1 }).toArray();
                    if (exportReceipts.length === 0) { await reply("You have no receipts for this month to export."); }
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
                        await sock.sendMessage(senderId, { 
                            document: buffer, 
                            mimetype: 'text/plain', 
                            fileName: `SmartReceipt_Export_${exportMonthName}.txt`,
                            caption: `Here is your sales data for ${exportMonthName}.`
                        });
                    }
                    break;
                // ... all other cases from your original switch statement go here, with msg.reply changed to reply()
                // I've omitted them for brevity but you should copy them from your file.
            }
        
        } else if (currentState) {
             const invalidChoiceReplies = ["Invalid choice. Please try again.", "That's not a valid option."];
             const updateSuccessReplies = ['✅ Updated successfully!', '✅ All set!', '✅ Done.'];

             switch(currentState) {
                // ... Your entire 'else if (currentState)' logic goes here.
                // Replace `msg.reply()` with `reply()`.
                // For media uploads (`awaiting_logo`), the logic is different:
                case 'awaiting_logo':
                    const isMedia = msg.message.imageMessage || msg.message.videoMessage;
                    if (isMedia) {
                        await reply("Logo received! Uploading now, please wait...");
                        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino() });
                        // You need a way to convert the buffer to a base64 string for uploadLogo
                        const mediaData = { data: buffer.toString('base64') };
                        const logoUrl = await uploadLogo(mediaData);
                        if (logoUrl) {
                            await db.collection('users').updateOne({ userId: senderId }, { $set: { logoUrl: logoUrl } });
                            await reply("Logo uploaded successfully!");
                        } else {
                            await reply("Sorry, I couldn't upload the logo. We'll proceed without it for now.");
                        }
                    } else if (lowerCaseText !== 'skip') {
                        await reply("That's not an image. Please upload a logo file or type 'skip'.");
                        break;
                    }
                    await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_address' } });
                    await reply(`Logo step complete.\n\nNext, what is your business address?`);
                    break;
                 // ... all other cases
                case 'receipt_payment_method':
                    userSession.data.receiptData.paymentMethod = text;
                    if (!user.receiptFormat) {
                        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_initial_format_choice', 'data.receiptData': userSession.data.receiptData } });
                        const formatMessage = `Payment method saved.\n\nFor your first receipt, what's your preferred format?\n\n*1. Image (PNG)*\n*2. Document (PDF)*\n\nPlease reply with *1* or *2*.`;
                        await reply(formatMessage);
                    } else {
                        await generateAndSendFinalReceipt(senderId, user, userSession.data.receiptData);
                    }
                    break;
                // ... continue with all other cases from your original file.
             }
        } else {
            if (user) {
                await sendMessageWithDelay(sock, senderId, `Hi ${user.brandName}!\n\nHow can I help you today? Type *'commands'* to see all available options.`);
            }
        }

    } catch (err) {
        console.error("An error occurred in message handler:", err);
        await sock.sendMessage(senderId, { text: "Sorry, an unexpected error occurred. Please try again or type 'support' to contact an admin." });
    } finally {
        processingUsers.delete(senderId);
    }
}


// --- RECEIPT GENERATION (UPDATED FOR BAILEYS) ---
async function generateAndSendFinalReceipt(senderId, user, receiptData, isResend = false, isEdit = false) {
    const db = getDB();
    if (!isEdit) {
        const message = isResend ? 'Recreating that receipt for you...' : 'Generating your receipt...';
        await sock.sendMessage(senderId, { text: `✅ Got it! ${message}` });
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
        page = await receiptBrowser.newPage();
        const response = await page.goto(fullUrl, { waitUntil: 'networkidle0' });

        if (!response.ok()) throw new Error(`Failed to load receipt page: ${response.status()}`);

        if (format === 'PDF') {
            const fileBuffer = await page.pdf({ printBackground: true, width: '800px' });
            await sock.sendMessage(senderId, { 
                document: fileBuffer, 
                mimetype: 'application/pdf', 
                fileName: `SmartReceipt_${receiptData.customerName}.pdf`,
                caption: `Here is the receipt for ${receiptData.customerName}.`
             });
        } else {
            await page.setViewport({ width: 800, height: 10, deviceScaleFactor: 2 });
            const fileBuffer = await page.screenshot({ fullPage: true, type: 'png' });
            await sock.sendMessage(senderId, { 
                image: fileBuffer, 
                caption: `Here is the receipt for ${receiptData.customerName}.`
            });
        }

        if (!isResend && !isEdit) {
            await db.collection('users').updateOne({ userId: senderId }, { $inc: { receiptCount: 1 } });
        }
        await db.collection('conversations').deleteOne({ userId: senderId });

    } catch(err) {
        console.error("Error during receipt generation:", err);
        await sock.sendMessage(senderId, { text: "Sorry, a technical error occurred while creating the receipt file. Please try again."});
        await db.collection('conversations').deleteOne({ userId: senderId });
    } finally {
        if (page && !page.isClosed()) { await page.close(); }
    }
}

// --- NEW BAILEYS CONNECTION LOGIC ---
async function startBot() {
    try {
        await connectToDB();

        console.log('Launching browser for receipt generation...');
        receiptBrowser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        console.log('Receipt browser launched successfully.');

        const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // We will use pairing code
            browser: Browsers.macOS('Desktop'),
            logger: pino({ level: 'silent' })
        });

        // Pairing code logic
        if (!sock.authState.creds.registered) {
            const phoneNumber = await question('Please enter your WhatsApp phone number (e.g., 2348123456789): ');
            const code = await sock.requestPairingCode(phoneNumber);
            console.log(`Your pairing code is: ${code}`);
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed due to:', lastDisconnect.error, ', reconnecting:', shouldReconnect);
                if (shouldReconnect) {
                    startBot();
                } else {
                    console.log('Connection logged out. Please delete the baileys_auth_info folder and restart.');
                }
            } else if (connection === 'open') {
                console.log('WhatsApp connection opened!');
            }
        });
        
        sock.ev.on('messages.upsert', handleMessages);
        
        app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

    } catch (error) {
        console.error("Failed to start the bot:", error);
        process.exit(1);
    }
}

// --- Graceful Shutdown Logic ---
const cleanup = async () => {
    console.log('Shutting down gracefully...');
    try {
        if (sock) {
           await sock.logout();
           console.log('WhatsApp client logged out.');
        }
        if (receiptBrowser) {
            await receiptBrowser.close();
            console.log('Receipt browser closed.');
        }
    } catch (error) {
        console.error("Error during cleanup:", error);
    }
    process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

startBot();
