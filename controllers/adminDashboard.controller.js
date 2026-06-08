import Lead from "../models/leads.model.js";
import Deal from "../models/deals.model.js";
import Invoice from "../models/invoice.model.js";
import { getExchangeRate } from "../services/currencyService.js";

export default {
// Fetches dashboard summary data including total leads, won deals, revenue by currency, and pending invoices by currency
// Supports date range filtering via start/end query parameters
// Role-based access: Admin sees all data, Sales sees only their assigned data
getDashboardSummary: async (req, res) => {
    try {
      const { start, end } = req.query;
      let dateFilter = {};

      if (start || end) {
        dateFilter.createdAt = {};
        if (start) dateFilter.createdAt.$gte = new Date(start);
        if (end) {
          const endDate = new Date(end);
          endDate.setHours(23, 59, 59, 999);
          dateFilter.createdAt.$lte = endDate;
        }
      }

      const totalLeads = await Lead.countDocuments(dateFilter);

      let wonDateFilter = {};

      if (start || end) {
        wonDateFilter.wonAt = {};
        if (start) wonDateFilter.wonAt.$gte = new Date(start);
        if (end) {
          const endDate = new Date(end);
          endDate.setHours(23, 59, 59, 999);
          wonDateFilter.wonAt.$lte = endDate;
        }
      }

      const totalDealsWon = await Deal.countDocuments({
        stage: "Closed Won",
        ...wonDateFilter,
      });

      // Get user role
      const userRole = req.user?.role?.name?.toLowerCase();
      const userId = req.user?._id;

      // ========== REVENUE BY CURRENCY (PAID INVOICES) ==========
      const revenueByCurrency = {};
      
      let paidQuery = {
        status: "paid",
        ...(dateFilter.createdAt && { createdAt: dateFilter.createdAt })
      };
      
      if (userRole !== "admin") {
        paidQuery.assignTo = userId;
      }
      
      const paidInvoices = await Invoice.find(paidQuery);

      paidInvoices.forEach(inv => {
        const curr = inv.currency;
        const amount = Number(inv.total);
        const inrValue = inv.inrAmount || amount;
        
        if (!revenueByCurrency[curr]) {
          revenueByCurrency[curr] = { amount: 0, inr: 0, count: 0 };
        }
        
        revenueByCurrency[curr].amount += amount;
        revenueByCurrency[curr].inr += inrValue;
        revenueByCurrency[curr].count += 1;
      });

      // ========== PENDING INVOICES BY CURRENCY ==========
      const pendingInvoicesByCurrency = {};
      
      let pendingQuery = {
        status: "unpaid",
        ...(dateFilter.createdAt && { createdAt: dateFilter.createdAt })
      };
      
      if (userRole !== "admin") {
        pendingQuery.assignTo = userId;
      }
      
      const pendingInvoices = await Invoice.find(pendingQuery);
      
      // Group pending invoices by currency
      const pendingGrouped = {};
      pendingInvoices.forEach(inv => {
        const curr = inv.currency;
        const amount = Number(inv.total);
        if (!pendingGrouped[curr]) {
          pendingGrouped[curr] = { amount: 0, count: 0 };
        }
        pendingGrouped[curr].amount += amount;
        pendingGrouped[curr].count += 1;
      });

      // Calculate INR values for pending invoices
      for (const [currency, data] of Object.entries(pendingGrouped)) {
        const rate = await getExchangeRate(currency);
        const inrValue = data.amount * rate;
        pendingInvoicesByCurrency[currency] = {
          amount: data.amount,
          inr: inrValue,
          count: data.count,
        };
      }

      res.json({
        totalLeads,
        totalDealsWon,
        revenueByCurrency,
        pendingInvoicesByCurrency,
      });
    } catch (error) {
      console.error("Dashboard summary error:", error);
      res.status(500).json({ message: "Server Error" });
    }
  },

  // Retrieves pipeline data by aggregating deals and grouping them by their current stage
  // Supports date range filtering via start/end query parameters
  // Returns count of deals in each stage (e.g., Lead, Proposal, Negotiation, Closed Won, etc.)
  getPipeline: async (req, res) => {
    try {
      const { start, end } = req.query;
      let matchFilter = {};

      if (start || end) {
        matchFilter.createdAt = {};
        if (start) matchFilter.createdAt.$gte = new Date(start);
        if (end) {
          const endDate = new Date(end);
          endDate.setHours(23, 59, 59, 999);
          matchFilter.createdAt.$lte = endDate;
        }
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