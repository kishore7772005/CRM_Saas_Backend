import Deal from "../models/deals.model.js";
import Lead from "../models/leads.model.js";
import sendEmail from "../services/email.js";
import { notifyUser } from "../realtime/socket.js";
import clientLTVController from "./clientLTVController.js";
import Notification from "../models/notification.model.js";
import {
  deleteNotificationsByEntity,
  deleteAllNotificationsByEntity,
  sendNotification,
  sendNotificationToAdmins,
} from "../services/notificationService.js";

// Helper: convert a multer file object → attachment schema object
const mapFileToAttachment = (file) => ({
  name: file.originalname,
  path: file.path.replace(/\\/g, "/").replace(/^\/+/, ""),
  type: file.mimetype,
  size: file.size,
  uploadedAt: new Date(),
});

// Helper: normalize any attachment to object form
const normalizeAttachment = (att) => {
  if (!att) return null;
  if (typeof att === "string") {
    const cleanPath = att.replace(/^\/+/, "");
    return {
      name: cleanPath.split("/").pop() || "file",
      path: cleanPath,
      type: "application/octet-stream",
      size: 0,
      uploadedAt: new Date(),
    };
  }
  return {
    _id: att._id,
    name: att.name || att.path?.split("/").pop() || "file",
    path: (att.path || "").replace(/^\/+/, ""),
    type: att.type || "application/octet-stream",
    size: att.size || 0,
    uploadedAt: att.uploadedAt || new Date(),
  };
};

// Helper: format deal value as "1,00,000 INR"
const formatDealValue = (dealValue, currency = "INR") => {
  const numeric = Number(String(dealValue).replace(/,/g, ""));
  if (isNaN(numeric)) return "0";
  return `${new Intl.NumberFormat("en-IN").format(numeric)} ${currency}`;
};

