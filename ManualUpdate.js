// manualUpdate.js
const { connectToDB, getDB } = require('./db.js');

// --- !!! IMPORTANT: CHANGE THIS LINE !!! ---
const userIdToUpdate = '2348134167379@c.us'; 
// For example: '2348141234567@c.us'
// ------------------------------------------

async function updateUser() {
  if (userIdToUpdate === 'PASTE_USER_WHATSAPP_ID_HERE@c.us') {
    console.error(">>> ERROR: Please edit the 'userIdToUpdate' variable in the manualUpdate.js file before running.");
    process.exit(1);
  }

  try {
    console.log('>>> Connecting to database...');
    await connectToDB();
    const db = getDB();
    const usersCollection = db.collection('users');

    // Set the expiry date to 6 months from today
    const newExpiryDate = new Date();
    newExpiryDate.setMonth(newExpiryDate.getMonth() + 6);

    console.log(`>>> Updating user: ${userIdToUpdate}`);
    const result = await usersCollection.updateOne(
      { userId: userIdToUpdate }, // The filter to find the user
      {
        $set: { // The fields to update
          isPaid: true,
          subscriptionExpiryDate: newExpiryDate
        }
      }
    );

    if (result.matchedCount === 0) {
      console.log('>>> ❌ UPDATE FAILED: No user was found with that ID.');
    } else {
      console.log('>>> ✅ SUCCESS! The user has been updated.');
    }

  } catch (error) {
    console.error('>>> An error occurred:', error);
  } finally {
    // End the script
    console.log('>>> Update script finished.');
    process.exit();
  }
}

updateUser();
