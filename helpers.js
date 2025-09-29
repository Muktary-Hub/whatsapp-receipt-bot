// helpers.js

const getRandomReply = (replies) => {
    return replies[Math.floor(Math.random() * replies.length)];
};

/**
 * --- UPDATED FOR BAILEYS ---
 * This function is now compatible with Baileys.
 * It takes the socket instance (sock) and the chat ID (jid) instead of the old 'msg' object.
 * It uses sock.sendMessage() instead of the old msg.reply().
 * @param {object} sock - The Baileys socket instance.
 * @param {string} jid - The user's chat ID (e.g., '234xxxxxxxxxx@c.us').
 * @param {string} text - The text message to send.
 */
const sendMessageWithDelay = (sock, jid, text) => {
    const delay = Math.floor(Math.random() * 800) + 1200; // Delay between 1.2 and 2 seconds
    return new Promise(resolve => setTimeout(() => {
        sock.sendMessage(jid, { text: text }).then(resolve);
    }, delay));
};

const isSubscriptionActive = (user, ADMIN_NUMBERS) => {
    if (!user) return false;
    if (ADMIN_NUMBERS.includes(user.userId)) return true;
    if (!user.isPaid || !user.subscriptionExpiryDate) {
        return false;
    }
    return new Date() < new Date(user.subscriptionExpiryDate);
};

module.exports = { getRandomReply, sendMessageWithDelay, isSubscriptionActive };
