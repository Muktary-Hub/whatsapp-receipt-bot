const { getDB } = require('./db.js');
const { sendMessageWithDelay } = require('./helpers.js');

// Function to generate a unique 5-character alphanumeric ID
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

const handleSupportCommand = async (msg, senderId) => {
    const db = getDB();
    await db.collection('conversations').updateOne(
        { userId: senderId },
        { $set: { state: 'awaiting_support_message' } },
        { upsert: true }
    );
    await sendMessageWithDelay(msg, "You are now connected to support. Please describe your issue, and an admin will get back to you shortly.");
};

const handleNewTicket = async (msg, user, client, ADMIN_NUMBERS) => {
    const db = getDB();
    const ticketId = await generateTicketId(); // Use the new short ID generator
    const ticket = {
        _id: ticketId, // The ID is now the short string
        userId: user.userId,
        brandName: user.brandName,
        status: 'open',
        createdAt: new Date(),
        messages: [{ sender: 'user', text: msg.body, timestamp: new Date() }]
    };
    await db.collection('tickets').insertOne(ticket);
    await db.collection('conversations').updateOne({ userId: user.userId }, { $set: { state: 'in_support_conversation', 'data.ticketId': ticketId } });

    // Professional confirmation message for the user
    await sendMessageWithDelay(msg, `✅ Your support ticket has been created. Your Ticket ID is *${ticketId}*. An admin will review your message shortly.`);

    // Professional notification for admins
    const adminNotification = `*New Support Ticket* 🔔\n\n*From Brand:* ${user.brandName}\n*Ticket ID:* \`${ticketId}\`\n*User Message:* "${msg.body}"\n\n_Reply with: \`reply ${ticketId} [your message]\`_`;
    for (const admin of ADMIN_NUMBERS) {
        client.sendMessage(admin, adminNotification).catch(e => console.error(`Failed to send notification to admin ${admin}:`, e));
    }
};

const handleTicketResponse = async (msg, userSession) => {
    const db = getDB();
    const ticketId = userSession.data.ticketId;

    if (msg.body.toLowerCase() === 'close ticket') {
        await db.collection('tickets').updateOne({ _id: ticketId }, { $set: { status: 'closed_by_user' } });
        await db.collection('conversations').deleteOne({ userId: msg.from });
        // Professional closing message
        await sendMessageWithDelay(msg, "Your support ticket has been successfully closed. Please feel free to reach out again if you need anything else!");
    } else {
        await db.collection('tickets').updateOne(
            { _id: ticketId },
            { $push: { messages: { sender: 'user', text: msg.body, timestamp: new Date() } } }
        );
        await sendMessageWithDelay(msg, "Your message has been added to the ticket.");
    }
};

const handleAdminTicketsCommand = async (msg) => {
    const db = getDB();
    const openTickets = await db.collection('tickets').find({ status: 'open' }).toArray();
    if (openTickets.length === 0) {
        await msg.reply("There are no open support tickets.");
    } else {
        let reply = "*Open Support Tickets*\n\n";
        for (const ticket of openTickets) {
            reply += `*Brand:* ${ticket.brandName}\n*ID:* \`${ticket._id}\`\n*Last Msg:* "${ticket.messages[ticket.messages.length - 1].text}"\n-----------------\n`;
        }
        reply += "\nTo reply, use `reply [ID] [message]`";
        await msg.reply(reply);
    }
};

const handleAdminReplyCommand = async (msg, text, client) => {
    const db = getDB();
    const parts = text.split(' ');
    const ticketId = parts[1].toUpperCase(); // Ensure ID is uppercase to match generation
    const replyText = parts.slice(2).join(' ');

    if (!ticketId || !replyText) {
        await msg.reply("Invalid format. Use: `reply [ID] [message]`");
        return;
    }
    const ticket = await db.collection('tickets').findOne({ _id: ticketId });
    if (!ticket) {
        await msg.reply("Ticket not found.");
        return;
    }

    await db.collection('tickets').updateOne(
        { _id: ticketId },
        { $push: { messages: { sender: 'admin', text: replyText, timestamp: new Date() } } }
    );
    // Professional reply format for the user
    await client.sendMessage(ticket.userId, `An admin has replied to your ticket *${ticketId}*:\n\n${replyText}`);
    await msg.reply(`✅ Replied to ticket \`${ticketId}\`.`);
};

const handleAdminCloseCommand = async (msg, text, ADMIN_NUMBERS, client) => {
    const db = getDB();
    const ticketId = text.split(' ')[1].toUpperCase();
    if (!ticketId) {
        await msg.reply("Please provide a Ticket ID to close.");
        return;
    }
    const result = await db.collection('tickets').updateOne({ _id: ticketId }, { $set: { status: 'closed_by_admin' } });
    
    if (result.modifiedCount > 0) {
        await msg.reply(`✅ Ticket \`${ticketId}\` has been closed.`);
        // Notify other admins that the ticket is closed
        const closeNotification = `ℹ️ Ticket \`${ticketId}\` was closed by an admin.`;
        for (const admin of ADMIN_NUMBERS) {
            if (admin !== msg.from) { // Don't notify the admin who closed it
                client.sendMessage(admin, closeNotification).catch(e => console.error(`Failed to send close notification to admin ${admin}:`, e));
            }
        }
    } else {
        await msg.reply("Could not find or close that ticket.");
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
