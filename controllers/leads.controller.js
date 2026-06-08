// controllers/leads.controller.js
import dayjs from "dayjs";
import Lead from "../models/leads.model.js";
import userModel from "../models/user.model.js";
import sendEmail from "../services/email.js";
import { notifyUser } from "../realtime/socket.js";
import Deal from "../models/deals.model.js";
import Notification from "../models/notification.model.js";
import {
  deleteNotificationsByEntity,
  deleteAllNotificationsByEntity,
  sendNotification,
  sendNotificationToAdmins,
} from "../services/notificationService.js";

//automatically pick the sales user
const pickNextSalesUser = async () => {
  const users = await userModel
    .find({})
    .populate("role", "name")
    .select("_id firstName lastName role createdAt")
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  const salesUsers = users.filter((u) => {
    const roleName =
      typeof u.role === "string"
        ? u.role
        : u.role?.name || u.role?.roleName || "";

    return String(roleName).toLowerCase() === "sales";
  });

  if (!salesUsers.length) return null;

  const lastLead = await Lead.findOne({ assignTo: { $ne: null } })
    .sort({ createdAt: -1, _id: -1 })
    .select("assignTo")
    .lean();

  if (!lastLead?.assignTo) return salesUsers[0]._id;

  const lastIdx = salesUsers.findIndex(
    (u) => u._id.toString() === lastLead.assignTo.toString()
  );

  const nextIdx = lastIdx === -1 ? 0 : (lastIdx + 1) % salesUsers.length;
  return salesUsers[nextIdx]._id;
};

