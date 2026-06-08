import User from "../models/user.model.js";
import Lead from "../models/leads.model.js";
import Activity from "../models/activity.models.js";
import Invoice from "../models/invoice.model.js";
import mongoose from "mongoose";

const getSalesPerformance = async (req, res) => {
  try {
    const { userId, startDate, endDate } = req.query;

    // 1. Validate userId
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid or missing userId" });
    }

    // 2. Fetch user with login history
    const user = await User.findById(userId).select(
      "firstName lastName email role loginHistory"
    );
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 3. Filter loginHistory by date range if provided
    let loginData = [];
    if (user.loginHistory && Array.isArray(user.loginHistory)) {
      loginData = user.loginHistory.filter((item) => {
        if (!item.login) return false;
        const itemDate = new Date(item.login);
        if (startDate && endDate) {
          const start = new Date(startDate);
          start.setHours(0, 0, 0, 0);
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          return itemDate >= start && itemDate <= end;
        }
        if (startDate) {
          const start = new Date(startDate);
          start.setHours(0, 0, 0, 0);
          const end = new Date(startDate);
          end.setHours(23, 59, 59, 999);
          return itemDate >= start && itemDate <= end;
        }
        return true; 
      });
    }

    // 4. Build date filter for other collections
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
    }

    // 5. Fetch leads assigned to this user
    const leads = await Lead.find({
      assignTo: user._id,
      ...dateFilter,
    }).lean();

    // 6. Fetch activities assigned to this user
    const activities = await Activity.find({
      assignedTo: user._id,
      ...dateFilter,
    }).lean();

    // 7. Fetch invoices (gracefully handle if model not available)
    let invoices = [];
    try {
      invoices = await Invoice.find({
        assignedTo: user._id,
        ...dateFilter,
      }).lean();
    } catch (invoiceErr) {
      console.warn("Invoice model may not be set up – ignoring:", invoiceErr.message);
    }

    // 8. Send response
    res.status(200).json({
      salesperson: {
        _id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
      },
      loginHistory: loginData,
      metrics: {
        totalLeadsAssigned: leads.length,
        totalActivitiesAssigned: activities.length,
        totalInvoicesAssigned: invoices.length,
      },
      leads,
      activities,
      invoices,
    });
  } catch (err) {
    console.error(" Error in getSalesPerformance:", err);
    res.status(500).json({ message: err.message });
  }
};

export default {
  getSalesPerformance,
};