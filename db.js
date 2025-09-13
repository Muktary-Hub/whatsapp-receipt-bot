const { MongoClient, ObjectId } = require('mongodb');
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = 'receiptBot';

let db;

const connectToDB = async () => {
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

const getDB = () => db;

module.exports = { connectToDB, getDB, ObjectId };
