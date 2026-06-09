import { getTenantModels } from "../models/tenant/index.js";
import { getExchangeRate }  from "../services/currencyService.js";

// Legacy fallbacks
import LeadLegacy    from "../models/leads.model.js";
import DealLegacy    from "../models/deals.model.js";
import InvoiceLegacy from "../models/invoice.model.js";

const getModels = (req) => {
  if (req.tenantDB) return getTenantModels(req.tenantDB);
  return { Lead: LeadLegacy, Deal: DealLegacy, Invoice: InvoiceLegacy };
};

export default {
  getDashboardSummary: async (req, res) => {
    try {
      const { Lead, Deal, Invoice } = getModels(req);
      const { start, end } = req.query;
      let dateFilter = {};
      if (start || end) {
        dateFilter.createdAt = {};
        if (start) dateFilter.createdAt.$gte = new Date(start);
        if (end) { const e = new Date(end); e.setHours(23, 59, 59, 999); dateFilter.createdAt.$lte = e; }
      }

      const totalLeads = await Lead.countDocuments(dateFilter);

      let wonDateFilter = {};
      if (start || end) {
        wonDateFilter.wonAt = {};
        if (start) wonDateFilter.wonAt.$gte = new Date(start);
        if (end) { const e = new Date(end); e.setHours(23, 59, 59, 999); wonDateFilter.wonAt.$lte = e; }
      }

      const totalDealsWon = await Deal.countDocuments({ stage: "Closed Won", ...wonDateFilter });

      const userRole = req.user?.role?.name?.toLowerCase();
      const userId   = req.user?._id;

      const revenueByCurrency = {};
      let paidQuery = { status: "paid", ...(dateFilter.createdAt && { createdAt: dateFilter.createdAt }) };
      if (userRole !== "admin") paidQuery.assignTo = userId;
      const paidInvoices = await Invoice.find(paidQuery);
      paidInvoices.forEach(inv => {
        const curr   = inv.currency;
        const amount = Number(inv.total);
        const inrValue = inv.inrAmount || amount;
        if (!revenueByCurrency[curr]) revenueByCurrency[curr] = { amount: 0, inr: 0, count: 0 };
        revenueByCurrency[curr].amount += amount;
        revenueByCurrency[curr].inr    += inrValue;
        revenueByCurrency[curr].count  += 1;
      });

      const pendingInvoicesByCurrency = {};
      let pendingQuery = { status: "unpaid", ...(dateFilter.createdAt && { createdAt: dateFilter.createdAt }) };
      if (userRole !== "admin") pendingQuery.assignTo = userId;
      const pendingInvoices = await Invoice.find(pendingQuery);
      const pendingGrouped  = {};
      pendingInvoices.forEach(inv => {
        const curr   = inv.currency;
        const amount = Number(inv.total);
        if (!pendingGrouped[curr]) pendingGrouped[curr] = { amount: 0, count: 0 };
        pendingGrouped[curr].amount += amount;
        pendingGrouped[curr].count  += 1;
      });
      for (const [currency, data] of Object.entries(pendingGrouped)) {
        const rate    = await getExchangeRate(currency);
        const inrValue = data.amount * rate;
        pendingInvoicesByCurrency[currency] = { amount: data.amount, inr: inrValue, count: data.count };
      }

      res.json({ totalLeads, totalDealsWon, revenueByCurrency, pendingInvoicesByCurrency });
    } catch (error) {
      console.error("Dashboard summary error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  getPipeline: async (req, res) => {
    try {
      const { Deal } = getModels(req);
      const { start, end } = req.query;
      let matchFilter = {};
      if (start || end) {
        matchFilter.createdAt = {};
        if (start) matchFilter.createdAt.$gte = new Date(start);
        if (end) { const e = new Date(end); e.setHours(23, 59, 59, 999); matchFilter.createdAt.$lte = e; }
      }
      const pipeline = await Deal.aggregate([
        { $match: matchFilter },
        { $group: { _id: "$stage", count: { $sum: 1 } } },
        { $project: { stage: "$_id", leads: "$count", _id: 0 } },
      ]);
      res.json(pipeline);
    } catch (err) {
      console.error("Pipeline error:", err);
      res.status(500).json({ message: err.message });
    }
  },
};
