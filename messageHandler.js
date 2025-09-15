// messageHandler.js

const { getDB, ObjectId } = require('./db.js');
const { generateAndSendReceipt } = require('./receiptGenerator.js');
// The new index.js will export parseInputList and uploadLogo
const { parseInputList, uploadLogo } = require('./utils.js'); 
const { isSubscriptionActive } = require('./helpers.js');
const { handleSupportCommand, handleNewTicket, handleTicketResponse, handleAdminTicketsCommand, handleAdminReplyCommand, handleAdminCloseCommand } = require('./support.js');
const crypto = require('crypto');
const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js'); // Required for text export

// --- CONSTANTS ---
const commands = ['new receipt', 'changereceipt', 'stats', 'history', 'edit', 'export', 'add product', 'products', 'format', 'mybrand', 'cancel', 'commands', 'support', 'backup', 'restore'];
const premiumCommands = ['new receipt', 'edit', 'export'];
const ADMIN_NUMBERS = ['2347016370067@c.us', '2348146817448@c.us']; // WhatsApp IDs for admins
const SUBSCRIPTION_FEE = 2000;
const FREE_TRIAL_LIMIT = 2;
const FREE_EDIT_LIMIT = 2;

// --- HELPER FUNCTIONS ---
async function generateVirtualAccount(user) {
    const formatPhoneNumberForApi = (whatsappId) => {
        if (!whatsappId) return "INVALID_PHONE_FORMAT";
        let number = whatsappId.split('@')[0];
        number = number.replace(/\D/g, '');
        if (number.startsWith('234') && number.length === 13) { return '0' + number.substring(3); }
        if (number.length === 10 && !number.startsWith('0')) { return '0' + number; }
        if (number.length === 11 && number.startsWith('0')) { return number; }
        return "INVALID_PHONE_FORMAT"; 
    };

    // Prefers WhatsApp ID for phone number, but can be adapted if Telegram users need this
    const formattedPhone = formatPhoneNumberForApi(user.userId);
    if (formattedPhone === "INVALID_PHONE_FORMAT") { 
        console.error(`Could not format phone number for user: ${user.userId || user.telegramId}`); 
        return null; 
    }
    const options = {
        method: 'POST',
        url: 'https://api.paymentpoint.co/api/v1/createVirtualAccount',
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


// --- MAIN MESSAGE HANDLER ---
async function handleMessage(clients, msg) {
    const { platform, chatId, text, hasMedia, downloadMedia } = msg;
    const db = getDB();

    try {
        // Define platform-specific queries
        const userQuery = platform === 'whatsapp' ? { userId: chatId } : { telegramId: chatId };
        const sessionQuery = platform === 'whatsapp' ? { userId: chatId } : { telegramId: chatId };

        let user = await db.collection('users').findOne(userQuery);
        let userSession = await db.collection('conversations').findOne(sessionQuery);
        const currentState = userSession ? userSession.state : null;

        const lowerCaseText = text.toLowerCase();
        
        // Normalize commands (e.g., remove "/" from Telegram commands)
        let command = lowerCaseText;
        if (platform === 'telegram' && command.startsWith('/')) {
            command = command.substring(1);
        }

        const isAdmin = user && ADMIN_NUMBERS.includes(user.userId);
        
        // --- ADMIN COMMANDS ---
        if (isAdmin) {
            if (command === 'tickets') {
                await handleAdminTicketsCommand(msg); return;
            }
            if (command.startsWith('reply ')) {
                await handleAdminReplyCommand(msg, text, clients); return;
            }
            if (command.startsWith('close ')) {
                await handleAdminCloseCommand(msg, text, ADMIN_NUMBERS, clients); return;
            }
        }
        
        if (command === 'support') {
             await handleSupportCommand(msg, chatId, platform); return;
        }

        // --- HANDLE COMMANDS vs CONVERSATIONAL REPLIES ---
        const commandParts = command.split(' ');
        const mainCommand = commandParts[0];
        const isCommand = commands.includes(mainCommand) || command.startsWith('remove product') || command.startsWith('restore');

        if (isCommand) {
            // If the user issues a new command, clear any previous conversation state.
            if (currentState) {
                await db.collection('conversations').deleteOne(sessionQuery);
                userSession = null;
            }
        }

        // --- 1. HANDLE ACTIVE CONVERSATION STATES ---
        if (userSession && !isCommand) {
            const invalidChoiceReplies = ["Invalid choice. Please try again.", "That's not a valid option. Please choose from the list."];
            const updateSuccessReplies = ['✅ Updated successfully!', '✅ All set!', '✅ Done. Your changes have been saved.'];

            switch (currentState) {
                // Support States
                case 'awaiting_support_message':
                    await handleNewTicket(msg, user, clients, ADMIN_NUMBERS);
                    return;
                case 'in_support_conversation':
                    await handleTicketResponse(msg, userSession, clients);
                    return;

                // Onboarding States
                case 'awaiting_brand_name': {
                    const userData = {
                        brandName: text,
                        onboardingComplete: false,
                        receiptCount: 0,
                        isPaid: false,
                        createdAt: new Date()
                    };
                    if (platform === 'whatsapp') userData.userId = chatId;
                    if (platform === 'telegram') userData.telegramId = chatId;
                    
                    await db.collection('users').insertOne(userData);
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_brand_color' } });
                    await msg.reply(`Great! Your brand is "${text}".\n\nWhat's your brand's main color? (e.g., #1D4ED8 or "blue")`);
                    break;
                }
                case 'awaiting_brand_color': {
                    await db.collection('users').updateOne(userQuery, { $set: { brandColor: text } });
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_logo' } });
                    await msg.reply(`Color saved!\n\nNow, please upload your business logo. If you don't have one, just type *'skip'*.`);
                    break;
                }
                case 'awaiting_logo': {
                    if (hasMedia) {
                        const media = await downloadMedia();
                        await msg.reply("Logo received! Uploading now, please wait...");
                        const logoUrl = await uploadLogo(media); // This function needs to be in utils.js
                        if (logoUrl) {
                            await db.collection('users').updateOne(userQuery, { $set: { logoUrl: logoUrl } });
                            await msg.reply("Logo uploaded successfully!");
                        } else {
                            await msg.reply("Sorry, I couldn't upload the logo. We'll proceed without it for now.");
                        }
                    } else if (lowerCaseText !== 'skip') {
                        await msg.reply("That's not an image. Please upload a logo file or type 'skip'.");
                        break;
                    }
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_address' } });
                    await msg.reply(`Logo step complete.\n\nNext, what is your business address?`);
                    break;
                }
                case 'awaiting_address': {
                    await db.collection('users').updateOne(userQuery, { $set: { address: text } });
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_contact_info' } });
                    await msg.reply(`Address saved.\n\nFinally, what contact info should be on the receipt? (e.g., a phone number, an email, or both)`);
                    break;
                }
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
                
                // Receipt Creation States
                case 'receipt_customer_name': {
                    const hasProducts = await db.collection('products').findOne(userQuery);
                    const prompt = hasProducts 
                        ? `Customer: *${text}*\n\nNow, add items. You can use your catalog (e.g., _Fanta x2_) or type items manually.\n\n*(Separate with commas or list on new lines)*`
                        : `Customer: *${text}*\n\nWhat item(s) did they purchase?\n\n*(Separate with commas or list on new lines)*`;
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
                            const productQuery = { ...userQuery, name: { $regex: new RegExp(`^${productName}$`, 'i') } };
                            const product = await db.collection('products').findOne(productQuery);
                            if (product) {
                                for (let i = 0; i < quantity; i++) { items.push(product.name); prices.push(product.price); }
                            } else { manualItems.push(trimmedPart); }
                        } else if (trimmedPart) { manualItems.push(trimmedPart); }
                    }

                    if (manualItems.length > 0) {
                        await db.collection('conversations').updateOne(sessionQuery, { $set: { 
                            state: 'receipt_manual_prices', 'data.receiptData.manualItems': manualItems,
                            'data.receiptData.quickAddItems': items, 'data.receiptData.quickAddPrices': prices
                        }});
                        await msg.reply(`Catalog items added. Now, please enter the prices for your manual items, *each on a new line or separated by commas*:\n\n*${manualItems.join('\n')}*`);
                    } else {
                        await db.collection('conversations').updateOne(sessionQuery, { $set: { 
                            state: 'receipt_payment_method', 'data.receiptData.items': items,
                            'data.receiptData.prices': prices.map(p => p.toString())
                        }});
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
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { 
                        state: 'receipt_payment_method', 'data.receiptData.items': finalItems, 'data.receiptData.prices': finalPrices
                    }});
                    await msg.reply(`Prices saved.\n\nWhat was the payment method?`);
                    break;
                }
                case 'receipt_payment_method': {
                    userSession.data.receiptData.paymentMethod = text;
                    if (!user.receiptFormat) {
                        await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_initial_format_choice', 'data.receiptData': userSession.data.receiptData } });
                        const formatMessage = `Payment method saved.\n\nOne last thing for your first receipt! What's your preferred format?\n\n*1. Image (PNG)*\n_Good for quick sharing._\n\n*2. Document (PDF)*\n_Best for official records._\n\nPlease reply with *1* or *2*.`;
                        await msg.reply(formatMessage);
                    } else {
                        await generateAndSendReceipt(clients, user, userSession.data.receiptData, msg);
                    }
                    break;
                }

                 // Brand Update States
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
                    if (hasMedia) {
                        const media = await downloadMedia();
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
                
                // Receipt Editing States
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
                    await generateAndSendReceipt(clients, user, userSession.data.receiptToEdit, msg, false, true);
                    break;
                case 'editing_items':
                    userSession.data.receiptToEdit.items = parseInputList(text);
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'editing_prices', 'data.receiptToEdit': userSession.data.receiptToEdit } });
                    await msg.reply("Items updated. Now, please re-enter all prices in the correct order.");
                    break;
                case 'editing_prices':
                    userSession.data.receiptToEdit.prices = parseInputList(text);
                    if (userSession.data.receiptToEdit.items.length !== userSession.data.receiptToEdit.prices.length) {
                        await msg.reply("The number of items and prices don't match. Please try editing again by typing 'edit'.");
                        await db.collection('conversations').deleteOne(sessionQuery);
                        break;
                    }
                    await db.collection('conversations').deleteOne(sessionQuery);
                    await generateAndSendReceipt(clients, user, userSession.data.receiptToEdit, msg, false, true);
                    break;
                case 'editing_payment_method':
                    userSession.data.receiptToEdit.paymentMethod = text;
                    await db.collection('conversations').deleteOne(sessionQuery);
                    await generateAndSendReceipt(clients, user, userSession.data.receiptToEdit, msg, false, true);
                    break;

                // History State
                 case 'awaiting_history_choice': {
                    if (platform !== 'whatsapp') break; // This state is specific to WhatsApp's reply-by-number
                    const historyChoice = parseInt(text, 10);
                    if (historyChoice >= 1 && historyChoice <= userSession.data.history.length) {
                        const selectedReceipt = userSession.data.history[historyChoice - 1];
                        await db.collection('conversations').deleteOne(sessionQuery);
                        await generateAndSendReceipt(clients, user, selectedReceipt, msg, true);
                    } else {
                        await msg.reply("Invalid number. Please reply with a number from the list (1-5).");
                        await db.collection('conversations').deleteOne(sessionQuery);
                    }
                    break;
                }

                // Other States
                 case 'awaiting_template_choice': {
                    const templateChoice = parseInt(text, 10);
                    if (templateChoice >= 1 && templateChoice <= 6) {
                        await db.collection('users').updateOne(userQuery, { $set: { preferredTemplate: templateChoice } });
                        await db.collection('conversations').deleteOne(sessionQuery);
                        await msg.reply(`✅ Template #${templateChoice} is now your default.`);
                    } else {
                        await msg.reply("Invalid selection. Please send a single number between 1 and 6.");
                    }
                    break;
                }
                 case 'adding_product_name': {
                    if (lowerCaseText === 'done') {
                        await db.collection('conversations').deleteOne(sessionQuery);
                        await msg.reply("Great! Your products have been saved to your catalog.");
                        break;
                    }
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'adding_product_price', 'data.newProductName': text } });
                    await msg.reply(`Got it. What's the price for *${text}*?`);
                    break;
                }
                case 'adding_product_price': {
                    const price = parseFloat(text.trim().replace(/,/g, ''));
                    if (isNaN(price)) {
                        await msg.reply("That's not a valid price. Please send only a number.");
                        break;
                    }
                    const productName = userSession.data.newProductName;
                    await db.collection('products').updateOne(
                        { ...userQuery, name: { $regex: new RegExp(`^${productName}$`, 'i') } },
                        { $set: { ...userQuery, price: price, name: productName } },
                        { upsert: true }
                    );
                    await msg.reply(`✅ Saved: *${productName}* - ₦${price.toLocaleString()}.\n\nTo add another, send the next product's name. When you're done, just type *'done'*`);
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'adding_product_name' }, $unset: { 'data.newProductName': '' } });
                    break;
                }
                 case 'awaiting_format_choice':
                 case 'awaiting_initial_format_choice': {
                    const formatChoice = text.trim();
                    let format = '';
                    if(formatChoice === '1') format = 'PNG';
                    else if (formatChoice === '2') format = 'PDF';
                    else {
                        await msg.reply("Invalid choice. Please reply with *1* for Image or *2* for Document.");
                        break;
                    }
                    await db.collection('users').updateOne(userQuery, { $set: { receiptFormat: format } });
                    
                    if(currentState === 'awaiting_initial_format_choice'){
                         const finalUser = await db.collection('users').findOne(userQuery);
                         await generateAndSendReceipt(clients, finalUser, userSession.data.receiptData, msg);
                    } else {
                        await msg.reply(`✅ Preference saved! Your receipts will now be generated as *${format}* files.`);
                        await db.collection('conversations').deleteOne(sessionQuery);
                    }
                    break;
                }
                 case 'awaiting_payment_decision': {
                    if (lowerCaseText === 'yes') {
                        await msg.reply("Great! Generating a secure payment account for you now...");
                        const accountDetails = await generateVirtualAccount(user);
                        if (accountDetails && accountDetails.bankName) {
                            const reply = `To get your 6-month subscription for *₦${SUBSCRIPTION_FEE.toLocaleString()}*, please transfer to this account:\n\n` + `*Bank:* ${accountDetails.bankName}\n` + `*Account Number:* ${accountDetails.accountNumber}\n\n` + `Your access will be unlocked automatically after payment.`;
                            await msg.reply(reply);
                        } else { await msg.reply("Sorry, I couldn't generate a payment account right now. Please contact support."); }
                    } else if (lowerCaseText === 'no') {
                        await msg.reply("Okay, thank you for trying SmartReceipt! Your access is now limited. Feel free to come back if you change your mind.");
                    } else {
                        await msg.reply("Please reply with just 'Yes' or 'No'.");
                        break;
                    }
                    await db.collection('conversations').deleteOne(sessionQuery);
                    break;
                }

                default:
                    // If state is unknown, clear it to avoid getting stuck.
                    await db.collection('conversations').deleteOne(sessionQuery);
                    await msg.reply("Sorry, I got confused. Let's start over.");
                    break;
            }
            return; // End processing since we handled a state
        }
        
        // --- 2. HANDLE NEW USERS ---
        if (!user && mainCommand !== 'restore') {
            await db.collection('conversations').insertOne({ ...sessionQuery, state: 'awaiting_brand_name', data: {} });
            await msg.reply("👋 Welcome! It looks like you're new here. Let's set up your brand first.\n\nWhat is your business name?");
            return;
        }

        // --- 3. HANDLE COMMANDS ---
        if (isCommand) {
            // Subscription Check for premium commands
            const subscriptionActive = isSubscriptionActive(user); // Removed admin bypass from here, handled by isAdmin flag
            if (!isAdmin && !subscriptionActive && premiumCommands.includes(mainCommand) && user.receiptCount >= FREE_TRIAL_LIMIT) {
                await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_payment_decision' } }, { upsert: true });
                const paywallMessage = `Dear *${user.brandName}*,\n\nYou have reached your limit of ${FREE_TRIAL_LIMIT} free receipts. To unlock unlimited access, please subscribe for just *₦${SUBSCRIPTION_FEE.toLocaleString()} for 6 months*.\n\n(Please reply *Yes* or *No*)`;
                await msg.reply(paywallMessage);
                return;
            }

            switch (mainCommand) {
                case 'new receipt':
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'receipt_customer_name', data: { receiptData: {} } } }, { upsert: true });
                    await msg.reply('🧾 *New Receipt Started*\n\nWho is the customer?');
                    break;
                case 'edit': {
                    const lastReceipt = await db.collection('receipts').findOne(userQuery, { sort: { createdAt: -1 } });
                    if (!lastReceipt) {
                        await msg.reply("You don't have any recent receipts to edit.");
                    } else {
                        const receiptEditCount = lastReceipt.editCount || 0;
                        if (!isAdmin && !subscriptionActive && receiptEditCount >= FREE_EDIT_LIMIT) {
                            await msg.reply("This receipt has reached its free edit limit of 2 changes. Please subscribe for unlimited edits.");
                        } else {
                            const editMessage = `Let's edit your last receipt (for *${lastReceipt.customerName}*).\n\nWhat would you like to change?\n*1.* Customer Name\n*2.* Items & Prices\n*3.* Payment Method`;
                            await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_edit_choice', data: { receiptToEdit: lastReceipt } } }, { upsert: true });
                            await msg.reply(editMessage);
                        }
                    }
                    break;
                }
                case 'history': {
                    const recentReceipts = await db.collection('receipts').find(userQuery).sort({ createdAt: -1 }).limit(5).toArray();
                    if (recentReceipts.length === 0) {
                        await msg.reply("You haven't generated any receipts yet.");
                    } else {
                        let historyMessage = "🧾 *Your 5 Most Recent Receipts:*\n\n";
                        recentReceipts.forEach((r, i) => { historyMessage += `*${i + 1}.* For *${r.customerName}* - ₦${r.totalAmount.toLocaleString()}\n`; });
                        if (platform === 'whatsapp') { // This interaction model is best for WhatsApp
                           historyMessage += "\nTo resend a receipt, just reply with its number (1-5).";
                           await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_history_choice', data: { history: recentReceipts } } }, { upsert: true });
                        }
                        await msg.reply(historyMessage);
                    }
                    break;
                }
                case 'stats': {
                    const now = new Date();
                    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                    const receipts = await db.collection('receipts').find({ ...userQuery, createdAt: { $gte: startOfMonth } }).toArray();
                    const totalSales = receipts.reduce((sum, receipt) => sum + receipt.totalAmount, 0);
                    const monthName = startOfMonth.toLocaleString('default', { month: 'long' });
                    await msg.reply(`📊 *Your Stats for ${monthName}*\n\n*Receipts Generated:* ${receipts.length}\n*Total Sales:* ₦${totalSales.toLocaleString()}`);
                    break;
                }
                case 'export': {
                    await msg.reply("Gathering your data for this month. Please wait a moment...");
                    const now = new Date();
                    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                    const monthName = startOfMonth.toLocaleString('default', { month: 'long' });
                    const receipts = await db.collection('receipts').find({ ...userQuery, createdAt: { $gte: startOfMonth } }).sort({ createdAt: 1 }).toArray();
                    if (receipts.length === 0) { await msg.reply("You have no receipts for this month to export."); } 
                    else {
                        let fileContent = `SmartReceipt - Sales Report for ${monthName} ${now.getFullYear()}\nBrand: ${user.brandName}\n----------------------------------------\n\n`;
                        receipts.forEach(r => {
                            fileContent += `Date: ${r.createdAt.toLocaleDateString('en-NG')}\nCustomer: ${r.customerName}\n`;
                            r.items.forEach((item, index) => { fileContent += `  - ${item}: ₦${parseFloat(r.prices[index] || 0).toLocaleString()}\n`; });
                            fileContent += `Total: ₦${r.totalAmount.toLocaleString()}\n--------------------\n`;
                        });
                        const totalSales = receipts.reduce((sum, r) => sum + r.totalAmount, 0);
                        fileContent += `\nGRAND TOTAL FOR ${monthName.toUpperCase()}: ₦${totalSales.toLocaleString()}`;
                        
                        const media = new MessageMedia('text/plain', Buffer.from(fileContent).toString('base64'), `SmartReceipt_Export_${monthName}.txt`);
                        await msg.replyWithMedia(media, `Here is your sales data for ${monthName}.`);
                    }
                    break;
                }
                case 'products': {
                    const products = await db.collection('products').find(userQuery).sort({name: 1}).toArray();
                    if(products.length === 0) { await msg.reply("You haven't added any products. Use 'add product' to start."); }
                    else {
                        let productList = "📦 *Your Product Catalog*\n\n";
                        products.forEach(p => { productList += `*${p.name}* - ₦${p.price.toLocaleString()}\n`; });
                        await msg.reply(productList);
                    }
                    break;
                }
                case 'add product':
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'adding_product_name' } }, { upsert: true });
                    await msg.reply("Let's add a new product. What is the product's name? (Type 'done' when you finish)");
                    break;
                case 'remove product': {
                    const productName = command.substring(14).trim().replace(/"/g, '');
                    if(productName) {
                        const result = await db.collection('products').deleteOne({ ...userQuery, name: { $regex: new RegExp(`^${productName}$`, 'i') } });
                        if(result.deletedCount > 0) { await msg.reply(`🗑️ Product "*${productName}*" has been removed.`); }
                        else { await msg.reply(`Could not find a product named "*${productName}*".`); }
                    } else { await msg.reply('Invalid format. Please use: `remove product "Product Name"`'); }
                    break;
                }
                case 'mybrand':
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_mybrand_choice' } }, { upsert: true });
                    await msg.reply(`*Your Brand Settings*\n\nWhat would you like to update?\n*1.* Brand Name\n*2.* Brand Color\n*3.* Logo\n*4.* Address\n*5.* Contact Info`);
                    break;
                case 'format':
                    await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_format_choice' } }, { upsert: true });
                    await msg.reply(`What format would you like your receipts in?\n\n*1.* Image (PNG)\n*2.* Document (PDF)`);
                    break;
                case 'changereceipt':
                     await db.collection('conversations').updateOne(sessionQuery, { $set: { state: 'awaiting_template_choice' } }, { upsert: true });
                     await msg.reply("Please choose your new receipt template by sending its number (1-6).");
                    break;
                case 'backup': {
                    if (!user.onboardingComplete) { await msg.reply("You must complete setup before you can create a backup."); break; }
                    let backupCode = user.backupCode;
                    if (!backupCode) {
                        backupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
                        await db.collection('users').updateOne(userQuery, { $set: { backupCode: backupCode } });
                    }
                    await msg.reply(`🔒 *Your Account Backup Code*\n\nHere is your unique recovery code: *${backupCode}*\n\nKeep this code safe! Use the 'restore' command on a new number to get your data back.`);
                    break;
                }
                case 'restore': {
                    const code = commandParts[1];
                    if (!code) { await msg.reply("Please provide a backup code. Example: `restore A1B2C3D4`"); break; }
                    
                    const userToRestore = await db.collection('users').findOne({ backupCode: code.toUpperCase() });
                    if (!userToRestore) { await msg.reply("Sorry, that backup code is not valid."); break; }
                    
                    // Prevent restoring onto the same account
                    if ((platform === 'whatsapp' && userToRestore.userId === chatId) || (platform === 'telegram' && userToRestore.telegramId === chatId)) {
                        await msg.reply("This account is already linked to that backup code.");
                        break;
                    }

                    // Link the new chat ID to the old account data
                    const updateField = platform === 'whatsapp' ? { userId: chatId } : { telegramId: chatId };
                    await db.collection('users').updateOne({ _id: userToRestore._id }, { $set: updateField });

                    // Optional: Remove any placeholder account created for the new chat ID
                    if (user) { await db.collection('users').deleteOne(userQuery); }

                    await msg.reply(`✅ *Account Restored!* Welcome back, ${userToRestore.brandName}. Your settings and subscription have been transferred.`);
                    break;
                }
                case 'commands': {
                    const commandsList = "Here are the available commands:\n\n" +
                        "*new receipt* - Start a new receipt.\n" +
                        "*edit* - Edit the last receipt.\n" +
                        "*history* - See your last 5 receipts.\n" +
                        "*stats* - View sales stats for the month.\n" +
                        "*export* - Get a text file of this month's sales.\n\n" +
                        "_*Catalog Management*_\n" +
                        "*products* - View saved products.\n" +
                        "*add product* - Add a new product.\n" +
                        "*remove product \"Name\"* - Remove a product.\n\n" +
                        "_*Settings*_\n" +
                        "*mybrand* - Update your brand details.\n" +
                        "*changereceipt* - Change receipt template.\n" +
                        "*format* - Set receipt format (PNG/PDF).\n" +
                        "*backup* - Get a recovery code.\n" +
                        "*restore [code]* - Restore your account.\n" +
                        "*support* - Talk to an admin.\n" +
                        "*cancel* - Stop any current action.";
                    await msg.reply(commandsList);
                    break;
                }
                case 'cancel':
                    await db.collection('conversations').deleteOne(sessionQuery);
                    await msg.reply("Action cancelled.");
                    break;
            }
            return;
        }

        // --- 4. DEFAULT RESPONSE ---
        if (!userSession) {
            await msg.reply(`Hi ${user.brandName}! Send 'commands' to see what I can do.`);
        }

    } catch (error) {
        console.error(`Error in message handler for ${platform} (${chatId}):`, error);
        await msg.reply("Sorry, a technical error occurred. Please try again or type 'support' to contact an admin.");
    }
}

module.exports = { handleMessage };
