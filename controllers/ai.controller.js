import DealLegacy from "../models/deals.model.js";
import LeadLegacy from "../models/leads.model.js";
import UserLegacy from "../models/user.model.js";
import { getTenantModels } from "../models/tenant/index.js";

const getModels = (req) => {
  if (req.tenantDB) {
    const m = getTenantModels(req.tenantDB);
    return { Deal: m.Deal, Lead: m.Lead, User: m.User };
  }
  return { Deal: DealLegacy, Lead: LeadLegacy, User: UserLegacy };
};

export default {
  processMessage: async (req, res) => {
    try {
      const { Deal, Lead, User } = getModels(req);

      const payload = req.method === "GET" ? req.query : req.body;
      const { message } = payload;

      if (!message) {
        return res.status(400).json({
          success: false,
          message: "Message required"
        });
      }

      const userId = req.user._id;

      const roleName =
        typeof req.user.role === "object"
          ? req.user.role.name
          : req.user.role;

      const lower = message.toLowerCase();
      if (lower.includes("deals won") || lower.includes("won deals") || (lower.includes("won") && lower.includes("deal"))) {

        let query = { stage: "Closed Won" };
        if (roleName !== "Admin") query.assignedTo = userId;

        const deals = await Deal.find(query)
          .populate("assignedTo", "firstName lastName email")
          .sort({ createdAt: -1 });

        return res.json({
          success: true,
          intent: "deals-won",
          message: `You have ${deals.length} won deals.`,
          count: deals.length,
          data: deals.map(formatDeal)
        });
      }
      if (lower.includes("deals lost") || lower.includes("lost deals") || (lower.includes("lost") && lower.includes("deal"))) {

        let query = { stage: "Closed Lost" };
        if (roleName !== "Admin") query.assignedTo = userId;

        const deals = await Deal.find(query)
          .populate("assignedTo", "firstName lastName email")
          .sort({ createdAt: -1 });

        return res.json({
          success: true,
          intent: "deals-lost",
          message: `You have ${deals.length} lost deals.`,
          count: deals.length,
          data: deals.map(formatDeal)
        });
      }
      if (lower.includes("open deals") || lower.includes("deals open") || (lower.includes("open") && lower.includes("deal"))) {

        let query = { stage: { $nin: ["Closed Won", "Closed Lost"] } };
        if (roleName !== "Admin") query.assignedTo = userId;

        const deals = await Deal.find(query)
          .populate("assignedTo", "firstName lastName email")
          .sort({ createdAt: -1 });

        return res.json({
          success: true,
          intent: "deals-open",
          message: `You have ${deals.length} open deals.`,
          count: deals.length,
          data: deals.map(formatDeal)
        });
      }
      if (lower.includes("my deals") || lower === "my deals") {

        const deals = await Deal.find({ assignedTo: userId })
          .populate("assignedTo", "firstName lastName email")
          .sort({ createdAt: -1 });

        return res.json({
          success: true,
          intent: "my-deals",
          message: `You have ${deals.length} deal${deals.length !== 1 ? 's' : ''} assigned to you.`,
          count: deals.length,
          data: deals.map(formatDeal)
        });
      }
      if (lower.includes("deals by") || lower.includes("deals of") || lower.includes("assigned to") || lower.includes("handled by")) {

        let searchName = lower
          .replace(/deals by|deals of|assigned to|handled by|show|get|find|search|for|name/gi, '')
          .trim();

        if (searchName.length > 1) {

          const nameParts = searchName.split(" ");

          let userQuery;

          if (nameParts.length > 1) {
            userQuery = {
              $or: [
                { firstName: { $regex: nameParts[0], $options: "i" }, lastName: { $regex: nameParts[1], $options: "i" } },
                { firstName: { $regex: nameParts[1], $options: "i" }, lastName: { $regex: nameParts[0], $options: "i" } }
              ]
            };
          } else {
            userQuery = {
              $or: [
                { firstName: { $regex: searchName, $options: "i" } },
                { lastName: { $regex: searchName, $options: "i" } }
              ]
            };
          }

          const salespersons = await User.find(userQuery).select("_id firstName lastName email");

          if (salespersons.length > 0) {

            const userIds = salespersons.map(sp => sp._id);

            const deals = await Deal.find({
              assignedTo: { $in: userIds }
            })
              .populate("assignedTo", "firstName lastName email")
              .sort({ createdAt: -1 });

            const salespersonNames = salespersons.map(sp => `${sp.firstName} ${sp.lastName}`).join(", ");

            return res.json({
              success: true,
              intent: "deals-by-salesperson",
              message: deals.length > 0
                ? `Found ${deals.length} deals handled by ${salespersonNames}`
                : `No deals found for ${salespersonNames}`,
              count: deals.length,
              data: deals.map(formatDeal)
            });

          }

        }

      }
      if (lower.includes("deal ") && !lower.includes("deals ")) {

        let searchTerm = lower
          .replace(/deal|show|get|find|search|for|about|named|called/gi, '')
          .trim();

        if (searchTerm.length > 1) {

          let query = {
            dealName: { $regex: searchTerm, $options: "i" }
          };

          if (roleName !== "Admin") {
            query.assignedTo = userId;
          }

          const deals = await Deal.find(query)
            .populate("assignedTo", "firstName lastName email")
            .sort({ createdAt: -1 });

          return res.json({
            success: true,
            intent: "deal-search",
            message: deals.length > 0
              ? `Found ${deals.length} deals matching "${searchTerm}"`
              : `No deals found matching "${searchTerm}"`,
            count: deals.length,
            data: deals.map(formatDeal)
          });
        }

      }
      if (lower.includes("hot leads")) {
        return handleLeadStatus("Hot", userId, roleName, res, Lead);
      }

      if (lower.includes("warm leads")) {
        return handleLeadStatus("Warm", userId, roleName, res, Lead);
      }

      if (lower.includes("cold leads")) {
        return handleLeadStatus("Cold", userId, roleName, res, Lead);
      }

      if (lower.includes("my leads")) {

        const leads = await Lead.find({ assignTo: userId })
          .populate("assignTo", "firstName lastName email")
          .sort({ createdAt: -1 });

        return res.json({
          success: true,
          intent: "my-leads",
          message: `You have ${leads.length} leads assigned to you.`,
          count: leads.length,
          data: leads.map(formatLead)
        });
      }
      return res.json({
        success: true,
        intent: "unknown",
        message: "Try: 'deals by rosy', 'deal carcare', 'open deals', 'hot leads', 'my deals'",
        data: []
      });

    }
    catch (err) {

      console.error("AI ERROR:", err);

      res.status(500).json({
        success: false,
        message: "AI processing failed",
        error: err.message
      });

    }

  }

};
async function handleLeadStatus(status, userId, roleName, res, Lead) {

  let query = { status };

  if (roleName !== "Admin") query.assignTo = userId;

  const leads = await Lead.find(query)
    .populate("assignTo", "firstName lastName email")
    .sort({ createdAt: -1 });

  return res.json({
    success: true,
    intent: `leads-${status.toLowerCase()}`,
    message: `You have ${leads.length} ${status.toLowerCase()} leads.`,
    count: leads.length,
    data: leads.map(formatLead)
  });

}


