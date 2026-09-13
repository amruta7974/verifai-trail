import { MongoClient } from "mongodb";

// Serverless functions can be invoked many times per second, each a fresh
// process (or a reused warm one). Opening a new MongoClient per request
// would exhaust connections fast. This caches the client on the module
// scope, which survives across invocations on a warm instance, and is
// the pattern MongoDB's own Vercel/serverless docs recommend.
let cachedClient = null;
let cachedDb = null;

export async function getDb() {
  if (cachedDb) return cachedDb;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Add it in your Vercel project's Environment Variables " +
        "(or a local .env file for `npm run dev`)."
    );
  }

  const client = new MongoClient(uri, { maxPoolSize: 10 });
  await client.connect();
  cachedClient = client;
  cachedDb = client.db(process.env.MONGODB_DB || "verifai_trail");
  return cachedDb;
}
