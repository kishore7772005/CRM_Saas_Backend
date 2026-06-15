import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema(
  {
    companyName: { type: String, default: "My Company" },
    logo:        { type: String, default: null },
    favicon:     { type: String, default: null },
    invoiceLogo: { type: String, default: null },
    defaultFromEmail: { type: String, default: "" },
    defaultToEmail: { type: String, default: "" },
  },
  { timestamps: true }
);

export default settingsSchema;
