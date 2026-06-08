import cron         from "node-cron";
import Lead         from "../models/leads.model.js";
import User         from "../models/user.model.js";
import Role         from "../models/role.model.js";
import Notification from "../models/notification.model.js";
import { sendNotification } from "../services/notificationService.js";

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
// Get all admin user IDs for sending missed follow-up notifications
const getAdminUserIds = async () => {
  const adminRole = await Role.findOne({ name: "Admin" });
  if (!adminRole) return [];
  const admins = await User.find({ role: adminRole._id }, "_id");
  return admins.map((a) => a._id.toString());
};
// Check if a follow-up notification was already sent within cooldown period
const notificationExists = async (userId, leadId) => {
  const cutoff = new Date(Date.now() - COOLDOWN_MS);
  const existing = await Notification.findOne({
    userId,
    type:          "followup",
    "meta.leadId": leadId,
    createdAt:     { $gte: cutoff },
  });
  return !!existing;
};

export function startFollowUpCron() {
  //cron job-to check
  cron.schedule("* * * * *", async () => {
    const now        = new Date();
    const bufferNow  = new Date(now.getTime() + 5 * 60 * 1000);
    const cooldownCutoff = new Date(now.getTime() - COOLDOWN_MS);

    console.log(" FollowUp Cron:", now.toISOString());

    try {
      const dueLeads = await Lead.find({
        followUpDate: { $lte: bufferNow },
        status:       { $in: ["Hot", "Warm", "Cold"] },
        $or: [
          { lastReminderAt: { $exists: false } },
          { lastReminderAt: null },
          { lastReminderAt: { $lt: cooldownCutoff } },
        ],
      }).populate("assignTo", "firstName lastName email _id");

      console.log(` Due leads: ${dueLeads.length}`);
      if (!dueLeads.length) return;

      const admins = await getAdminUserIds();

      for (const lead of dueLeads) {
        const assignUserId = lead.assignTo?._id?.toString();
        const leadId       = lead._id.toString();
        const leadName     = lead.leadName || "Unnamed Lead";

        // Notify salesman
        if (assignUserId) {
          const alreadySent = await notificationExists(assignUserId, leadId);
          if (!alreadySent) {
            await sendNotification(
              assignUserId,
              ` You missed a follow-up for Lead: ${leadName}`,
              "followup",
              { leadId }
            );
          }
        }

        // Notify admins
        for (const adminId of admins) {
          const alreadySent = await notificationExists(adminId, leadId);
          if (!alreadySent) {
            await sendNotification(
              adminId,
              `Salesman ${lead.assignTo?.firstName || "Unknown"} missed follow-up for Lead: ${leadName}`,
              "followup",
              { leadId, salesman: lead.assignTo?.firstName || "Unknown", salesmanId: assignUserId }
            );
          }
        }

        
        // lead.save() triggers full Mongoose validation — if the lead was
        // created before the 'destination' field was added (required: true),
        // it fails with "destination: Path required" and crashes the cron.
        // updateOne bypasses schema validation for fields we are NOT changing.
        await Lead.updateOne(
          { _id: lead._id },
          { $set: { lastReminderAt: now } }
        );

        console.log(` Stamped lastReminderAt for "${leadName}"`);
      }

    } catch (err) {
      console.error(" FollowUp cron error:", err.message);
    }
  });

  // Purge expired notifications every hour
  cron.schedule("0 * * * *", async () => {
    try {
      const result = await Notification.deleteMany({
        expiresAt: { $lte: new Date() },
      });
      console.log(" Expired notifications deleted:", result.deletedCount);
    } catch (err) {
      console.error(" Notification cleanup error:", err.message);
    }
  });
}