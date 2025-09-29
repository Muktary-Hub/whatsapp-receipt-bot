// db.js (Final Corrected Version for ES Modules)

import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = 'receiptBot';

let db;

// Add 'export' before the function
export const connectToDB = async () => {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db(DB_NAME);
        console.log('Successfully connected to MongoDB.');
    } catch (error) {
        console.error('Failed to connect to MongoDB', error);
        process.exit(1);
    }
};

// Add 'export' before the function
export const getDB = () => db;

// We also need to export ObjectId separately
export { ObjectId };
