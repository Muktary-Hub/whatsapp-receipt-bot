import { MongoClient } from 'mongodb';
import axios from 'axios';

// --- CONFIGURATION ---
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = 'receiptBot';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// A simple delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- MAIN BROADCAST FUNCTION ---
async function runBroadcast() {
  const client = new MongoClient(MONGO_URI);
  console.log('Starting broadcast script...');

  try {
    await client.connect();
    const db = client.db(DB_NAME);
    console.log('Successfully connected to MongoDB.');

    // --- TARGETING LOGIC ---
    // Find all users who are paid OR are in the admin list
    const adminNumbers = ['2347016370068', '2348146817448'];
    const query = {
      $or: [
        { isPaid: true },
        { userId: { $in: adminNumbers } }
      ]
    };
    
    const targetUsers = await db.collection('users').find(query).toArray();
    console.log(`Found ${targetUsers.length} users to message (paid subscribers and admins).`);

    if (targetUsers.length === 0) {
      console.log('No target users found. Exiting.');
      return;
    }

    // --- SENDING LOGIC ---
    let successCount = 0;
    for (const user of targetUsers) {
      const userPhoneNumber = user.userId;
      
      console.log(`Sending template to ${userPhoneNumber}...`);

      try {
        await axios.post(
          `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            to: userPhoneNumber,
            type: 'template',
            template: {
              // !!! IMPORTANT: REPLACE THIS WITH YOUR TEMPLATE NAME !!!
              name: 'bot_competitor_ad_v1', 
              language: { code: 'en_US' }
            }
          },
          { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
        );
        successCount++;
        console.log(`  ...Success!`);
      } catch (error) {
        console.error(`  ...Failed to send to ${userPhoneNumber}:`, error.response?.data || error.message);
      }
      
      // Wait for 2 seconds before sending the next message to avoid rate limits
      await delay(2000); 
    }

    console.log(`\nBroadcast complete. Sent ${successCount} out of ${targetUsers.length} messages.`);

  } catch (err) {
    console.error('An error occurred during the broadcast:', err);
  } finally {
    await client.close();
    console.log('MongoDB connection closed.');
  }
}

runBroadcast();
