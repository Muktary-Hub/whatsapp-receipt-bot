import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = 'receiptBot';

let db;

export async function connectToDB() {
    try {
        const mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        console.log('Successfully connected to MongoDB.');
    } catch (error) {
        console.error('Failed to connect to MongoDB', error);
        process.exit(1);
    }
}

export function getDB() {
    return db;
}

export { ObjectId };