// Format deal object for consistent API response structure
function formatDeal(deal) {

  return {
    _id: deal._id,
    dealName: deal.dealName,
    name: deal.dealName,
    stage: deal.stage,
    status: deal.stage,
    value: deal.value && deal.value > 0 ? `$${deal.value}` : null,
    companyName: deal.companyName,
    company: deal.companyName,
    phoneNumber: deal.phoneNumber,
    phone: deal.phoneNumber,
    handledBy: deal.assignedTo
      ? `${deal.assignedTo.firstName} ${deal.assignedTo.lastName}`
      : "Unassigned",
    assignedTo: deal.assignedTo,
    createdAt: deal.createdAt,
    type: "deal"
  };

}


// Format lead object for consistent API response structure
function formatLead(lead) {

  return {
    _id: lead._id,
    leadName: lead.leadName,
    name: lead.leadName,
    phoneNumber: lead.phoneNumber,
    phone: lead.phoneNumber,
    email: lead.email,
    companyName: lead.companyName,
    company: lead.companyName,
    status: lead.status,
    source: lead.source,
    handledBy: lead.assignTo
      ? `${lead.assignTo.firstName} ${lead.assignTo.lastName}`
      : "Unassigned",
    assignTo: lead.assignTo,
    createdAt: lead.createdAt,
    type: "lead"
  };

}