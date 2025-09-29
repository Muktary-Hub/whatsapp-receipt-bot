// support.js

const { getDB } = require('./db.js');
const { sendMessageWithDelay } = require('./helpers.js');

// --- HELPER FUNCTION (No changes needed) ---
const generateTicketId = async () => {
    const db = getDB();
    let ticketId;
    let isUnique = false;
    while (!isUnique) {
        ticketId = Math.random().toString(36).substring(2, 7).toUpperCase();
        const existingTicket = await db.collection('tickets').findOne({ _id: ticketId });
        if (!existingTicket) {
            isUnique = true;
        }
    }
    return ticketId;
};

// --- HELPER to get text from a Baileys message object ---
const getText = (msg) => {
    return (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
};

// --- REWRITTEN FOR BAILEYS ---
const handleSupportCommand = async ({ sock, senderId }) => {
    const db = getDB();
    await db.collection('conversations').updateOne(
        { userId: senderId },
        { $set: { state: 'awaiting_support_message' } },
        { upsert: true }
    );
    await sendMessageWithDelay(sock, senderId, "You are now connected to support. Please describe your issue, and an admin will get back to you shortly.");
};

// --- REWRITTEN FOR BAILEYS ---
const handleNewTicket = async ({ sock, baileysMsg, user, ADMIN_NUMBERS }) => {
    const db = getDB();
    const ticketId = await generateTicketId();
    const userMessage = getText(baileysMsg);
    const ticket = {
        _id: ticketId,
        userId: user.userId,
        brandName: user.brandName,
        status: 'open',
        createdAt: new Date(),
        messages: [{ sender: 'user', text: userMessage, timestamp: new Date() }]
    };
    await db.collection('tickets').insertOne(ticket);
    await db.collection('conversations').updateOne({ userId: user.userId }, { $set: { state: 'in_support_conversation', 'data.ticketId': ticketId } });

    await sendMessageWithDelay(sock, user.userId, `✅ Your support ticket has been created. Your Ticket ID is *${ticketId}*. An admin will review your message shortly.`);

    const adminNotification = `*New Support Ticket* 🔔\n\n*From Brand:* ${user.brandName}\n*Ticket ID:* \`${ticketId}\`\n*User Message:* "${userMessage}"\n\n_Reply with: \`reply ${ticketId} [your message]\`_`;
    for (const admin of ADMIN_NUMBERS) {
        sock.sendMessage(admin, { text: adminNotification }).catch(e => console.error(`Failed to send notification to admin ${admin}:`, e));
    }
};

// --- REWRITTEN FOR BAILEYS ---
const handleTicketResponse = async ({ sock, baileysMsg, userSession }) => {
    const db = getDB();
    const ticketId = userSession.data.ticketId;
    const senderId = baileysMsg.key.remoteJid;
    const messageText = getText(baileysMsg);

    if (messageText.toLowerCase() === 'close ticket') {
        await db.collection('tickets').updateOne({ _id: ticketId }, { $set: { status: 'closed_by_user' } });
        await db.collection('conversations').deleteOne({ userId: senderId });
        await sendMessageWithDelay(sock, senderId, "Your support ticket has been successfully closed. Please feel free to reach out again if you need anything else!");
    } else {
        await db.collection('tickets').updateOne(
            { _id: ticketId },
            { $push: { messages: { sender: 'user', text: messageText, timestamp: new Date() } } }
        );
        await sendMessageWithDelay(sock, senderId, "Your message has been added to the ticket.");
    }
};

// --- REWRITTEN FOR BAILEYS ---
const handleAdminTicketsCommand = async ({ sock, senderId }) => {
    const db = getDB();
    const openTickets = await db.collection('tickets').find({ status: 'open' }).toArray();
    if (openTickets.length === 0) {
        await sock.sendMessage(senderId, { text: "There are no open support tickets." });
    } else {
        let reply = "*Open Support Tickets*\n\n";
        for (const ticket of openTickets) {
            reply += `*Brand:* ${ticket.brandName}\n*ID:* \`${ticket._id}\`\n*Last Msg:* "${ticket.messages[ticket.messages.length - 1].text}"\n-----------------\n`;
        }
        reply += "\nTo reply, use `reply [ID] [message]`";
        await sock.sendMessage(senderId, { text: reply });
    }
};

// --- REWRITTEN FOR BAILEYS ---
const handleAdminReplyCommand = async ({ sock, text, senderId }) => {
    const db = getDB();
    const parts = text.split(' ');
    const ticketId = parts[1]?.toUpperCase();
    const replyText = parts.slice(2).join(' ');

    if (!ticketId || !replyText) {
        await sock.sendMessage(senderId, { text: "Invalid format. Use: `reply [ID] [message]`" });
        return;
    }
    const ticket = await db.collection('tickets').findOne({ _id: ticketId });
    if (!ticket) {
        await sock.sendMessage(senderId, { text: "Ticket not found." });
        return;
    }

    await db.collection('tickets').updateOne(
        { _id: ticketId },
        { $push: { messages: { sender: 'admin', text: replyText, timestamp: new Date() } } }
    );
    
    await sock.sendMessage(ticket.userId, { text: `An admin has replied to your ticket *${ticketId}*:\n\n${replyText}` });
    await sock.sendMessage(senderId, { text: `✅ Replied to ticket \`${ticketId}\`.` });
};

// --- REWRITTEN FOR BAILEYS ---
const handleAdminCloseCommand = async ({ sock, text, senderId, ADMIN_NUMBERS }) => {
    const db = getDB();
    const ticketId = text.split(' ')[1]?.toUpperCase();
    if (!ticketId) {
        await sock.sendMessage(senderId, { text: "Please provide a Ticket ID to close." });
        return;
    }
    const result = await db.collection('tickets').updateOne({ _id: ticketId }, { $set: { status: 'closed_by_admin' } });
    
    if (result.modifiedCount > 0) {
        await sock.sendMessage(senderId, { text: `✅ Ticket \`${ticketId}\` has been closed.` });
        
        const closeNotification = `ℹ️ Ticket \`${ticketId}\` was closed by an admin.`;
        for (const admin of ADMIN_NUMBERS) {
            if (admin !== senderId) {
                sock.sendMessage(admin, { text: closeNotification }).catch(e => console.error(`Failed to send close notification to admin ${admin}:`, e));
            }
        }
    } else {
        await sock.sendMessage(senderId, { text: "Could not find or close that ticket." });
    }
};

module.exports = {
    handleSupportCommand,
    handleNewTicket,
    handleTicketResponse,
    handleAdminTicketsCommand,
    handleAdminReplyCommand,
    handleAdminCloseCommand
};
