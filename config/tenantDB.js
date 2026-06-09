import mongoose from "mongoose";
import dotenv from "dotenv";
import { registerTenantModels } from "../models/tenant/index.js";

dotenv.config();

// One Mongoose connection per tenant DB, reused across requests
const connectionPool = new Map();

export async function getTenantDB(dbName) {
  if (connectionPool.has(dbName)) {
    return connectionPool.get(dbName);
  }

  const baseUri =
    process.env.MONGO_BASE_URI ||
    (process.env.MONGO_URL || "mongodb://localhost:27017").replace(/\/[^/]*$/, "");

  const conn = await mongoose
    .createConnection(`${baseUri}/${dbName}`)
    .asPromise();

  registerTenantModels(conn);
  connectionPool.set(dbName, conn);
  console.log(`Tenant DB connected: ${dbName}`);
  return conn;
}