export default {
  //  Create Lead (FIXED - respects user input)
  createLead: async (req, res) => {
    try {
      const { leadName, companyName, phoneNumber, email } = req.body;

      if (!leadName || !companyName || !phoneNumber) {
        return res.status(400).json({
          message: "Lead name, company name, and phone number are required",
        });
      }

      const data = { ...req.body };

      // Handle file uploads
      let existingAttachments = [];
      if (req.body.existingAttachments) {
        try {
          existingAttachments = JSON.parse(req.body.existingAttachments);
        } catch (err) {
          console.error("Error parsing existingAttachments:", err);
        }
      }

      let newAttachments = [];
      if (req.files?.length > 0) {
        newAttachments = req.files.map((file) => ({
          name: file.originalname,
          path: `/uploads/leads/${file.filename}`,
          type: file.mimetype,
          size: file.size,
          uploadedAt: new Date(),
        }));
      }

      // Merge attachments
      if (existingAttachments.length > 0 || newAttachments.length > 0) {
        data.attachments = [...existingAttachments, ...newAttachments];
      }

      //  Only auto-assign if user didn't provide an assignee
      if (!data.assignTo || data.assignTo === "") {
        const autoAssignee = await pickNextSalesUser();
        data.assignTo = autoAssignee;
        console.log("Auto-assigned to:", autoAssignee);
      } else {
        console.log("Using user-selected assignee:", data.assignTo);
      }

      //  Only set followUpDate to now if user didn't provide one
      if (!data.followUpDate || data.followUpDate === "") {
        data.followUpDate = new Date();
        console.log("Auto-set followUpDate to now");
      } else {
        console.log("Using user-selected followUpDate:", data.followUpDate);
      }

      if (!data.status) data.status = "Cold";

      data.lastReminderAt = null;

      const lead = new Lead(data);
      const savedLead = await lead.save();

      res.status(201).json({
        message: "Lead created successfully",
        lead: savedLead,
      });
    } catch (error) {
      console.error("Create lead error:", error);
      res.status(400).json({ message: error.message });
    }
  },

  //  Get All Leads (FIXED - newest first)
getLeads: async (req, res) => {
  try {
    const {
      search = "",
      status,
      source,
      assignee,
      page = 1,
      limit = 10,
    } = req.query;

    const query = {};

    //  Role-based filtering
    if (req.user.role.name !== "Admin") {
      query.assignTo = req.user._id;
    }

    //  Search filter - search in multiple fields
    if (search && search.trim()) {
      query.$or = [
        { leadName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phoneNumber: { $regex: search, $options: "i" } },
        { companyName: { $regex: search, $options: "i" } },
        { source: { $regex: search, $options: "i" } },
      ];
    }

    //  Status filter - direct match
    if (status && status !== "") {
      query.status = status;
    }

    //  Source filter - direct match
    if (source && source !== "") {
      query.source = source;
    }

    // Client Type filter
    if (req.query.clientType && req.query.clientType !== "") {
      query.clientType = req.query.clientType;
    }

    //  Assignee filter - handle both ID and name for backward compatibility
    if (assignee && assignee !== "") {
      // Check if assignee is a valid MongoDB ObjectId
      const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(assignee);
      
      if (isValidObjectId) {
        // If it's a valid ObjectId, use it directly
        query.assignTo = assignee;
        console.log("Filtering by assignee ID:", assignee);
      } else {
        // If it's a name, find users with matching names
        const nameParts = assignee.split(' ');
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ');
        
        let userQuery = {};
        if (lastName) {
          // Both first and last name provided
          userQuery = {
            firstName: { $regex: firstName, $options: "i" },
            lastName: { $regex: lastName, $options: "i" }
          };
        } else {
          // Only one name provided - search in both first and last name
          userQuery = {
            $or: [
              { firstName: { $regex: firstName, $options: "i" } },
              { lastName: { $regex: firstName, $options: "i" } }
            ]
          };
        }
        
        const users = await userModel.find(userQuery).select("_id");
        const userIds = users.map((u) => u._id);
        
        if (userIds.length === 0) {
          // No users found, return empty results
          return res.status(200).json({
            leads: [],
            totalLeads: 0,
            totalPages: 0,
            currentPage: Number(page),
          });
        }
        
        query.assignTo = { $in: userIds };
        console.log("Filtering by assignee names, found user IDs:", userIds);
      }
    }

    console.log("Final query:", JSON.stringify(query, null, 2)); 

    //  Pagination
    const skip = (page - 1) * limit;
    const totalLeads = await Lead.countDocuments(query);

    const leads = await Lead.find(query)
      .populate("assignTo", "firstName lastName email role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    console.log(`Found ${leads.length} leads out of ${totalLeads} total`); 

    res.status(200).json({
      leads,
      totalLeads,
      totalPages: Math.ceil(totalLeads / limit),
      currentPage: Number(page),
    });
  } catch (error) {
    console.error("Get leads error:", error);
    res.status(500).json({ message: error.message });
  }
},

  // Get Lead by ID
  getLeadById: async (req, res) => {
    try {
      const lead = await Lead.findById(req.params.id).populate(
        "assignTo",
        "firstName lastName email role"
      );
      if (!lead) return res.status(404).json({ message: "Lead not found" });

      res.status(200).json(lead);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  //  Update Lead
  updateLead: async (req, res) => {
    try {
      const before = await Lead.findById(req.params.id).populate("assignTo");
      if (!before) return res.status(404).json({ message: "Lead not found" });

      const patch = { ...req.body };

      let existingAttachments = [];
      if (req.body.existingAttachments) {
        try {
          existingAttachments = JSON.parse(req.body.existingAttachments);
        } catch {
          existingAttachments = [];
        }
      }

      let newFiles = [];
      if (req.files && req.files.length > 0) {
        newFiles = req.files.map((file) => ({
          name: file.originalname,
          path: `/uploads/leads/${file.filename}`,
          type: file.mimetype,
          size: file.size,
          uploadedAt: new Date(),
        }));
      }

      patch.attachments = [...existingAttachments, ...newFiles];

      // Check if follow-up date changed
      const oldFollowUpDate = before.followUpDate;
      const newFollowUpDate = patch.followUpDate ? new Date(patch.followUpDate) : null;
      const followUpChanged =
        !oldFollowUpDate ||
        !newFollowUpDate ||
        oldFollowUpDate.toISOString() !== newFollowUpDate.toISOString();

      //  Status change: reset reminder only
      if (patch.status && patch.status !== before.status) {
        patch.lastReminderAt = null;
      }

      if (patch.followUpDate) {
        patch.lastReminderAt = null;
      }

      const updated = await Lead.findByIdAndUpdate(req.params.id, patch, {
        new: true,
      }).populate("assignTo", "firstName lastName email profileImage");

      // If follow-up date changed, delete old lead notifications for all users
      if (followUpChanged) {
        await deleteAllNotificationsByEntity('lead', req.params.id);

        if (updated.assignTo) {
          await sendNotification(
            updated.assignTo._id,
            `Lead follow-up rescheduled: ${updated.leadName}`,
            "followup",
            {
              leadId: updated._id,
              leadName: updated.leadName,
              profileImage: updated.assignTo?.profileImage,
            },
            {
              title: "Lead Follow-up",
              followUpDate: updated.followUpDate,
            }
          );

          await sendNotificationToAdmins(
            `Lead follow-up rescheduled: ${updated.leadName}`,
            "followup",
            {
              leadId: updated._id,
              leadName: updated.leadName,
              profileImage: updated.assignTo?.profileImage,
            },
            {
              title: "Lead Follow-up",
              followUpDate: updated.followUpDate,
            },
            [updated.assignTo._id]
          );
        }
      }

      if (before.status !== "Converted" && updated.status === "Converted") {
        const userId = updated.assignTo?._id?.toString();
        const fullName = `${updated.assignTo?.firstName || ""} ${
          updated.assignTo?.lastName || ""
        }`.trim();

        if (userId) {
          notifyUser(userId, "deal:converted", {
            leadId: updated._id,
            leadName: updated.leadName,
            when: new Date(),
          });
        }

        if (updated.assignTo?.email) {
          await sendEmail({
            to: updated.assignTo.email,
            subject: ` Deal Converted: ${updated.leadName}`,
            text: `Deal converted for lead ${updated.leadName}. Congrats, ${fullName}!`,
          });
        }
      }

      res.status(200).json({
        message: "Lead updated successfully",
        lead: updated,
      });
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  },

  // Delete Lead (with cascade delete)
  deleteLead: async (req, res) => {
    try {
      const lead = await Lead.findById(req.params.id).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });

      // Delete ALL notifications for this lead first
      await deleteAllNotificationsByEntity('lead', req.params.id);

      await Lead.findByIdAndDelete(req.params.id);

      res.status(200).json({ message: "Lead and related notifications deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  // Update Follow-Up Date
  updateFollowUpDate: async (req, res) => {
    try {
      const { followUpDate } = req.body;
      if (!followUpDate) {
        return res.status(400).json({ message: "followUpDate required" });
      }

      const lead = await Lead.findById(req.params.id).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });

      const oldDate = lead.followUpDate;
      const newDate = new Date(followUpDate);
      const dateChanged =
        !oldDate ||
        oldDate.toISOString() !== newDate.toISOString();

      lead.followUpDate = newDate;
      lead.lastReminderAt = null;
      await lead.save();

      if (dateChanged) {
        await deleteAllNotificationsByEntity('lead', req.params.id);

        if (lead.assignTo) {
          await sendNotification(
            lead.assignTo._id,
            `Lead follow-up scheduled: ${lead.leadName}`,
            "followup",
            {
              leadId: lead._id,
              leadName: lead.leadName,
              profileImage: lead.assignTo?.profileImage,
            },
            {
              title: "Lead Follow-up",
              followUpDate: lead.followUpDate,
            }
          );

          await sendNotificationToAdmins(
            `Lead follow-up scheduled: ${lead.leadName}`,
            "followup",
            {
              leadId: lead._id,
              leadName: lead.leadName,
              profileImage: lead.assignTo?.profileImage,
            },
            {
              title: "Lead Follow-up",
              followUpDate: lead.followUpDate,
            },
            [lead.assignTo._id]
          );
        }
      }

      return res.status(200).json({
        message: "Follow-up date updated",
        lead,
      });
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  },
  
  //convert lead->deal
  convertLeadToDeal: async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id).populate("assignTo");
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (lead.status === "Converted") {
      return res.status(400).json({ message: "Lead already converted" });
    }

    const { value, notes, currency, stage } = req.body;

    const numericValue = Number(value || 0);
    const formattedNumber = new Intl.NumberFormat("en-IN").format(numericValue);
    const formattedValue = `${formattedNumber} ${currency || "INR"}`;

    const deal = new Deal({
      leadId: lead._id,
      dealName: lead.leadName,
      assignedTo: lead.assignTo?._id ?? null,
      value: formattedValue,
      currency: currency || "INR",
      notes: notes || "",
      stage: stage || "Qualification",
      email: lead.email || "",
      phoneNumber: lead.phoneNumber || "",
      source: lead.source || "",
      companyName: lead.companyName || "",
      industry: lead.industry || "",
      requirement: lead.requirement || "",
      country: lead.country || "",
      address: lead.address || "",
      clientType: lead.clientType || "",
      attachments: lead.attachments || [],
      followUpDate: lead.followUpDate ?? null,
      lastReminderAt: lead.lastReminderAt ?? null,
      companyId: lead.companyId || null,
      companySize: lead.companySize || "Medium"
    });

    await deal.save();
    
    //  DELETE the lead instead of just updating status
    // First delete all notifications for this lead
    if (lead.assignTo) {
      await deleteNotificationsByEntity('lead', req.params.id, lead.assignTo._id);
    }
    await Notification.deleteMany({ "meta.leadId": req.params.id });
    
    // Then delete the lead
    await Lead.findByIdAndDelete(req.params.id);

    // Notify the assigned user about the conversion
    const userId = lead.assignTo?._id?.toString();
    if (userId) {
      notifyUser(userId, "deal:created", {
        dealId: deal._id,
        dealName: deal.dealName,
        leadName: lead.leadName,
      });
    }

    // Send email notification if assignee has email
    if (lead.assignTo?.email) {
      await sendEmail({
        to: lead.assignTo.email,
        subject: ` Lead Converted: ${lead.leadName}`,
        text: `Lead "${lead.leadName}" has been successfully converted to a deal. Deal Name: ${deal.dealName}, Value: ${formattedValue}`,
      });
    }

    res.status(200).json({ 
      message: "Lead converted to deal successfully", 
      deal,
      leadDeleted: true
    });
    
  } catch (error) {
    console.error("Error converting lead to deal:", error);
    res.status(500).json({ 
      message: error.message,
      details: error.errors 
    });
  }
},

  //  Get Recent Leads (last 5)
  getRecentLeads: async (req, res) => {
    try {
      const query =
        req.user.role.name === "Admin" ? {} : { assignTo: req.user._id };

      const leads = await Lead.find(query)
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("assignTo", "firstName lastName email");

      res.status(200).json(leads);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  // Get Pending Leads
  getPendingLeads: async (req, res) => {
    try {
      const query =
        req.user.role.name === "Admin"
          ? { status: { $ne: "Converted" } }
          : { status: { $ne: "Converted" }, assignTo: req.user._id };

      const leads = await Lead.find(query)
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("assignTo", "firstName lastName email");

      res.status(200).json(leads);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },


  

  //  Update Lead Status

  updateLeadStatus: async (req, res) => {
    try {
      const { status } = req.body;
      if (!status) return res.status(400).json({ message: "Status required" });

      const lead = await Lead.findById(req.params.id).populate("assignTo");
      if (!lead) return res.status(404).json({ message: "Lead not found" });

      const oldStatus = lead.status;
      lead.status = status;

      if (status !== oldStatus) lead.lastReminderAt = null;
      await lead.save();

      if (oldStatus !== "Converted" && status === "Converted") {
        const userId = lead.assignTo?._id?.toString();
        const fullName = `${lead.assignTo?.firstName || ""} ${
          lead.assignTo?.lastName || ""
        }`.trim();

        if (userId) {
          notifyUser(userId, "deal:converted", {
            leadId: lead._id,
            leadName: lead.leadName,
            when: new Date(),
          });
        }

        if (lead.assignTo?.email) {
          await sendEmail({
            to: lead.assignTo.email,
            subject: ` Deal Converted: ${lead.leadName}`,
            text: `Deal converted for lead ${lead.leadName}. Congrats, ${fullName}!`,
          });
        }
      }

      res.status(200).json({
        message: "Lead status updated successfully",
        lead,
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  // New function: Update only follow-up
  // New function: Update only follow-up
updateLeadFollowUp: async (req, res) => {
  try {
    const { followUpDate, followUpComment } = req.body;
    if (!followUpDate) {
      return res.status(400).json({ message: "followUpDate required" });
    }

    const lead = await Lead.findById(req.params.id).populate("assignTo");
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const oldDate = lead.followUpDate;
    const newDate = new Date(followUpDate);
    const dateChanged = oldDate?.toDateString() !== newDate?.toDateString();

    lead.followUpDate = newDate;
    lead.followUpComment = followUpComment || lead.followUpComment;
    lead.lastReminderAt = null;
    
    // Add to history
    if (dateChanged) {
      const historyEntry = {
        date: new Date(),
        followUpDate: newDate,
        followUpComment: followUpComment || "",
        changedBy: req.user._id,
        action: oldDate ? "Updated" : "Created"
      };
      lead.followUpHistory = [...(lead.followUpHistory || []), historyEntry];
    }
    
    await lead.save();

    // ✅ FIX: Delete ALL notifications for this lead when follow-up changes
    if (dateChanged) {
      // Delete notifications for assignee
      if (lead.assignTo) {
        await deleteNotificationsByEntity('lead', req.params.id, lead.assignTo._id);
      }
      
      // Delete ALL admin notifications for this lead
      await Notification.deleteMany({ 
        "meta.leadId": req.params.id,
        type: "followup"
      });
      
      // OR use deleteAllNotificationsByEntity to delete for ALL users
      await deleteAllNotificationsByEntity('lead', req.params.id);
      
      // Send new notification to assignee
      if (lead.assignTo) {
        await sendNotification(
          lead.assignTo._id,
          `Lead follow-up rescheduled: ${lead.leadName}`,
          "followup",
          {
            leadId: lead._id,
            leadName: lead.leadName,
            profileImage: lead.assignTo?.profileImage,
            followUpDate: newDate,
            oldFollowUpDate: oldDate
          },
          {
            title: "Lead Follow-up Updated",
            followUpDate: newDate,
            message: `Follow-up date changed from ${oldDate?.toLocaleDateString() || 'not set'} to ${newDate.toLocaleDateString()}`
          }
        );
        
        // Send notification to admins
        await sendNotificationToAdmins(
          `Lead follow-up rescheduled: ${lead.leadName}`,
          "followup",
          {
            leadId: lead._id,
            leadName: lead.leadName,
            profileImage: lead.assignTo?.profileImage,
            assignedTo: lead.assignTo._id,
            assignedToName: `${lead.assignTo.firstName} ${lead.assignTo.lastName}`,
            followUpDate: newDate,
            oldFollowUpDate: oldDate
          },
          {
            title: "Lead Follow-up Updated",
            followUpDate: newDate,
            leadName: lead.leadName,
            assignee: `${lead.assignTo.firstName} ${lead.assignTo.lastName}`
          },
          [lead.assignTo._id] // Exclude the assignee from admin notifications
        );
      }
    }

    return res.status(200).json({
      message: "Follow-up updated successfully",
      lead,
    });
  } catch (error) {
    console.error("Error updating follow-up:", error);
    return res.status(400).json({ message: error.message });
  }
},
};