export function sendMessageWithDelay(msg, text) {
    const delay = Math.floor(Math.random() * 1000) + 1500;
    return new Promise(resolve => setTimeout(() => msg.reply(text).then(resolve), delay));
}

export function getRandomReply(replies) {
    const randomIndex = Math.floor(Math.random() * replies.length);
    return replies[randomIndex];
}

export function isSubscriptionActive(user, adminNumbers) {
    if (!user) return false;
    if (adminNumbers.includes(user.userId)) return true;
    if (!user.isPaid || !user.subscriptionExpiryDate) {
        return false;
    }
    return new Date() < new Date(user.subscriptionExpiryDate);
}
