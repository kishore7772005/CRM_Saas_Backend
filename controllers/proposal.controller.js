import Proposal from "../models/proposal.model.js";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Notification from "../models/notification.model.js";
import {
  deleteNotificationsByEntity,
  deleteAllNotificationsByEntity,
  sendNotification,
  sendNotificationToAdmins,
} from "../services/notificationService.js";

dotenv.config();

export default {


  // Send Proposal or Save as Draft
  sendProposal: async (req, res) => {
    const { emails, title, dealTitle, selectedDealId, content, image, id, cc, isDraft } = req.body;

    if (!title || !dealTitle) {
      return res
        .status(400)
        .json({ error: "Title and dealTitle are required" });
    }

    try {
      const recipients = emails
        ? emails.split(",").map((e) => e.trim()).filter(Boolean)
        : [];

      let dealInfo = null;
      if (selectedDealId) {
        dealInfo = await mongoose.model("Deal").findById(selectedDealId).lean();
        if (!dealInfo) {
          return res.status(404).json({ error: "Deal not found" });
        }
      }

      // Map attachments to match the model schema
      const attachments = (req.files || []).map((file) => ({
        name: file.originalname,
        path: file.path,
        type: file.mimetype,
        size: file.size,
        uploadedAt: new Date(),
      }));

      // Determine status: draft or sent
       const isDraftMode = isDraft === true || isDraft === "true";
       const status = isDraftMode ? "draft" : "sent";

       console.log("isDraft received:", isDraft);
       console.log("isDraftMode:", isDraftMode);
       console.log("Final status:", status);

      const proposalData = {
        title,
        deal: selectedDealId || null,
        dealTitle,
        email: recipients.join(","),
        cc: cc || "",
        content: content || "",
        image: image || "",
        status: status,
        attachments: attachments,
        companyName: dealInfo?.companyName || "",
        value: dealInfo?.value || 0,
        followUpDate: status === "draft" ? null : new Date(),
        lastReminderAt: null,
      };

      let proposal;
      if (id) {
        proposal = await Proposal.findByIdAndUpdate(id, proposalData, {
          new: true,
          runValidators: true,
        });
        if (!proposal)
          return res.status(404).json({ error: "Proposal not found" });
      } else {
        proposal = new Proposal(proposalData);
        await proposal.save();
      }

      // Send response immediately
      res.json({
        message: status === "draft" 
          ? "Proposal saved as draft successfully!" 
          : "Proposal saved successfully! Email is sending in background.",
        proposal,
      });

      // Only send email if status is "sent"
      if (status === "sent" && recipients.length > 0) {
        // Send email in background
        const transporter = nodemailer.createTransport({
          service: "gmail",
          host: "smtp.gmail.com",
          port: 587,
          secure: false,
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        const emailAttachments = (req.files || []).map((file) => ({
          filename: file.originalname,
          path: file.path,
        }));

        await transporter.sendMail({
          from: `"Your Company" <${process.env.EMAIL_USER}>`,
          to: recipients.join(","),
          cc: cc || undefined,
          subject: `Proposal: ${title}`,
          html: content,
          attachments: emailAttachments,
        });

        if (process.env.OWNER_EMAIL) {
          await transporter.sendMail({
            from: `"CRM Notification" <${process.env.EMAIL_USER}>`,
            to: process.env.OWNER_EMAIL,
            subject: ` Proposal Sent: ${title}`,
            text: `A new proposal has been sent to ${recipients.join(",")}.`,
          });
        }

        console.log(" Proposal email(s) sent successfully");
      } else if (status === "draft") {
        console.log(" Proposal saved as draft, email not sent");
      }
    } catch (error) {
      console.error(" Proposal Error:", error);
      res.status(500).json({ error: error.message });
    }
  },

  // Update Follow-up
  updateFollowUp: async (req, res) => {
    const { id } = req.params;
    const { followUpDate, followUpComment } = req.body;

    try {
      const proposal = await Proposal.findById(id).populate({
        path: "deal",
        populate: { path: "assignedTo" }
      });

      if (!proposal) {
        return res.status(404).json({ error: "Proposal not found" });
      }

      const oldDate = proposal.followUpDate;
      const newDate = followUpDate ? new Date(followUpDate) : null;
      const dateChanged = oldDate?.toDateString() !== newDate?.toDateString();

      const updated = await Proposal.findByIdAndUpdate(
        id,
        {
          followUpDate: newDate,
          followUpComment,
          lastReminderAt: null,
        },
        { new: true }
      ).populate({
        path: "deal",
        populate: { path: "assignedTo" }
      });

      if (dateChanged) {
        await deleteAllNotificationsByEntity('proposal', id);
        if (updated.deal?.assignedTo) {
          await sendNotification(
            updated.deal.assignedTo._id,
            `Proposal follow-up scheduled: ${updated.title}`,
            "followup",
            {
              proposalId: updated._id,
              proposalTitle: updated.title,
              dealId: updated.deal?._id,
              profileImage: updated.deal?.assignedTo?.profileImage,
            },
            {
              title: "Proposal Follow-up",
              followUpDate: updated.followUpDate,
            }
          );
        }
        await sendNotificationToAdmins(
          `Proposal follow-up scheduled: ${updated.title}`,
          "followup",
          {
            proposalId: updated._id,
            proposalTitle: updated.title,
            dealId: updated.deal?._id,
            profileImage: updated.deal?.assignedTo?.profileImage,
          },
          {
            title: "Proposal Follow-up",
            followUpDate: updated.followUpDate,
          },
          updated.deal?.assignedTo?._id ? [updated.deal.assignedTo._id] : []
        );
      }

      res.json({ message: "Follow-up updated", proposal: updated });
    } catch (err) {
      console.error(" FollowUp Update Error:", err);
      res.status(500).json({ error: err.message });
    }
  },

    // Get Draft Proposals (WITH ROLE-BASED FILTERING)
  getDraftProposals: async (req, res) => {
    try {
      const userRole = req.user?.role?.name?.toLowerCase();
      const userId = req.user?._id;
      
      let query = { status: "draft" };
      
      // If user is not admin, only show proposals related to their assigned deals
      if (userRole !== "admin") {
        const userDeals = await mongoose.model("Deal").find({ assignedTo: userId }).select("_id");
        const dealIds = userDeals.map(deal => deal._id);
        query.deal = { $in: dealIds };
      }
      
      const drafts = await Proposal.find(query)
        .populate("deal")
        .sort({ createdAt: -1 });
      
      res.json(drafts);
    } catch (error) {
      console.error("Fetch drafts error:", error);
      res.status(500).json({ error: "Server error" });
    }
  },

  // Get All Proposals (WITH ROLE-BASED FILTERING)
  getAllProposals: async (req, res) => {
    try {
      const userRole = req.user?.role?.name?.toLowerCase();
      const userId = req.user?._id;
      
      let query = {};
      
      // If user is not admin, only show proposals related to their assigned deals
      if (userRole !== "admin") {
        const userDeals = await mongoose.model("Deal").find({ assignedTo: userId }).select("_id");
        const dealIds = userDeals.map(deal => deal._id);
        query.deal = { $in: dealIds };
      }
      
      const proposals = await Proposal.find(query)
        .populate("deal")
        .sort({ createdAt: -1 });
      
      res.json(proposals);
    } catch (error) {
      console.error("Database Fetch Error:", error);
      res.status(500).json({ error: "Server error" });
    }
  },

  // Update Proposal Status
  updateStatus: async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    try {
      const updatedProposal = await Proposal.findByIdAndUpdate(
        id,
        { status },
        { new: true }
      );

      if (!updatedProposal) {
        return res.status(404).json({ error: "Proposal not found" });
      }

      res.json({ message: "Status updated", proposal: updatedProposal });
    } catch (error) {
      console.error("Status Update Error:", error);
      res.status(500).json({ error: "Failed to update status" });
    }
  },

  // Update Proposal (with notification cleanup)
  
updateProposal: async (req, res) => {
  const { id } = req.params;
  const { title, dealTitle, email, content, image, status, followUpDate, followUpComment } = req.body;

  try {
    const originalProposal = await Proposal.findById(id).populate({
      path: "deal",
      populate: { path: "assignedTo" }
    });

    if (!originalProposal) {
      return res.status(404).json({ error: "Proposal not found" });
    }

    const oldFollowUpDate = originalProposal.followUpDate;
    const newFollowUpDate = followUpDate ? new Date(followUpDate) : null;
    const followUpChanged = oldFollowUpDate?.toDateString() !== newFollowUpDate?.toDateString();

    const updateData = {
      title,
      dealTitle,
      email,
      content,
      image,
      status,
      followUpDate: newFollowUpDate,
      followUpComment,
      lastReminderAt: null
    };

    // If there are new attachments in the update
    if (req.files && req.files.length > 0) {
      const newAttachments = req.files.map((file) => ({
        name: file.originalname,
        path: file.path,
        type: file.mimetype,
        size: file.size,
        uploadedAt: new Date(),
      }));
      
      // Merge with existing attachments if needed
      updateData.attachments = [...(originalProposal.attachments || []), ...newAttachments];
    }

    const updatedProposal = await Proposal.findByIdAndUpdate(id, updateData, { 
      new: true,
      runValidators: true 
    }).populate({
      path: "deal",
      populate: { path: "assignedTo" }
    });

    if (followUpChanged && originalProposal.deal?.assignedTo) {
      await deleteNotificationsByEntity('proposal', id, originalProposal.deal.assignedTo._id);
    }

    res.json({ message: "Proposal updated", proposal: updatedProposal });
  } catch (error) {
    console.error("Update Error:", error);
    res.status(500).json({ error: error.message });
  }
},

  // Delete Proposal (with cascade delete)
  deleteProposal: async (req, res) => {
    const { id } = req.params;

    try {
      const proposal = await Proposal.findById(id).populate({
        path: "deal",
        populate: { path: "assignedTo" }
      });

      if (!proposal) {
        return res.status(404).json({ error: "Proposal not found" });
      }

      if (proposal.deal?.assignedTo) {
        await deleteNotificationsByEntity('proposal', id, proposal.deal.assignedTo._id);
      }
      
      await Notification.deleteMany({ "meta.proposalId": id });

      await Proposal.findByIdAndDelete(id);

      res.json({ message: "Proposal and related notifications deleted successfully" });
    } catch (error) {
      console.error("Delete Error:", error);
      res.status(500).json({ error: error.message });
    }
  },

  // Bulk Delete Proposals
  bulkDeleteProposals: async (req, res) => {
    try {
      const { ids } = req.body;
      
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ 
          success: false, 
          message: "Please provide an array of proposal IDs to delete" 
        });
      }

      // Get all proposals to be deleted to clean up notifications
      const proposalsToDelete = await Proposal.find({ _id: { $in: ids } }).populate({
        path: "deal",
        populate: { path: "assignedTo" }
      });

      if (proposalsToDelete.length === 0) {
        return res.status(404).json({ 
          success: false, 
          message: "No proposals found to delete" 
        });
      }

      // Delete notifications for each proposal
      for (const proposal of proposalsToDelete) {
        if (proposal.deal?.assignedTo) {
          await deleteNotificationsByEntity('proposal', proposal._id, proposal.deal.assignedTo._id);
        }
        await Notification.deleteMany({ "meta.proposalId": proposal._id });
      }

      const result = await Proposal.deleteMany({ _id: { $in: ids } });
      
      res.status(200).json({
        success: true,
        message: `${result.deletedCount} proposal(s) deleted successfully`,
        deletedCount: result.deletedCount
      });
    } catch (error) {
      console.error(" Bulk delete proposals error:", error);
      res.status(500).json({ 
        success: false, 
        message: "Failed to delete proposals", 
        error: error.message 
      });
    }
  },

  // Get Proposal by ID
  getProposal: async (req, res) => {
    const { id } = req.params;

    try {
      const proposal = await Proposal.findById(id).populate("deal");

      if (!proposal) {
        return res.status(404).json({ error: "Proposal not found" });
      }

      res.json(proposal);
    } catch (error) {
      console.error("Fetch Error:", error);
      res.status(500).json({ error: error.message });
    }
  },

  // New function: Update only follow-up
  updateProposalFollowUp: async (req, res) => {
    const { id } = req.params;
    const { followUpDate, followUpComment } = req.body;

    try {
      const proposal = await Proposal.findById(id).populate({
        path: "deal",
        populate: { path: "assignedTo" }
      });

      if (!proposal) {
        return res.status(404).json({ error: "Proposal not found" });
      }

      const oldDate = proposal.followUpDate;
      const newDate = followUpDate ? new Date(followUpDate) : null;
      const dateChanged =
        !oldDate ||
        !newDate ||
        oldDate.toISOString() !== newDate.toISOString();

      proposal.followUpDate = newDate;
      proposal.followUpComment = followUpComment || proposal.followUpComment;
      proposal.lastReminderAt = null;
      
      // Add to history
      if (dateChanged) {
        const historyEntry = {
          date: new Date(),
          followUpDate: newDate,
          followUpComment: followUpComment || "",
          changedBy: req.user?._id,
          action: oldDate ? "Updated" : "Created"
        };
        proposal.followUpHistory = [...(proposal.followUpHistory || []), historyEntry];
      }
      
      await proposal.save();

      if (dateChanged && proposal.deal?.assignedTo) {
        await deleteNotificationsByEntity('proposal', id, proposal.deal.assignedTo._id);
        await sendNotification(
          proposal.deal.assignedTo._id,
          `Proposal follow-up scheduled: ${proposal.title}`,
          "followup",
          {
            proposalId: proposal._id,
            proposalTitle: proposal.title,
            dealId: proposal.deal?._id,
            profileImage: proposal.deal?.assignedTo?.profileImage,
          },
          {
            title: "Proposal Follow-up",
            followUpDate: proposal.followUpDate,
          }
        );
      }

      res.json({ message: "Follow-up updated", proposal });
    } catch (err) {
      console.error(" FollowUp Update Error:", err);
      res.status(500).json({ error: err.message });
    }
  },
};