export default {
  // 1. Convert Lead → Deal
  createDealFromLead: async (req, res) => {
    try {
      const lead = await Lead.findById(req.params.leadId).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      if (lead.status === "Converted")
        return res.status(400).json({ message: "Lead already converted" });

      lead.status = "Converted";
      lead.followUpDate = null;
      lead.lastReminderAt = null;
      await lead.save();

      const deal = new Deal({
        leadId: lead._id,
        dealName: lead.leadName,
        assignedTo: lead.assignTo?._id,
        stage: "Qualification",
        value: "0",
        destination: lead.destination || "",
        duration: lead.duration || "",
        clientType: lead.clientType || null,
      });
      await deal.save();

      res.status(200).json({ message: "Lead converted to deal", deal });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },

  // 2. Create Manual Deal
  createManualDeal: async (req, res) => {
    try {
      const {
        dealName,
        assignTo,
        dealValue,
        currency,
        stage,
        notes,
        phoneNumber,
        email,
        source,
        companyName,
        companyId,
        industry,
        requirement,
        address,
        country,
        followUpDate,
        followUpComment,
        lossReason,
        lossNotes,
        clientType,
      } = req.body;

      if (!dealName || !phoneNumber || !companyName) {
        return res.status(400).json({
          message: "dealName, phoneNumber & companyName are required",
        });
      }

      const allowedStages = [
        "Qualification",
        "Proposal Sent-Negotiation",
        "Invoice Sent",
        "Closed Won",
        "Closed Lost",
      ];
      const dealStage = stage && allowedStages.includes(stage) ? stage : "Qualification";

      const formattedValue = dealValue && String(dealValue).trim() !== ""
        ? formatDealValue(dealValue, currency || "INR")
        : "0";

      let parsedFollowUpDate = null;
      let followUpHistory = [];

      if (followUpDate) {
        parsedFollowUpDate = new Date(followUpDate);
        if (isNaN(parsedFollowUpDate.getTime())) {
          return res.status(400).json({
            message: "Invalid follow-up date format"
          });
        }

        followUpHistory = [{
          date: new Date(),
          followUpDate: parsedFollowUpDate,
          followUpComment: followUpComment || "",
          changedBy: req.user._id,
          action: "Created"
        }];
      }

      const attachments = (req.files || []).map(mapFileToAttachment);

      const deal = new Deal({
        dealName,
        assignedTo: assignTo || null,
        value: formattedValue,
        currency: currency || "INR",
        stage: dealStage,
        notes: notes || "",
        phoneNumber,
        email: email || "",
        source: source || "",
        companyName: companyName || "",
        companyId: companyId || null,
        industry: industry || "",
        requirement: requirement || "",
        address: address || "",
        country: country || "",
        clientType: clientType || null,
        followUpDate: parsedFollowUpDate,
        followUpComment: followUpComment || "",
        followUpHistory,
        lossReason: lossReason || "",
        lossNotes: lossNotes || "",
        attachments,
      });

      await deal.save();

      if (parsedFollowUpDate) {
        const assignedUserId = assignTo || null;

        if (assignedUserId) {
          await sendNotification(
            assignedUserId,
            `Deal follow-up scheduled: ${deal.dealName}`,
            "followup",
            {
              dealId: deal._id,
              dealName: deal.dealName,
              profileImage: null,
            },
            {
              title: "Deal Follow-up",
              followUpDate: deal.followUpDate,
            }
          );
        }

        await sendNotificationToAdmins(
          `Deal follow-up scheduled: ${deal.dealName}`,
          "followup",
          {
            dealId: deal._id,
            dealName: deal.dealName,
            profileImage: null,
          },
          {
            title: "Deal Follow-up",
            followUpDate: deal.followUpDate,
          },
          assignedUserId ? [assignedUserId] : []
        );
      }

      res.status(201).json({ message: "Manual deal created", deal });
    } catch (err) {
      console.error("Error creating manual deal:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // 3. Get All Deals
  getAllDeals: async (req, res) => {
    try {
      let query = {};

      if (req.user.role.name !== "Admin") {
        query.assignedTo = req.user._id;
      }

      const { start, end } = req.query;
      if (start && end) {
        query.createdAt = {
          $gte: new Date(start),
          $lte: new Date(end + "T23:59:59.999Z"),
        };
      }

      const deals = await Deal.find(query)
        .populate("assignedTo", "firstName lastName email")
        .sort({ createdAt: -1 });

      res.status(200).json(deals);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    }
  },

  // 4. Get Deal By ID
  getDealById: async (req, res) => {
    try {
      const dealId = req.params.id;

      const deal = await Deal.findById(dealId)
        .populate("assignedTo", "firstName lastName email")
        .populate("followUpHistory.changedBy", "firstName lastName email")
        .populate({
          path: "leadId",
          populate: {
            path: "assignTo",
            select: "firstName lastName email"
          }
        });

      if (!deal) {
        return res.status(404).json({ message: "Deal not found" });
      }

      if (req.user.role.name !== "Admin" && deal.assignedTo && deal.assignedTo._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied: You can only view deals assigned to you" });
      }

      let leadAttachments = [];
      if (deal.leadId && deal.leadId.attachments) {
        leadAttachments = deal.leadId.attachments;
      }

      const allAttachments = [
  ...leadAttachments.map(att => ({
    name: typeof att === "string" ? att.split("/").pop() : (att.name || att.path?.split("/").pop() || "file"),
    path: typeof att === "string" ? att : (att.path || ""),
    type: "lead",
    size: att.size || 0,
    uploadedAt: att.uploadedAt || null,
  })),
  ...(deal.attachments || []).map(att => ({
    name: att.name || att.path?.split("/").pop() || "file",
    path: att.path || "",
    type: "deal",
    size: att.size || 0,
    uploadedAt: att.uploadedAt || null,
  })),
];

      const dealData = {
        _id: deal._id,
        dealName: deal.dealName,
        dealTitle: deal.dealTitle,
        value: deal.value,
        stage: deal.stage,
        notes: deal.notes,
        phoneNumber: deal.phoneNumber,
        email: deal.email,
        source: deal.source,
        companyName: deal.companyName,
        companyId: deal.companyId,
        industry: deal.industry,
        requirement: deal.requirement,
        address: deal.address,
        country: deal.country,
        clientType: deal.clientType || "",
        followUpDate: deal.followUpDate,
        followUpComment: deal.followUpComment,
        followUpHistory: deal.followUpHistory || [],
        lossReason: deal.lossReason,
        lossNotes: deal.lossNotes,
        attachments: allAttachments,
        createdAt: deal.createdAt,
        updatedAt: deal.updatedAt,
        assignedTo: deal.assignedTo ? {
          _id: deal.assignedTo._id,
          firstName: deal.assignedTo.firstName,
          lastName: deal.assignedTo.lastName,
          email: deal.assignedTo.email
        } : null,
        lead: deal.leadId ? {
          _id: deal.leadId._id,
          leadName: deal.leadId.leadName,
          companyName: deal.leadId.companyName,
          email: deal.leadId.email,
          phone: deal.leadId.phone,
          status: deal.leadId.status,
          source: deal.leadId.source,
          country: deal.leadId.country,
          contactPerson: deal.leadId.contactPerson,
          assignTo: deal.leadId.assignTo ? {
            _id: deal.leadId.assignTo._id,
            firstName: deal.leadId.assignTo.firstName,
            lastName: deal.leadId.assignTo.lastName,
            email: deal.leadId.assignTo.email
          } : null
        } : null
      };

      res.status(200).json(dealData);
    } catch (err) {
      console.error("Get deal by ID error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // 5. Update deal stage
  updateStage: async (req, res) => {
    try {
      const { stage } = req.body;
      const allowedStages = [
        "Qualification",
        "Proposal Sent-Negotiation",
        "Invoice Sent",
        "Closed Won",
        "Closed Lost",
      ];
      if (!allowedStages.includes(stage))
        return res.status(400).json({ message: "Invalid stage" });

      const deal = await Deal.findById(req.params.id).populate(
        "assignedTo",
        "email"
      );
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      if (
        req.user.role.name !== "Admin" &&
        deal.assignedTo._id.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          message: "Access denied: You can only update deals assigned to you",
        });
      }

      const previousStage = deal.stage;
      deal.stage = stage;
      await deal.save();

      if (stage === "Closed Won" && previousStage !== "Closed Won") {
        if (deal.companyName && deal.companyName.trim() !== "") {
          clientLTVController.calculateClientCLV(deal.companyName).catch(err =>
            console.error("Background CLV recalculation error:", err)
          );
        }
      }

      res.status(200).json(deal);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },

  // 6. Update Deal (with notification cleanup)
  updateDeal: async (req, res) => {
    try {
      console.log("Request Body:", req.body);
      console.log("Request Files:", req.files);

      const {
        dealName,
        dealValue,
        currency,
        stage,
        assignTo,
        notes,
        phoneNumber,
        email,
        source,
        companyName,
        companyId,
        industry,
        requirement,
        address,
        country,
        existingAttachments,
        followUpDate,
        followUpComment,
        lossReason,
        lossNotes,
        clientType,
      } = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      const deal = await Deal.findById(req.params.id).populate("assignedTo");
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      if (
        req.user.role.name !== "Admin" &&
        deal.assignedTo?._id.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({ message: "Access denied" });
      }

      const allowedStages = [
        "Qualification",
        "Proposal Sent-Negotiation",
        "Invoice Sent",
        "Closed Won",
        "Closed Lost",
      ];
      if (stage && !allowedStages.includes(stage)) {
        return res.status(400).json({ message: "Invalid stage" });
      }

      //  Check if follow-up date changed
      const oldFollowUpDate = deal.followUpDate;
      const newFollowUpDate = followUpDate ? new Date(followUpDate) : null;
      const followUpChanged = oldFollowUpDate?.toDateString() !== newFollowUpDate?.toDateString();

      const updateFields = {
        ...(dealName && { dealName }),
        ...(assignTo && { assignedTo: assignTo }),
        ...(stage && { stage }),
        ...(notes !== undefined && { notes }),
        ...(phoneNumber && { phoneNumber }),
        ...(email !== undefined && { email }),
        ...(source !== undefined && { source }),
        ...(companyName && { companyName }),
        ...(companyId !== undefined && { companyId }),
        ...(industry !== undefined && { industry }),
        ...(requirement !== undefined && { requirement }),
        ...(address !== undefined && { address }),
        ...(country !== undefined && { country }),
        ...(lossReason !== undefined && { lossReason }),
        ...(lossNotes !== undefined && { lossNotes }),
        ...(clientType !== undefined && { clientType }),
        updatedAt: new Date(),
      };

      if (stage && stage === "Closed Lost" && deal.stage !== "Closed Lost") {
        updateFields.stageLostAt = deal.stage;
        updateFields.lostDate = new Date();
      }

      if (deal.stage === "Closed Lost" && stage && stage !== "Closed Lost") {
        updateFields.stageLostAt = null;
        updateFields.lostDate = null;
      }

      if (dealValue !== undefined && dealValue !== null && String(dealValue).trim() !== "") {
        const finalCurrency = currency || deal.currency || "INR";
        updateFields.value = formatDealValue(dealValue, finalCurrency);
        updateFields.currency = finalCurrency;
      }

      let hasFollowUpChanged = false;

      if (followUpDate !== undefined) {
        let newFollowUpDate = null;
        if (followUpDate) {
          newFollowUpDate = new Date(followUpDate);
          if (isNaN(newFollowUpDate.getTime())) {
            return res.status(400).json({
              message: "Invalid follow-up date format"
            });
          }
        }
        updateFields.followUpDate = newFollowUpDate;
        const oldDateStr = oldFollowUpDate ? oldFollowUpDate.toISOString() : null;
        const newDateStr = newFollowUpDate ? newFollowUpDate.toISOString() : null;
        if (oldDateStr !== newDateStr) {
          hasFollowUpChanged = true;
        }
      }

      if (followUpComment !== undefined) {
        updateFields.followUpComment = followUpComment;
        if (deal.followUpComment !== followUpComment) {
          hasFollowUpChanged = true;
        }
      }

      if (hasFollowUpChanged) {
        updateFields.lastReminderAt = null;
        const historyEntry = {
          date: new Date(),
          followUpDate: updateFields.followUpDate || null,
          followUpComment: updateFields.followUpComment || "",
          changedBy: req.user._id,
          action: oldFollowUpDate ? "Updated" : "Created"
        };
        updateFields.followUpHistory = [
          ...(deal.followUpHistory || []),
          historyEntry
        ];
      }

      let keptAttachments = [];
      if (existingAttachments !== undefined) {
        try {
          const parsed = typeof existingAttachments === "string"
            ? JSON.parse(existingAttachments)
            : existingAttachments;
          keptAttachments = (Array.isArray(parsed) ? parsed : [])
            .map(normalizeAttachment)
            .filter(Boolean);
        } catch (err) {
          console.error("Error parsing existingAttachments:", err);
          keptAttachments = (deal.attachments || []).map(normalizeAttachment).filter(Boolean);
        }
      } else {
        keptAttachments = (deal.attachments || []).map(normalizeAttachment).filter(Boolean);
      }

      const newAttachments = (req.files || []).map(mapFileToAttachment);
      updateFields.attachments = [...keptAttachments, ...newAttachments];

      const updatedDeal = await Deal.findByIdAndUpdate(
        req.params.id,
        updateFields,
        { new: true }
      )
        .populate("assignedTo", "firstName lastName email")
        .populate("followUpHistory.changedBy", "firstName lastName email");

      //  If follow-up date changed, delete all old notifications for this deal and create new follow-up notifications
      if (followUpChanged) {
        await deleteAllNotificationsByEntity('deal', req.params.id);

        const assignedUserId = deal.assignedTo?._id || deal.assignedTo || null;
        if (assignedUserId) {
          await sendNotification(
            assignedUserId,
            `Deal follow-up scheduled: ${updatedDeal.dealName}`,
            "followup",
            {
              dealId: updatedDeal._id,
              dealName: updatedDeal.dealName,
              profileImage: updatedDeal.assignedTo?.profileImage,
            },
            {
              title: "Deal Follow-up",
              followUpDate: updatedDeal.followUpDate,
            }
          );
        }
        await sendNotificationToAdmins(
          `Deal follow-up scheduled: ${updatedDeal.dealName}`,
          "followup",
          {
            dealId: updatedDeal._id,
            dealName: updatedDeal.dealName,
            profileImage: updatedDeal.assignedTo?.profileImage,
          },
          {
            title: "Deal Follow-up",
            followUpDate: updatedDeal.followUpDate,
          },
          assignedUserId ? [assignedUserId] : []
        );
      }

      if (stage === "Closed Won" && deal.stage !== "Closed Won") {
        if (updatedDeal.companyName && updatedDeal.companyName.trim() !== "") {
          clientLTVController.calculateClientCLV(updatedDeal.companyName).catch(err =>
            console.error("Background CLV recalculation error:", err)
          );
        }
      }

      res.status(200).json({
        message: "Deal updated successfully",
        deal: updatedDeal,
      });
    } catch (err) {
      console.error("Update deal error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // 7. Mark follow-up as completed
  completeFollowUp: async (req, res) => {
    try {
      const { id } = req.params;
      const { outcome, notes } = req.body;

      const deal = await Deal.findById(id);
      if (!deal) {
        return res.status(404).json({ message: "Deal not found" });
      }

      if (
        req.user.role.name !== "Admin" &&
        deal.assignedTo?.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({ message: "Access denied" });
      }

      if (!deal.followUpDate) {
        return res.status(400).json({ message: "No active follow-up to complete" });
      }

      const historyEntry = {
        date: new Date(),
        followUpDate: deal.followUpDate,
        followUpComment: deal.followUpComment,
        changedBy: req.user._id,
        action: "Completed",
        outcome: outcome || "Completed",
        notes: notes || ""
      };

      const updateFields = {
        followUpDate: null,
        followUpComment: "",
        followUpHistory: [...(deal.followUpHistory || []), historyEntry],
        updatedAt: new Date()
      };

      const updatedDeal = await Deal.findByIdAndUpdate(
        id,
        updateFields,
        { new: true }
      )
        .populate("assignedTo", "firstName lastName email")
        .populate("followUpHistory.changedBy", "firstName lastName email");

      res.status(200).json({
        message: "Follow-up completed successfully",
        deal: updatedDeal,
      });
    } catch (err) {
      console.error("Complete follow-up error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // 8. Schedule follow-up
  scheduleFollowUp: async (req, res) => {
    try {
      const { id } = req.params;
      const { followUpDate, followUpComment } = req.body;

      const deal = await Deal.findById(id).populate("assignedTo");
      if (!deal) {
        return res.status(404).json({ message: "Deal not found" });
      }

      const assignedToId = deal.assignedTo?._id
        ? deal.assignedTo._id.toString()
        : deal.assignedTo?.toString();

      if (
        req.user.role.name !== "Admin" &&
        assignedToId !== req.user._id.toString()
      ) {
        return res.status(403).json({ message: "Access denied" });
      }

      if (!followUpDate) {
        return res.status(400).json({ message: "Follow-up date is required" });
      }

      const parsedDate = new Date(followUpDate);
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({ message: "Invalid date format" });
      }

      //  Check if date actually changed
      const oldDate = deal.followUpDate;
      const dateChanged =
        !oldDate ||
        oldDate.toISOString() !== parsedDate.toISOString();
      const commentChanged =
        followUpComment !== undefined &&
        followUpComment !== deal.followUpComment;

      const historyEntry = {
        date: new Date(),
        followUpDate: parsedDate,
        followUpComment: followUpComment || "",
        changedBy: req.user._id,
        action: "Scheduled",
      };

      const updatedDeal = await Deal.findByIdAndUpdate(
        id,
        {
          followUpDate: parsedDate,
          followUpComment: followUpComment || "",
          lastReminderAt: null,
          followUpHistory: [...(deal.followUpHistory || []), historyEntry],
        },
        { new: true }
      )
        .populate("assignedTo", "firstName lastName email")
        .populate("followUpHistory.changedBy", "firstName lastName email");

      //  Always delete previous follow-up notifications for this deal and send a fresh set
      await deleteAllNotificationsByEntity('deal', id);

      const assignedUserId = deal.assignedTo?._id || deal.assignedTo || null;
      if (assignedUserId) {
        await sendNotification(
          assignedUserId,
          `Deal follow-up scheduled: ${updatedDeal.dealName}`,
          "followup",
          {
            dealId: updatedDeal._id,
            dealName: updatedDeal.dealName,
            profileImage: updatedDeal.assignedTo?.profileImage,
          },
          {
            title: "Deal Follow-up",
            followUpDate: updatedDeal.followUpDate,
          }
        );
      }
      await sendNotificationToAdmins(
        `Deal follow-up scheduled: ${updatedDeal.dealName}`,
        "followup",
        {
          dealId: updatedDeal._id,
          dealName: updatedDeal.dealName,
          profileImage: updatedDeal.assignedTo?.profileImage,
        },
        {
          title: "Deal Follow-up",
          followUpDate: updatedDeal.followUpDate,
        },
        assignedUserId ? [assignedUserId] : []
      );

      res.status(200).json({
        message: "Follow-up scheduled successfully",
        deal: updatedDeal,
      });
    } catch (err) {
      console.error("Schedule follow-up error:", err);
      res.status(500).json({ message: err.message });
    }
  },

  // 9. Delete Deal (with cascade delete)
  deleteDeal: async (req, res) => {
    try {
      const { id } = req.params;

      const deal = await Deal.findById(id).populate("assignedTo");
      if (!deal) {
        return res.status(404).json({ message: "Deal not found" });
      }

      if (
        req.user.role.name !== "Admin" &&
        deal.assignedTo._id.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          message: "Access denied: You can only delete deals assigned to you",
        });
      }

      //  Delete ALL notifications for this deal first
      if (deal.assignedTo) {
        await deleteNotificationsByEntity('deal', id, deal.assignedTo._id);
      }
      
      // Also delete any admin notifications (without userId)
      await Notification.deleteMany({ "meta.dealId": id });

      await Deal.findByIdAndDelete(id);

      res.status(200).json({ message: "Deal and related notifications deleted successfully" });
    } catch (error) {
      console.error("Delete deal error:", error);
      res.status(500).json({ message: "Server error", error: error.message });
    }
  },

  // 10. Bulk Delete Deals
  bulkDeleteDeals: async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "No deal IDs provided" });
      }

      const roleName = req.user.role.name?.toLowerCase();
      let query = { _id: { $in: ids } };
      if (roleName === "sales") {
        query.assignedTo = req.user._id;
      }

      // Get all deals to be deleted
      const deals = await Deal.find(query).populate("assignedTo");
      
      //  Delete notifications for each deal
      for (const deal of deals) {
        if (deal.assignedTo) {
          await deleteNotificationsByEntity('deal', deal._id, deal.assignedTo._id);
        }
        await Notification.deleteMany({ "meta.dealId": deal._id });
      }

      const result = await Deal.deleteMany(query);
      res.status(200).json({
        message: `${result.deletedCount} deal(s) and their notifications deleted successfully`,
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      console.error("Bulk delete error:", error);
      res.status(500).json({ message: "Server error", error: error.message });
    }
  },

  // 11. Pending Deals
  pendingDeals: async (req, res) => {
    try {
      let query = { stage: { $nin: ["Closed Won", "Closed Lost"] } };
      if (req.user.role.name !== "Admin") {
        query.assignedTo = req.user._id;
      }
      const deals = await Deal.find(query)
        .populate("assignedTo", "firstName lastName email")
        .sort({ createdAt: -1 })
        .limit(10);

      res.status(200).json(deals);
    } catch (error) {
      console.error("Pending deals error:", error); 
      res.status(500).json({ message: "Server error" });
    }
  },

  // 12. Update only follow-up (new function)
  updateDealFollowUp: async (req, res) => {
    try {
      const { id } = req.params;
      const { followUpDate, followUpComment } = req.body;

      const deal = await Deal.findById(id).populate("assignedTo");
      if (!deal) {
        return res.status(404).json({ message: "Deal not found" });
      }

      if (
        req.user.role.name !== "Admin" &&
        deal.assignedTo?._id.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Check if date actually changed
      const oldDate = deal.followUpDate;
      const newDate = followUpDate ? new Date(followUpDate) : null;
      const dateChanged = oldDate?.toDateString() !== newDate?.toDateString();

      // Update deal
      deal.followUpDate = newDate;
      deal.followUpComment = followUpComment || deal.followUpComment;
      deal.lastReminderAt = null;
      
      // Add to history
      if (dateChanged) {
        const historyEntry = {
          date: new Date(),
          followUpDate: newDate,
          followUpComment: followUpComment || "",
          changedBy: req.user._id,
          action: oldDate ? "Updated" : "Created"
        };
        deal.followUpHistory = [...(deal.followUpHistory || []), historyEntry];
      }
      
      await deal.save();

      // If date changed, delete old notifications and create a new scheduled follow-up notification
      if (dateChanged) {
        const assignedUserId = deal.assignedTo?._id || deal.assignedTo || null;
        if (assignedUserId) {
          await deleteNotificationsByEntity('deal', id, assignedUserId);
          await sendNotification(
            assignedUserId,
            `Deal follow-up scheduled: ${deal.dealName}`,
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
        await sendNotificationToAdmins(
          `Deal follow-up scheduled: ${deal.dealName}`,
          "followup",
          {
            dealId: deal._id,
            dealName: deal.dealName,
            profileImage: deal.assignedTo?.profileImage,
          },
          {
            title: "Deal Follow-up",
            followUpDate: deal.followUpDate,
          },
          assignedUserId ? [assignedUserId] : []
        );
      }

      res.status(200).json({ 
        message: "Follow-up updated successfully", 
        deal 
      });
    } catch (error) {
      console.error("Update follow-up error:", error);
      res.status(500).json({ message: error.message });
    }
  },
};