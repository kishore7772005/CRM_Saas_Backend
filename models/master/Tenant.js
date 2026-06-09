import mongoose from "mongoose";
import { masterConn } from "../../config/masterDB.js";

const tenantSchema = new mongoose.Schema(
  {
    name:       { type: String, required: true, trim: true },
    slug:       { type: String, required: true, unique: true, lowercase: true, trim: true },
    dbName:     { type: String, required: true, unique: true, trim: true },
    adminEmail: { type: String, required: true, lowercase: true, trim: true },
    adminName:  { type: String, required: true, trim: true },
    isActive:   { type: Boolean, default: true },
    createdBy:  { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

const Tenant = masterConn.model("Tenant", tenantSchema);
export default Tenant;
