import { getDB, ObjectId } from './db.js';
import { sendMessageWithDelay, getRandomReply } from './helpers.js';

// --- USER-FACING FUNCTIONS ---

/**
 * Handles the initial `support` command from a user.
 * Checks for an existing open ticket before creating a new one.
 */
export async function handleSupportCommand(msg, senderId) {
    const db = getDB();
    const existingTicket = await db.collection('tickets').findOne({ userId: senderId, status: 'Open' });

    if (existingTicket) {
        await sendMessageWithDelay(msg, `You already have an open support ticket (#${existingTicket.ticketId}).\n\nAny messages you send now will be added to this ticket. Type *'cancel'* to exit support mode.`);
        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'in_support_conversation', data: { ticketId: existingTicket.ticketId } } }, { upsert: true });
    } else {
        await sendMessageWithDelay(msg, "You are about to create a new support ticket. Please describe your issue in your next message. Be as detailed as possible.");
        await db.collection('conversations').updateOne({ userId: senderId }, { $set: { state: 'awaiting_support_message' } }, { upsert: true });
    }
}

/**
 * Creates a new ticket after a user sends their problem description.
 */
export async function handleNewTicket(msg, user, client, adminNumbers) {
    const db = getDB();
    const ticketId = `SR-${Date.now().toString().slice(-6)}`;
    const userMessage = {
        sender: 'user',
        message: msg.body,
        timestamp: new Date()
    };

    const newTicket = {
        ticketId,
        userId: user.userId,
        brandName: user.brandName,
        status: 'Open',
        createdAt: new Date(),
        conversation: [userMessage]
    };

    await db.collection('tickets').insertOne(newTicket);
    await sendMessageWithDelay(msg, `Thank you! Your support ticket **#${ticketId}** has been created.\n\nOur team will review your issue and reply here shortly.`);
    
    // Notify all admins
    const notificationMessage = `🔔 *New Support Ticket #${ticketId}* from *${user.brandName}* (${user.userId.split('@')[0]}):\n\n_"${msg.body}"_`;
    for (const admin of adminNumbers) {
        client.sendMessage(admin, notificationMessage);
    }
    
    await db.collection('conversations').updateOne({ userId: user.userId }, { $set: { state: 'in_support_conversation', data: { ticketId: ticketId } } });
}

/**
 * Handles subsequent replies from a user to their open ticket.
 */
export async function handleTicketResponse(msg, userSession) {
    const db = getDB();
    const ticketId = userSession.data.ticketId;
    const userMessage = {
        sender: 'user',
        message: msg.body,
        timestamp: new Date()
    };

    await db.collection('tickets').updateOne({ ticketId }, { $push: { conversation: userMessage } });
    await sendMessageWithDelay(msg, "Your reply has been added to the ticket. We will get back to you soon.");
}


// --- ADMIN-FACING FUNCTIONS ---

/**
 * Allows an admin to see a list of all open tickets.
 */
export async function handleAdminTicketsCommand(msg) {
    const db = getDB();
    const openTickets = await db.collection('tickets').find({ status: 'Open' }).sort({ createdAt: 1 }).toArray();

    if (openTickets.length === 0) {
        await sendMessageWithDelay(msg, "There are currently no open support tickets.");
        return;
    }

    let response = "🎫 *Open Support Tickets*\n\n";
    openTickets.forEach((ticket, index) => {
        response += `*${index + 1}. Ticket #${ticket.ticketId}* from *${ticket.brandName}*\n`;
        response += `   Last message: _"${ticket.conversation[ticket.conversation.length - 1].message}"_\n\n`;
    });
    response += "To reply to a ticket, use the command:\n`reply [TicketID] [your message]`";

    await msg.reply(response);
}

/**
 * Allows an admin to reply to a specific ticket.
 */
export async function handleAdminReplyCommand(msg, text, client) {
    const db = getDB();
    const parts = text.split(' ');
    const ticketIdToReply = parts[1];
    const replyMessage = parts.slice(2).join(' ');

    if (!ticketIdToReply || !replyMessage) {
        await sendMessageWithDelay(msg, "Invalid format. Please use:\n`reply [TicketID] [your message]`");
        return;
    }

    const ticket = await db.collection('tickets').findOne({ ticketId: { $regex: new RegExp(ticketIdToReply, 'i') } });

    if (!ticket) {
        await sendMessageWithDelay(msg, `Sorry, I could not find a ticket with the ID "${ticketIdToReply}".`);
        return;
    }

    const adminMessage = {
        sender: 'admin',
        message: replyMessage,
        timestamp: new Date()
    };
    
    await db.collection('tickets').updateOne({ _id: ticket._id }, { $push: { conversation: adminMessage } });
    
    const messageToUser = `💬 *Reply from Customer Support (Ticket #${ticket.ticketId}):*\n\n${replyMessage}`;
    await client.sendMessage(ticket.userId, messageToUser);

    await sendMessageWithDelay(msg, `✅ Your reply has been sent to *${ticket.brandName}*.`);
}

/**
 * Allows an admin to close a resolved ticket.
 */
export async function handleAdminCloseCommand(msg, text) {
    const db = getDB();
    const ticketIdToClose = text.split(' ')[1];
    
    if (!ticketIdToClose) {
        await sendMessageWithDelay(msg, "Invalid format. Please use: `close [TicketID]`");
        return;
    }

    const result = await db.collection('tickets').findOneAndUpdate(
        { ticketId: { $regex: new RegExp(ticketIdToClose, 'i') }, status: 'Open' },
        { $set: { status: 'Closed' } }
    );
    
    const ticket = result.value;

    if (!ticket) {
        await sendMessageWithDelay(msg, `Could not find an open ticket with the ID "${ticketIdToClose}". It might already be closed.`);
        return;
    }

    const messageToUser = `✅ Your support ticket **#${ticket.ticketId}** has been marked as resolved and closed. If you have any other questions, feel free to open a new one with the 'support' command.`;
    await msg.client.sendMessage(ticket.userId, messageToUser);
    
    await db.collection('conversations').deleteOne({ userId: ticket.userId });

    await sendMessageWithDelay(msg, `Ticket **#${ticket.ticketId}** for *${ticket.brandName}* has been successfully closed.`);
}
