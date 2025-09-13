const getRandomReply = (replies) => {
    return replies[Math.floor(Math.random() * replies.length)];
};

const sendMessageWithDelay = (msg, text) => {
    const delay = Math.floor(Math.random() * 800) + 1200; // Delay between 1.2 and 2 seconds
    return new Promise(resolve => setTimeout(() => msg.reply(text).then(resolve), delay));
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
