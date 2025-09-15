// messageHandler.js

const { getDB, ObjectId } = require('./db.js');
const { generateAndSendReceipt } = require('./receiptGenerator.js');
const { parseInputList, uploadLogo } = require('./utils.js'); 
const { isSubscriptionActive, getRandomReply } = require('./helpers.js');
const { handleSupportCommand, handleNewTicket, handleTicketResponse, handleAdminTicketsCommand, handleAdminReplyCommand, handleAdminCloseCommand } = require('./support.js');
const crypto = require('crypto');
const axios = require('axios');

const commands = ['new receipt', 'changereceipt', 'stats', 'history', 'edit', 'export', 'add product', 'products', 'format', 'mybrand', 'cancel', 'commands', 'support', 'backup', 'restore'];
const premiumCommands = ['new receipt', 'edit', 'export'];
const ADMIN_WHATSAPP_IDS = ['2347016370067@c.us', '2348146817448@c.us'];
const ADMIN_TELEGRAM_IDS = [];
const SUBSCRIPTION_FEE = 2000;
const FREE_TRIAL_LIMIT = 2;
const FREE_EDIT_LIMIT = 2;
const processingUsers = new Set();

async function generateVirtualAccount(user, msg) {
    if (!user.userId) {
        await msg.reply("Sorry, automatic payment account generation is only available for WhatsApp users at this time.");
        return null;
    }
    const formatPhoneNumberForApi = (whatsappId) => {
        let number = whatsappId.split('@')[0].replace(/\D/g, '');
        if (number.startsWith('234') && number.length === 13) return '0' + number.substring(3);
        if (number.length === 10 && !number.startsWith('0')) return '0' + number;
        if (number.length === 11 && number.startsWith('0')) return number;
        return "INVALID_PHONE_FORMAT"; 
    };
    const formattedPhone = formatPhoneNumberForApi(user.userId);
    if (formattedPhone === "INVALID_PHONE_FORMAT") { 
        console.error(`Could not format phone number for user: ${user.userId}`); 
        return null; 
    }
    const options = {
        method: 'POST', url: 'https://api.paymentpoint.co/api/v1/createVirtualAccount',
        headers: { 'Content-Type': 'application/json', 'api-key': process.env.PP_API_KEY, 'Authorization': `Bearer ${process.env.PP_SECRET_KEY}` },
        data: {
            name: user.brandName.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 30),
            email: `${formattedPhone}@smartreceipt.user`, phoneNumber: formattedPhone,
            bankCode: ['20946'], businessId: process.env.PP_BUSINESS_ID
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

async function handleMessage(clients, msg) {
    const { platform, chatId, text } = msg;
    console.log(`\n--- [CHECKPOINT 1] --- Message received on ${platform} from ${chatId}. Text: "${text}"`);

    if (processingUsers.has(chatId)) {
        console.log(`--- [HALTED] --- User ${chatId} is already being processed. Ignoring message.`);
        return;
    }
    processingUsers.add(chatId);
    
    const db = getDB();
    try {
        const userQuery = platform === 'whatsapp' ? { userId: chatId } : { telegramId: chatId };
        const sessionQuery = platform === 'whatsapp' ? { userId: chatId } : { telegramId: chatId };

        let user = await db.collection('users').findOne(userQuery);
        let userSession = await db.collection('conversations').findOne(sessionQuery);
        const currentState = userSession ? userSession.state : null;
        console.log(`--- [CHECKPOINT 2] --- User found: ${user ? user.brandName : 'No'} | Active session: ${currentState || 'None'}`);
        
        const lowerCaseText = text.toLowerCase();
        let command = lowerCaseText;
        if (platform === 'telegram' && command.startsWith('/')) {
            command = command.substring(1);
        }

        const isAdmin = (platform === 'whatsapp' && user && ADMIN_WHATSAPP_IDS.includes(user.userId)) || 
                        (platform === 'telegram' && user && ADMIN_TELEGRAM_IDS.includes(user.telegramId.toString()));
        
        if (isAdmin) {
            if (command === 'tickets') { console.log('Executing admin command: tickets'); await handleAdminTicketsCommand(msg); return; }
            if (command.startsWith('reply ')) { console.log('Executing admin command: reply'); await handleAdminReplyCommand(msg, text, clients); return; }
            if (command.startsWith('close ')) { console.log('Executing admin command: close'); await handleAdminCloseCommand(msg, text, ADMIN_WHATSAPP_IDS, clients); return; }
        }
        
        if (command === 'support') {
             console.log('Executing command: support'); await handleSupportCommand(msg, chatId, platform); return;
        }

        const commandParts = command.split(' ');
        const mainCommand = commandParts[0];
        const isCommand = commands.includes(mainCommand) || command.startsWith('remove product') || command.startsWith('restore');
        console.log(`--- [CHECKPOINT 3] --- Parsed command: "${mainCommand}" | Is a command: ${isCommand}`);

        if (isCommand && currentState) {
            console.log(`--- [INFO] --- New command received, clearing old session state: ${currentState}`);
            await db.collection('conversations').deleteOne(sessionQuery);
            userSession = null;
        }
        
        if (userSession && !isCommand) {
            console.log(`--- [CHECKPOINT 4] --- Entering CONVERSATIONAL reply block for state: ${currentState}`);
            const invalidChoiceReplies = ["Invalid choice. Please try again.", "That's not a valid option. Please choose from the list."];
            const updateSuccessReplies = ['✅ Updated successfully!', '✅ All set!', '✅ Done. Your changes have been saved.'];

            switch (currentState) {
                case 'awaiting_support_message': await handleNewTicket(msg, user, clients, { whatsapp: ADMIN_WHATSAPP_IDS, telegram: ADMIN_TELEGRAM_IDS }); break;
                case 'in_support_conversation': await handleTicketResponse(msg, userSession, clients); break;
                case 'awaiting_brand_name': {
                    const userData = { brandName: text, onboardingComplete: false, receiptCount: 0, isPaid: false, createdAt: new Date() };
                    if (platform === 'whatsapp') userData.userId = chatId;
                    if (platform === 'telegram') userData.telegramId = chatId;
                    await db.collection('users').insertOne(userData);
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_brand_color' } });
                    await msg.reply(`Great! Your brand is "${text}".\n\nWhat's your brand's main color? (e.g., #1D4ED8 or "blue")`);
                    break;
                }
                case 'awaiting_brand_color':
                    await db.collection('users').updateOne(userQuery, { $set: { brandColor: text } });
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_logo' } });
                    await msg.reply(`Color saved!\n\nNow, please upload your business logo. If you don't have one, just type *'skip'*.`);
                    break;
                case 'awaiting_logo':
                    if (msg.hasMedia) {
                        const media = await msg.downloadMedia();
                        await msg.reply("Logo received! Uploading now, please wait...");
                        const logoUrl = await uploadLogo(media);
                        if (logoUrl) {
                            await db.collection('users').updateOne(userQuery, { $set: { logoUrl: logoUrl } });
                            await msg.reply("Logo uploaded successfully!");
                        } else { await msg.reply("Sorry, I couldn't upload the logo. We'll proceed without it for now."); }
                    } else if (lowerCaseText !== 'skip') {
                        await msg.reply("That's not an image. Please upload a logo file or type 'skip'.");
                        break;
                    }
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_address' } });
                    await msg.reply(`Logo step complete.\n\nNext, what is your business address?`);
                    break;
                case 'awaiting_address':
                    await db.collection('users').updateOne(userQuery, { $set: { address: text } });
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_contact_info' } });
                    await msg.reply(`Address saved.\n\nFinally, what contact info should be on the receipt? (e.g., a phone number, an email, or both)`);
                    break;
                case 'awaiting_contact_info': {
                    const fullContactText = text;
                    let contactEmail = null, contactPhone = null;
                    const emailMatch = fullContactText.match(/\S+@\S+\.\S+/);
                    if (emailMatch) { contactEmail = emailMatch[0]; }
                    const phoneText = fullContactText.replace(contactEmail || '', '').trim();
                    if (phoneText.match(/(\+)?\d+/)) { contactPhone = phoneText; }
                    await db.collection('users').updateOne(userQuery, { $set: { contactInfo: text, contactEmail: contactEmail, contactPhone: phoneText, onboardingComplete: true } });
                    await db.collection('conversations').deleteOne(sessionQuery);
                    await msg.reply(`✅ *Setup Complete!* Your brand profile is all set.\n\nTo create your first receipt, just type:\n*'new receipt'*`);
                    break;
                }
                case 'receipt_customer_name': {
                    const hasProducts = await db.collection('products').findOne(userQuery);
                    const prompt = hasProducts ? `Customer: *${text}*\n\nNow, add items. You can use your catalog (e.g., _Fanta x2_) or type items manually.\n\n*(Separate with commas or list on new lines)*` : `Customer: *${text}*\n\nWhat item(s) did they purchase?\n\n*(Separate with commas or list on new lines)*`;
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'receipt_items', 'data.receiptData.customerName': text } });
                    await msg.reply(prompt);
                    break;
                }
                case 'receipt_items': {
                    const items = [], prices = [], manualItems = [];
                    const parts = parseInputList(text);
                    for (const part of parts) {
                        const trimmedPart = part.trim();
                        const quickAddMatch = /(.+)\s+x(\d+)/i.exec(trimmedPart);
                        if (quickAddMatch) {
                            const productName = quickAddMatch[1].trim();
                            const quantity = parseInt(quickAddMatch[2], 10);
                            const product = await db.collection('products').findOne({ ...userQuery, name: { $regex: new RegExp(`^${productName}$`, 'i') } });
                            if (product) {
                                for (let i = 0; i < quantity; i++) { items.push(product.name); prices.push(product.price); }
                            } else { manualItems.push(trimmedPart); }
                        } else if (trimmedPart) { manualItems.push(trimmedPart); }
                    }
                    if (manualItems.length > 0) {
                        await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'receipt_manual_prices', 'data.receiptData.manualItems': manualItems, 'data.receiptData.quickAddItems': items, 'data.receiptData.quickAddPrices': prices }});
                        await msg.reply(`Catalog items added. Now, please enter the prices for your manual items, *each on a new line or separated by commas*:\n\n*${manualItems.join('\n')}*`);
                    } else {
                        await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'receipt_payment_method', 'data.receiptData.items': items, 'data.receiptData.prices': prices.map(p => p.toString()) }});
                        await msg.reply(`Items and prices added from your catalog.\n\nWhat was the payment method?`);
                    }
                    break;
                }
                case 'receipt_manual_prices': {
                    const manualPrices = parseInputList(text);
                    if(manualPrices.length !== userSession.data.receiptData.manualItems.length) {
                        await msg.reply("The number of prices does not match the number of manual items. Please try again.");
                        break;
                    }
                    const finalItems = [...(userSession.data.receiptData.quickAddItems || []), ...(userSession.data.receiptData.manualItems || [])];
                    const finalPrices = [...(userSession.data.receiptData.quickAddPrices || []), ...manualPrices].map(p => p.toString());
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'receipt_payment_method', 'data.receiptData.items': finalItems, 'data.receiptData.prices': finalPrices }});
                    await msg.reply(`Prices saved.\n\nWhat was the payment method?`);
                    break;
                }
                case 'receipt_payment_method': {
                    userSession.data.receiptData.paymentMethod = text;
                    if (!user.receiptFormat) {
                        await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_initial_format_choice', 'data.receiptData': userSession.data.receiptData } });
                        await msg.reply(`Payment method saved.\n\nOne last thing! What's your preferred format?\n\n*1. Image (PNG)*\n*2. Document (PDF)*\nPlease reply with *1* or *2*.`);
                    } else {
                        await generateAndSendReceipt(clients, msg, user, userSession.data.receiptData);
                    }
                    break;
                }
                case 'awaiting_mybrand_choice': {
                    const choice = parseInt(text, 10);
                    let nextState = '', prompt = '';
                    if (choice === 1) { nextState = 'updating_brand_name'; prompt = 'What is your new brand name?'; }
                    else if (choice === 2) { nextState = 'updating_brand_color'; prompt = 'What is your new brand color?'; }
                    else if (choice === 3) { nextState = 'updating_logo'; prompt = 'Please upload your new logo.'; }
                    else if (choice === 4) { nextState = 'updating_address'; prompt = 'What is your new address?'; }
                    else if (choice === 5) { nextState = 'updating_contact_info'; prompt = 'What is your new contact info?'; }
                    else { await msg.reply(getRandomReply(invalidChoiceReplies)); break; }
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: nextState } });
                    await msg.reply(prompt);
                    break;
                }
                case 'updating_brand_name':
                    await db.collection('users').updateOne(userQuery, { $set: { brandName: text } });
                    await msg.reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne(sessionQuery);
                    break;
                case 'updating_brand_color':
                    await db.collection('users').updateOne(userQuery, { $set: { brandColor: text } });
                    await msg.reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne(sessionQuery);
                    break;
                case 'updating_logo':
                    if (msg.hasMedia) {
                        const media = await msg.downloadMedia();
                        await msg.reply("New logo received! Uploading...");
                        const logoUrl = await uploadLogo(media);
                        if (logoUrl) {
                            await db.collection('users').updateOne(userQuery, { $set: { logoUrl: logoUrl } });
                            await msg.reply("✅ Logo updated successfully!");
                        } else { await msg.reply("Sorry, the logo upload failed."); }
                    } else { await msg.reply("That's not an image. Please upload a logo file."); }
                    await db.collection('conversations').deleteOne(sessionQuery);
                    break;
                case 'updating_address':
                    await db.collection('users').updateOne(userQuery, { $set: { address: text } });
                    await msg.reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne(sessionQuery);
                    break;
                case 'updating_contact_info': {
                    const fullContactText = text;
                    let contactEmail = null, contactPhone = null;
                    const emailMatchUpdate = fullContactText.match(/\S+@\S+\.\S+/);
                    if (emailMatchUpdate) { contactEmail = emailMatchUpdate[0]; }
                    const phoneText = fullContactText.replace(contactEmail || '', '').trim();
                    if (phoneText.match(/(\+)?\d+/)) { contactPhone = phoneText; }
                    await db.collection('users').updateOne(userQuery, { $set: { contactInfo: text, contactEmail: contactEmail, contactPhone: contactPhone } });
                    await msg.reply(getRandomReply(updateSuccessReplies));
                    await db.collection('conversations').deleteOne(sessionQuery);
                    break;
                }
                case 'awaiting_edit_choice': {
                    const editChoice = parseInt(text, 10);
                    let nextState = '', prompt = '';
                    if (editChoice === 1) { nextState = 'editing_customer_name'; prompt = 'What is the new customer name?'; }
                    else if (editChoice === 2) { nextState = 'editing_items'; prompt = 'Please re-enter all items, *separated by commas or on new lines*.'; }
                    else if (editChoice === 3) { nextState = 'editing_payment_method'; prompt = 'What is the new payment method?'; }
                    else { await msg.reply(getRandomReply(invalidChoiceReplies)); break; }
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: nextState } });
                    await msg.reply(prompt);
                    break;
                }
                case 'editing_customer_name':
                    userSession.data.receiptToEdit.customerName = text;
                    await db.collection('conversations').deleteOne(sessionQuery);
                    await generateAndSendReceipt(clients, msg, user, userSession.data.receiptToEdit, false, true);
                    break;
                case 'editing_items':
                    userSession.data.receiptToEdit.items = parseInputList(text);
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'editing_prices', 'data.receiptToEdit': userSession.data.receiptToEdit } });
                    await msg.reply("Items updated. Now, please re-enter all prices in the correct order.");
