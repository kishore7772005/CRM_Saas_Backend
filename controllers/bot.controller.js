import LeadLegacy from "../models/leads.model.js";
import DealLegacy from "../models/deals.model.js";
import CallLogLegacy from "../models/callLog.model.js";
import { getTenantModels } from "../models/tenant/index.js";
import { v4 as uuidv4 } from 'uuid';

const getModels = (req) => {
  if (req.tenantDB) {
    const m = getTenantModels(req.tenantDB);
    return { Lead: m.Lead, Deal: m.Deal, CallLog: m.CallLog };
  }
  return { Lead: LeadLegacy, Deal: DealLegacy, CallLog: CallLogLegacy };
};

export default {
  parseCallCommand: async (req, res) => {
    try {
      const { Lead, Deal, CallLog } = getModels(req);
      const { command, contactId, contactType } = req.body;
      const userId   = req.user._id;
      const userRole = req.user.role.name;
      if (contactId && contactType) {
        return initiateCall({ contactId, contactType, userId, userRole, res, Lead, Deal, CallLog });
      }
      if (!command || !command.toLowerCase().startsWith('call ')) {
        return res.status(400).json({ success: false, message: "Command must start with 'call '" });
      }

      const searchTerm = command.substring(5).trim();
      if (!searchTerm) {
        return res.status(400).json({ success: false, message: "Please specify a name" });
      }

      const regex = { $regex: searchTerm, $options: "i" };

      let leadQuery = { $or: [{ leadName: regex }, { companyName: regex }] };
      if (userRole !== "Admin") leadQuery.assignTo = userId;

      let dealQuery = { $or: [{ dealName: regex }, { companyName: regex }] };
      if (userRole !== "Admin") dealQuery.assignedTo = userId;

      const [leads, deals] = await Promise.all([
        Lead.find(leadQuery).select("_id leadName companyName phoneNumber"),
        Deal.find(dealQuery).select("_id dealName companyName phoneNumber")
      ]);

      const matches = [
        ...leads.map(l => ({
          id:      l._id,
          name:    l.leadName,
          company: l.companyName || "",
          phone:   l.phoneNumber || "",
          type:    "lead"
        })),
        ...deals.map(d => ({
          id:      d._id,
          name:    d.dealName,
          company: d.companyName || "",
          phone:   d.phoneNumber || "",
          type:    "deal"
        }))
      ];

      // No matches at all
      if (matches.length === 0) {
        const msg = userRole === "Admin"
          ? `No lead or deal found for "${searchTerm}"`
          : `No assigned lead or deal found for "${searchTerm}"`;
        return res.status(404).json({ success: false, message: msg });
      }
      if (matches.length === 1) {
        return initiateCall({
          contactId:   matches[0].id,
          contactType: matches[0].type,
          userId, userRole, res, Lead, Deal, CallLog
        });
      }
      return res.json({
        success:         true,
        multipleMatches: true,
        message:         `Found ${matches.length} contacts matching "${searchTerm}". Who do you want to call?`,
        matches
      });

    } catch (error) {
      console.error("Bot error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  getSuggestions: async (req, res) => {
    try {
      const { Lead, Deal } = getModels(req);
      const userId   = req.user._id;
      const userRole = req.user.role.name;

      let leadQuery = {};
      if (userRole !== "Admin") leadQuery.assignTo = userId;
      const recentLeads = await Lead.find(leadQuery)
        .sort({ updatedAt: -1 }).limit(3)
        .select("leadName companyName phoneNumber");

      let dealQuery = {};
      if (userRole !== "Admin") dealQuery.assignedTo = userId;
      const recentDeals = await Deal.find(dealQuery)
        .sort({ updatedAt: -1 }).limit(3)
        .select("dealName companyName phoneNumber");

      res.json({
        success: true,
        suggestions: [
          ...recentLeads.map(l => ({
            command: `call ${l.companyName || l.leadName}`,
            label:   `${l.leadName} - ${l.companyName || "No company"}`,
            phone:   l.phoneNumber,
            type:    "lead"
          })),
          ...recentDeals.map(d => ({
            command: `call ${d.companyName || d.dealName}`,
            label:   `${d.dealName} - ${d.companyName || "No company"}`,
            phone:   d.phoneNumber,
            type:    "deal"
          }))
        ]
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
};
async function initiateCall({ contactId, contactType, userId, userRole, res, Lead, Deal, CallLog }) {
  let record, name, company, phoneRaw;

  if (contactType === "lead") {
    const q = userRole !== "Admin"
      ? { _id: contactId, assignTo: userId }
      : { _id: contactId };
    record   = await Lead.findOne(q);
    name     = record?.leadName;
    company  = record?.companyName;
    phoneRaw = record?.phoneNumber;
  } else {
    const q = userRole !== "Admin"
      ? { _id: contactId, assignedTo: userId }
      : { _id: contactId };
    record   = await Deal.findOne(q);
    name     = record?.dealName;
    company  = record?.companyName;
    phoneRaw = record?.phoneNumber;
  }

  if (!record) {
    return res.status(404).json({
      success: false,
      message: `${contactType === "lead" ? "Lead" : "Deal"} not found or not assigned to you`
    });
  }

  const phoneNumber = phoneRaw?.replace(/\D/g, "");
  if (!phoneNumber) {
    return res.status(400).json({
      success: false,
      message: `${name} has no phone number`
    });
  }

  const sessionId = uuidv4();
  const logData   = {
    userId,
    callType:       "whatsapp",
    phoneNumber,
    callStatus:     "initiated",
    initiatedBy:    "bot",
    sessionId,
    trackingMethod: "visibility",
    metadata:       { contactType, source: contactType }
  };
  if (contactType === "lead") logData.leadId = contactId;
  else                        logData.dealId  = contactId;

  const callLog = new CallLog(logData);
  await callLog.save();

  const baseUrl = process.env.BACKEND_URL || 'http://localhost:5000';

  return res.json({
    success:    true,
    message:    ` Ready to call ${name}`,
    sourceType: contactType,
    lead: { id: record._id, name, company, phone: phoneNumber },
    callLog:    { id: callLog._id, sessionId, phoneNumber },
    whatsappUrl: `https://wa.me/${phoneNumber}`,
    dialerUrl:   `tel:${phoneNumber}`,
    tracking: {
      sessionId,
      startUrl: `${baseUrl}/api/calllogs/track/${sessionId}/start`,
      endUrl:   `${baseUrl}/api/calllogs/track/${sessionId}/end`
    }
  });
}