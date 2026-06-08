import cron from "node-cron";
import Deal from "../models/deals.model.js";
import Lead from "../models/leads.model.js";
import Proposal from "../models/proposal.model.js";
import Notification from "../models/notification.model.js";
import User from "../models/user.model.js";
import Role from "../models/role.model.js";
import { sendNotification } from "../services/notificationService.js";
import mongoose from "mongoose";

// Track if cron is already running
let isCronRunning = false;

// Function to check database connection
const checkDbConnection = () => {
  if (mongoose.connection.readyState !== 1) {
    console.log(" MongoDB not connected, skipping cron run");
    return false;
  }
  return true;
};

const getAdminUserIds = async () => {
  try {
    const adminRole = await Role.findOne({ name: "Admin" }).lean();
    if (!adminRole) return [];
    const admins = await User.find({ role: adminRole._id, status: "Active" }).select("_id").lean();
    return admins.map((u) => String(u._id));
  } catch (err) {
    console.error("❌ Failed to fetch admin users:", err.message);
    return [];
  }
};

// Main cron function with error handling
const runNotificationCron = async () => {
  // Prevent concurrent runs
  if (isCronRunning) {
    console.log("⏳ Cron already running, skipping this cycle");
    return;
  }

  // Check database connection
  if (!checkDbConnection()) {
    return;
  }

  isCronRunning = true;
  const startTime = Date.now();

  try {
    console.log("═══════════════════════════════════════");
    console.log(` Notification Cron Started: ${new Date().toISOString()}`);
    console.log("═══════════════════════════════════════");

    const now = new Date();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const expiredResult = await Notification.deleteMany({ expiresAt: { $lte: now } });
    if (expiredResult.deletedCount > 0) {
      console.log(`🗑️ Auto-deleted ${expiredResult.deletedCount} expired notification(s)`);
    }

    const adminIds = await getAdminUserIds();
    if (adminIds.length > 0) {
      console.log(`🔔 Found ${adminIds.length} active admin(s) to notify`);
    }

    // ==================== DEALS ====================
    try {
      console.log("\n Processing DEALS...");
      
      const dueDeals = await Deal.find({
        followUpDate: { $lte: now },
        stage: { $nin: ["Closed Won", "Closed Lost"] },
        $or: [
          { lastReminderAt: { $exists: false } },
          { lastReminderAt: null },
          { lastReminderAt: { $lt: todayStart } }
        ]
      }).populate("assignedTo", "_id firstName lastName email profileImage");

      console.log(` Found ${dueDeals.length} due deals`);

      for (const deal of dueDeals) {
        try {
          if (deal.assignedTo?._id) {
            console.log(`   → Processing deal: ${deal.dealName}, Assigned to: ${deal.assignedTo.firstName || deal.assignedTo._id}`);
            
            await sendNotification(
              deal.assignedTo._id,
              `Deal follow-up due: ${deal.dealName || "Unnamed"}`,
              "followup",
              {
                dealId: deal._id,
                dealName: deal.dealName,
                profileImage: deal.assignedTo?.profileImage
              },
              {
                title: "Deal Follow-up",
                followUpDate: deal.followUpDate,
              }
            );

            for (const adminId of adminIds) {
              if (String(adminId) !== String(deal.assignedTo._id)) {
                await sendNotification(
                  adminId,
                  `Deal follow-up due: ${deal.dealName || "Unnamed"}`,
                  "followup",
                  {
                    dealId: deal._id,
                    dealName: deal.dealName,
                    profileImage: deal.assignedTo?.profileImage,
                  },
                  {
                    title: "Deal Follow-up",
                    followUpDate: deal.followUpDate,
                  }
                );
              }
            }
            
            deal.lastReminderAt = new Date();
            await deal.save();
            console.log(`    Notification sent for deal: ${deal.dealName}`);
          } else {
            console.log(`    Deal ${deal.dealName} has no assigned user`);
          }
        } catch (dealError) {
          console.error(`    Error processing deal ${deal._id}:`, dealError.message);
        }
      }
    } catch (dealError) {
      console.error(" Error in deals section:", dealError.message);
    }

    // ==================== LEADS ====================
    try {
      console.log("\n Processing LEADS...");
      
      const dueLeads = await Lead.find({
        followUpDate: { $lte: now },
        status: { $nin: ["Converted", "Junk"] },
        $or: [
          { lastReminderAt: { $exists: false } },
          { lastReminderAt: null },
          { lastReminderAt: { $lt: todayStart } }
        ]
      }).populate("assignTo", "_id firstName lastName email profileImage");

      console.log(` Found ${dueLeads.length} due leads`);

      for (const lead of dueLeads) {
        try {
          if (lead.assignTo?._id) {
            console.log(`   → Processing lead: ${lead.leadName}, Assigned to: ${lead.assignTo.firstName || lead.assignTo._id}`);
            
            await sendNotification(
              lead.assignTo._id,
              `Lead follow-up due: ${lead.leadName || "Unnamed"}`,
              "followup",
              {
                leadId: lead._id,
                leadName: lead.leadName,
                profileImage: lead.assignTo?.profileImage
              },
              {
                title: "Lead Follow-up",
                followUpDate: lead.followUpDate,
              }
            );
            
            lead.lastReminderAt = new Date();
            await lead.save();
            console.log(`    Notification sent for lead: ${lead.leadName}`);
          } else {
            console.log(`    Lead ${lead.leadName} has no assigned user`);
          }
        } catch (leadError) {
          console.error(`    Error processing lead ${lead._id}:`, leadError.message);
        }
      }
    } catch (leadError) {
      console.error(" Error in leads section:", leadError.message);
    }

    // ==================== PROPOSALS ====================
    try {
      console.log("\n Processing PROPOSALS...");
      
      const dueProposals = await Proposal.find({
        followUpDate: { $lte: now },
        status: { $nin: ["success", "rejection"] },
        $or: [
          { lastReminderAt: { $exists: false } },
          { lastReminderAt: null },
          { lastReminderAt: { $lt: todayStart } }
        ]
      }).populate({
        path: "deal",
        populate: { path: "assignedTo", select: "_id firstName lastName email profileImage" }
      });

      console.log(` Found ${dueProposals.length} due proposals`);

      for (const proposal of dueProposals) {
        try {
          const assignedTo = proposal.deal?.assignedTo;
          if (assignedTo?._id) {
            console.log(`   → Processing proposal: ${proposal.title}, Assigned to: ${assignedTo.firstName || assignedTo._id}`);
            
            await sendNotification(
              assignedTo._id,
              `Proposal follow-up due: ${proposal.title || "Unnamed"}`,
              "followup",
              {
                proposalId: proposal._id,
                proposalTitle: proposal.title,
                dealId: proposal.deal?._id,
                profileImage: assignedTo?.profileImage
              },
              {
                title: "Proposal Follow-up",
                followUpDate: proposal.followUpDate,
              }
            );

            for (const adminId of adminIds) {
              if (String(adminId) !== String(assignedTo._id)) {
                await sendNotification(
                  adminId,
                  `Proposal follow-up due: ${proposal.title || "Unnamed"}`,
                  "followup",
                  {
                    proposalId: proposal._id,
                    proposalTitle: proposal.title,
                    dealId: proposal.deal?._id,
                    profileImage: assignedTo?.profileImage,
                  },
                  {
                    title: "Proposal Follow-up",
                    followUpDate: proposal.followUpDate,
                  }
                );
              }
            }
            
            proposal.lastReminderAt = new Date();
            await proposal.save();
            console.log(`    Notification sent for proposal: ${proposal.title}`);
          } else {
            console.log(`    Proposal ${proposal.title} has no assigned user (no deal or no assignedTo)`);
          }
        } catch (proposalError) {
          console.error(`    Error processing proposal ${proposal._id}:`, proposalError.message);
        }
      }
    } catch (proposalError) {
      console.error(" Error in proposals section:", proposalError.message);
    }

    const duration = Date.now() - startTime;
    console.log("\n═══════════════════════════════════════");
    console.log(` Notification Cron Completed in ${duration}ms`);
    console.log("═══════════════════════════════════════\n");

  } catch (error) {
    console.error(" FATAL CRON ERROR:", error);
    console.error("Error stack:", error.stack);
  } finally {
    isCronRunning = false;
  }
};

// ==================== START CRON ====================
let cronTask = null;

export const startCron = () => {
  // Stop existing cron if any
  if (cronTask) {
    cronTask.stop();
    console.log(" Stopped existing cron task");
  }

  // Start new cron - runs every minute
  cronTask = cron.schedule("*/1 * * * *", async () => {
    try {
      await runNotificationCron();
    } catch (err) {
      console.error(" Cron execution error:", err);
    }
  });

  console.log(" Notification Cron started - running every minute");
  console.log(` Current server time: ${new Date().toISOString()}`);
};

// Auto-start when imported
startCron();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log("\n Shutting down cron...");
  if (cronTask) {
    cronTask.stop();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log("\n Shutting down cron...");
  if (cronTask) {
    cronTask.stop();
  }
  process.exit(0);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error(' Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error(' Uncaught Exception:', error);
});

export { runNotificationCron };