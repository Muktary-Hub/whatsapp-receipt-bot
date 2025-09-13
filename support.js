const { getDB, ObjectId } = require('./db.js');
const { sendMessageWithDelay } = require('./helpers.js');

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
    const ticketId = new ObjectId();
    const ticket = {
        _id: ticketId,
        userId: user.userId,
        brandName: user.brandName,
        status: 'open',
        createdAt: new Date(),
        messages: [{ sender: 'user', text: msg.body, timestamp: new Date() }]
    };
    await db.collection('tickets').insertOne(ticket);
    await db.collection('conversations').updateOne({ userId: user.userId }, { $set: { state: 'in_support_conversation', 'data.ticketId': ticketId } });

    await sendMessageWithDelay(msg, `✅ Ticket created! An admin has been notified. You can continue sending messages here to add to this ticket.\n\nType *'close ticket'* when your issue is resolved.`);

    // Notify admins
    const adminNotification = `*New Support Ticket*\n\n*From:* ${user.brandName}\n*Ticket ID:* \`${ticketId}\`\n\n*Message:* ${msg.body}`;
    for (const admin of ADMIN_NUMBERS) {
        client.sendMessage(admin, adminNotification).catch(e => console.error(`Failed to send notification to admin ${admin}:`, e));
    }
};

const handleTicketResponse = async (msg, userSession) => {
    const db = getDB();
    const ticketId = userSession.data.ticketId;

    if (msg.body.toLowerCase() === 'close ticket') {
        await db.collection('tickets').updateOne({ _id: new ObjectId(ticketId) }, { $set: { status: 'closed_by_user' } });
        await db.collection('conversations').deleteOne({ userId: msg.from });
        await sendMessageWithDelay(msg, "Support ticket closed. Thank you!");
    } else {
        await db.collection('tickets').updateOne(
            { _id: new ObjectId(ticketId) },
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
    const ticketId = parts[1];
    const replyText = parts.slice(2).join(' ');

    if (!ObjectId.isValid(ticketId)) {
        await msg.reply("Invalid Ticket ID format.");
        return;
    }
    const ticket = await db.collection('tickets').findOne({ _id: new ObjectId(ticketId) });
    if (!ticket) {
        await msg.reply("Ticket not found.");
        return;
    }

    await db.collection('tickets').updateOne(
        { _id: new ObjectId(ticketId) },
        { $push: { messages: { sender: 'admin', text: replyText, timestamp: new Date() } } }
    );
    await client.sendMessage(ticket.userId, `*Admin Reply:*\n\n${replyText}`);
    await msg.reply(`✅ Replied to ticket \`${ticketId}\`.`);
};

const handleAdminCloseCommand = async (msg, text) => {
    const db = getDB();
    const ticketId = text.split(' ')[1];
    if (!ObjectId.isValid(ticketId)) {
        await msg.reply("Invalid Ticket ID format.");
        return;
    }
    const result = await db.collection('tickets').updateOne({ _id: new ObjectId(ticketId) }, { $set: { status: 'closed_by_admin' } });
    if (result.modifiedCount > 0) {
        await msg.reply(`✅ Ticket \`${ticketId}\` has been closed.`);
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
