import Notification from "../models/notification.model.js";
import User from "../models/user.model.js"
import Lead from "../models/leads.model.js";
import Deal from "../models/deals.model.js";
import Proposal from "../models/proposal.model.js"; 

export default {
  //Notification created for lead, deal and proposal
  createNotification: async (req, res) => {
    try {
      const {
        userId,
        title,
        message,
        type,
        relatedId,
        relatedModel,
        scheduledFor,
        read,
      } = req.body;

      const defaultTitle =
        title ||
        (type === "followup"
          ? relatedModel === "Deal"
            ? "Deal Follow-up"
            : relatedModel === "Proposal"
            ? "Proposal Follow-up"
            : relatedModel === "Lead"
            ? "Lead Follow-up"
            : "Follow-up"
          : type === "contact_form"
          ? "Website Contact Form"
          : "Notification");

      const textValue = message || defaultTitle;
      const followUpDate = req.body.followUpDate ? new Date(req.body.followUpDate) : null;

      const notification = await Notification.create({
        userId,
        title: defaultTitle,
        message: textValue,
        text: textValue,
        type,
        referenceId: relatedId ? String(relatedId) : null,
        followUpDate,
        meta: {
          dealId: relatedModel === "Deal" ? relatedId : undefined,
          leadId: relatedModel === "Lead" ? relatedId : undefined,
          proposalId: relatedModel === "Proposal" ? relatedId : undefined,
        },
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        read: read || false,
      });

      res.status(201).json(notification);
    } catch (err) {
      console.error("Create notification error:", err);
      res.status(500).json({ message: err.message });
    }
  },
  //admin and assigned user get the notification
  getUserNotifications: async (req, res) => {
    try {
      const { userId } = req.params;
      const now = new Date();

      // Delete expired notifications from database
      await Notification.deleteMany({
        userId,
        expiresAt: { $lt: now }
      });

      let notifications = await Notification.find({
        userId,
        $or: [
          { expiresAt: { $exists: false } },
          { expiresAt: { $gte: now } },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      // Enrich follow-up notifications with salesman profile image
      for (let notif of notifications) {
        if (notif.type === "followup" && notif.meta?.leadId) {
          const lead = await Lead.findById(notif.meta.leadId).populate(
            "assignTo",
            "profileImage firstName lastName"
          );

          if (lead?.assignTo) {
            notif.profileImage =
              lead.assignTo.profileImage?.replace(/\\/g, "/") || null;
            notif.userName = `${lead.assignTo.firstName} ${lead.assignTo.lastName}`;
          }
        } 
        // Handle deal followups
        else if (notif.type === "followup" && notif.meta?.dealId) {
          const deal = await Deal.findById(notif.meta.dealId)
            .populate("assignedTo", "profileImage firstName lastName");

          if (deal?.assignedTo) {
            notif.profileImage =
              deal.assignedTo.profileImage?.replace(/\\/g, "/") || null;
            notif.userName =
              `${deal.assignedTo.firstName} ${deal.assignedTo.lastName}`;
          }
        }
        // Handle proposal followups
        else if (notif.type === "followup" && notif.meta?.proposalId) {
          const proposal = await Proposal.findById(notif.meta.proposalId)
            .populate({
              path: "deal",
              populate: { path: "assignedTo", select: "profileImage firstName lastName" }
            });

          if (proposal?.deal?.assignedTo) {
            notif.profileImage = proposal.deal.assignedTo.profileImage?.replace(/\\/g, "/") || null;
            notif.userName = `${proposal.deal.assignedTo.firstName} ${proposal.deal.assignedTo.lastName}`;
          }
        }
      }
      
      res.status(200).json(notifications);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  },
  //mark as read for notification
  markAsRead: async (req, res) => {
    try {
      const { id } = req.params;
      const notif = await Notification.findByIdAndUpdate(id, { read: true }, { new: true });
      if (!notif) return res.status(404).json({ message: "Notification not found" });
      res.status(200).json({ message: "Notification marked as read", notif });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
  //delete the notification
  deleteNotification: async (req, res) => {
    try {
      const { id } = req.params;
      const notif = await Notification.findByIdAndDelete(id);

      if (!notif) {
        return res.status(404).json({ message: "Not found" });
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
  // Bulk delete notifications
  bulkDeleteNotifications: async (req, res) => {
    try {
      const { ids } = req.body; // array of notification IDs
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "No IDs provided" });
      }
      await Notification.deleteMany({ _id: { $in: ids } });
      res.status(200).json({ success: true, deletedCount: ids.length });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
};