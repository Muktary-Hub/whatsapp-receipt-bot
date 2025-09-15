// receiptGenerator.js (Corrected)

const { MessageMedia } = require('whatsapp-web.js');
const { getDB } = require('./db.js');

/**
 * A centralized function to generate and send a receipt.
 * @param {object} clients - An object containing initialized clients: { whatsapp, telegram, browser }.
 * @param {object} msg - The abstracted message object from the handler.
 * @param {object} user - The user's data object from the database.
 * @param {object} receiptData - The data for the receipt to be generated.
 * @param {boolean} isResend - Flag to indicate if this is a resend from history.
 * @param {boolean} isEdit - Flag to indicate if this is an edit of an existing receipt.
 */
async function generateAndSendReceipt(clients, msg, user, receiptData, isResend = false, isEdit = false) {
    const db = getDB();
    const { platform, chatId } = msg;

    if (!isEdit) {
        const message = isResend ? 'Recreating that receipt for you...' : 'Generating your receipt...';
        await msg.reply(`✅ Got it! ${message}`);
    }

    const format = user.receiptFormat || 'PNG'; 
    const subtotal = receiptData.prices.reduce((sum, price) => sum + parseFloat(price || 0), 0);
    
    let finalReceiptId = receiptData._id; 
    if (!isResend) {
        if (isEdit) {
            await db.collection('receipts').updateOne({ _id: finalReceiptId }, { 
                $set: {
                    customerName: receiptData.customerName, items: receiptData.items, 
                    prices: receiptData.prices.map(p => p.toString()),
                    paymentMethod: receiptData.paymentMethod, totalAmount: subtotal
                },
                $inc: { editCount: 1 }
            });
        } else {
             const result = await db.collection('receipts').insertOne({
                ownerId: user._id, // CORRECT: Links receipt to the user's unique DB ID
                createdAt: new Date(), 
                customerName: receiptData.customerName,
                totalAmount: subtotal, 
                items: receiptData.items,
                prices: receiptData.prices.map(p => p.toString()), 
                paymentMethod: receiptData.paymentMethod,
                editCount: 0 
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
    
    const fullUrl = `${process.env.RECEIPT_BASE_URL}template.${user.preferredTemplate || 1}.html?${urlParams.toString()}`;
    
    let page;
    try {
        // CORRECT: Uses the shared, independent browser instance
        page = await clients.browser.newPage();
        const response = await page.goto(fullUrl, { waitUntil: 'networkidle0' });
        
        if (!response.ok()) {
            throw new Error(`Failed to load receipt page: ${response.status()}`);
        }

        let fileBuffer, mimeType, fileName;
        const caption = `Here is the receipt for ${receiptData.customerName}.`;

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
        
        const fileData = { buffer: fileBuffer, fileName, mimeType };
        await msg.replyWithFile(fileData, caption);
        
        if (!isResend && !isEdit) {
            await db.collection('users').updateOne({ _id: user._id }, { $inc: { receiptCount: 1 } });
        }
        const sessionQuery = platform === 'whatsapp' ? { userId: chatId } : { telegramId: chatId };
        await db.collection('conversations').deleteOne(sessionQuery);

    } catch(err) {
        console.error("Error during receipt generation:", err);
        const errorMsg = "Sorry, a technical error occurred while creating the receipt file. Please try again.";
        await msg.reply(errorMsg);
        const sessionQuery = platform === 'whatsapp' ? { userId: chatId } : { telegramId: chatId };
        await db.collection('conversations').deleteOne(sessionQuery);
    } finally {
        if (page && !page.isClosed()) {
            await page.close();
        }
    }
}

module.exports = { generateAndSendReceipt };
