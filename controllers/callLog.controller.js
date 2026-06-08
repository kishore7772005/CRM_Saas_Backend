import CallLog from "../models/callLog.model.js";
import { v4 as uuidv4 } from 'uuid';
export default {
  // Create a new call log entry 
  createCallLog: async (req, res) => {
    try {
      const sessionId = uuidv4();
      const callLogData = {
        ...req.body,
        userId: req.user._id,
        sessionId,
        startTime: new Date(),
        callStatus: "initiated",
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip
      };
      const callLog = new CallLog(callLogData);
      await callLog.save();
      await callLog.populate("leadId", "leadName companyName phoneNumber");
      res.status(201).json({
        success: true,
        data: callLog,
        sessionId
      });
    } catch (error) {
      console.error("Create call log error:", error);
      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  },
  // Track when a call starts 
  trackCallStart: async (req, res) => {
    try {
      const { sessionId } = req.params;
      const callLog = await CallLog.findOne({ sessionId });
      if (!callLog) {
        return res.status(404).json({
          success: false,
          message: "Call session not found"
        });
      }
      callLog.startTime = new Date();
      callLog.callStatus = "in-progress";
      callLog.trackingMethod = "visibility";
      await callLog.save();
      res.json({
        success: true,
        message: "Call start tracked",
        startTime: callLog.startTime
      });
    } catch (error) {
      console.error("Track call start error:", error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  },
  // Track when a call ends and calculate duration
  trackCallEnd: async (req, res) => {
    try {
      const { sessionId } = req.params;
      const callLog = await CallLog.findOne({ sessionId });
      if (!callLog) {
        return res.status(404).json({
          success: false,
          message: "Call session not found"
        });
      }
      callLog.endTime = new Date();
      callLog.callStatus = "completed";
      await callLog.save();
      res.json({
        success: true,
        message: "Call end tracked",
        duration: callLog.duration,
        formattedDuration: callLog.formattedDuration
      });
    } catch (error) {
      console.error("Track call end error:", error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  },
  // AUTO-TRACK:  (for real-time tracking)
  trackHeartbeat: async (req, res) => {
    try {
      const { sessionId } = req.params;
      const callLog = await CallLog.findOne({ sessionId });
      if (!callLog) {
        return res.status(404).json({
          success: false,
          message: "Call session not found"
        });
      }
      // Update last activity
      callLog.metadata.set('lastHeartbeat', new Date());
      await callLog.save();
      res.json({
        success: true,
        message: "Heartbeat received"
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  },
  // Retrieve paginated call logs 
  getCallLogs: async (req, res) => {
    try {
      const { leadId, days = 30, page = 1, limit = 20 } = req.query;
      const query = { userId: req.user._id };
      if (leadId) query.leadId = leadId;
      if (days) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(days));
        query.createdAt = { $gte: startDate };
      }
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const [logs, total] = await Promise.all([
        CallLog.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .populate("leadId", "leadName companyName phoneNumber"),
        CallLog.countDocuments(query)
      ]);
      const stats = {
        total: total,
        completed: logs.filter(l => l.callStatus === "completed").length,
        missed: logs.filter(l => l.callStatus === "missed").length,
        avgDuration: logs.reduce((acc, l) => acc + (l.duration || 0), 0) / (logs.length || 1)
      };
      res.json({
        success: true,
        data: logs,
        stats,
        pagination: {
          total,
          page: parseInt(page),
          pages: Math.ceil(total / parseInt(limit))
        }
      });
    } catch (error) {
      console.error("Get call logs error:", error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  },
  // Get a single call log by ID with populated lead data
  getCallLogById: async (req, res) => {
    try {
      const { id } = req.params;
      const callLog = await CallLog.findOne({
        _id: id,
        userId: req.user._id
      }).populate("leadId", "leadName companyName phoneNumber");
      if (!callLog) {
        return res.status(404).json({
          success: false,
          message: "Call log not found"
        });
      }
      res.json({
        success: true,
        data: callLog
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  },
  // Update an existing call log entry
  updateCallLog: async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const callLog = await CallLog.findOneAndUpdate(
        { _id: id, userId: req.user._id },
        updates,
        { new: true }
      ).populate("leadId", "leadName companyName");
      if (!callLog) {
        return res.status(404).json({
          success: false,
          message: "Call log not found"
        });
      }
      res.json({
        success: true,
        data: callLog
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  },
  // Get aggregated call 
  getCallStats: async (req, res) => {
    try {
      const userId = req.user._id;
      const { days = 30 } = req.query;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - parseInt(days));
      const stats = await CallLog.aggregate([
        {
          $match: {
            userId,
            createdAt: { $gte: startDate }
          }
        },
        {
          $facet: {
            byStatus: [
              { $group: { _id: "$callStatus", count: { $sum: 1 } } }
            ],
            byDay: [
              {
                $group: {
                  _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                  count: { $sum: 1 },
                  avgDuration: { $avg: "$duration" }
                }
              },
              { $sort: { _id: -1 } },
              { $limit: 7 }
            ],
            totals: [
              {
                $group: {
                  _id: null,
                  totalCalls: { $sum: 1 },
                  totalDuration: { $sum: "$duration" },
                  avgDuration: { $avg: "$duration" },
                  completedCalls: {
                    $sum: { $cond: [{ $eq: ["$callStatus", "completed"] }, 1, 0] }
                  },
                  missedCalls: {
                    $sum: { $cond: [{ $eq: ["$callStatus", "missed"] }, 1, 0] }
                  }
                }
              }
            ]
          }
        }
      ]);
      res.json({
        success: true,
        data: stats[0]
      });
    } catch (error) {
      console.error("Get call stats error:", error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
};