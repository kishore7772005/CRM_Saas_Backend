import ClientLTV from "../models/ClientLTV.js";
import Deal from "../models/deals.model.js";
import SupportTicket from "../models/SupportTicket.js";
import Renewal from "../models/Renewal.js";
import ClientReview from "../models/ClientReview.js";
import PricingRisk from "../models/PricingRisk.js";

// ---------- Helper functions ----------

async function getSupportMetrics(companyId) {
  const tickets = await SupportTicket.find({ companyId }).sort({ openedAt: -1 }).lean();
  const total = tickets.length;
  const open = tickets.filter(t => t.status === "Open").length;
  const lastSupportDate = total > 0 ? tickets[0].openedAt : null;

  // Calculate support points (100 - (tickets * 5), min 0)
  const supportPoints = Math.max(0, 100 - (total * 5));

  let avgResolutionHours = 0;
  const closed = tickets.filter(t => t.status === "Closed" && t.resolutionTimeHours);
  if (closed.length > 0) {
    avgResolutionHours = closed.reduce((sum, t) => sum + (t.resolutionTimeHours || 0), 0) / closed.length;
  }

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const recent = tickets.filter(t => new Date(t.openedAt) >= sixMonthsAgo);
  const perMonth = recent.length / 6;

  return { total, open, lastSupportDate, avgResolutionHours, perMonth, supportPoints };
}

// Get follow-up metrics directly from deal using action dates
async function getFollowUpMetrics(dealId) {
  const deal = await Deal.findById(dealId).lean();
  
  if (!deal) return { count: 0, lastDate: null, daysSince: 365 };
  
  // Get count from followUpHistory
  const followUpCount = deal.followUpHistory?.length || 0;
  
  // Get the most recent follow-up action date from history
  let lastFollowUpDate = null;
  
  if (deal.followUpHistory && deal.followUpHistory.length > 0) {
    // Sort history by action date (most recent first)
    const sortedHistory = [...deal.followUpHistory].sort((a, b) => {
      const dateA = a.date ? new Date(a.date).getTime() : 0;
      const dateB = b.date ? new Date(b.date).getTime() : 0;
      return dateB - dateA;
    });
    
    lastFollowUpDate = sortedHistory[0]?.date || null;
  } else if (deal.followUpDate) {
    lastFollowUpDate = deal.followUpDate;
  }
  
  // Calculate days since last follow-up
  const daysSince = calculateDaysSinceFollowUp(lastFollowUpDate);
  
  return { 
    count: followUpCount, 
    lastDate: lastFollowUpDate,
    daysSince 
  };
}

// Calculate days since follow-up
const calculateDaysSinceFollowUp = (lastFollowUpDate) => {
  if (!lastFollowUpDate) return 365;
  
  const lastDate = new Date(lastFollowUpDate);
  const now = new Date();
  
  lastDate.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  
  const diffTime = now - lastDate;
  const days = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  
  return Math.max(0, days);
};

/**
 *  CLASSIFICATION LOGIC
 */
const classifyDeal = ({
  totalRevenue = 0,
  supportTickets = 0,
  clientHealthScore = 50,
  daysSinceFollowUp = 0,
  progress = "average",
}) => {

  // Force Safe Number Conversion
  totalRevenue = Number(totalRevenue);
  supportTickets = Number(supportTickets);
  clientHealthScore = Number(clientHealthScore);
  daysSinceFollowUp = Number(daysSinceFollowUp);

  if (isNaN(totalRevenue)) totalRevenue = 0;
  if (isNaN(supportTickets)) supportTickets = 0;
  if (isNaN(clientHealthScore)) clientHealthScore = 50;
  if (isNaN(daysSinceFollowUp)) daysSinceFollowUp = 0;

  // Clamp values
  clientHealthScore = Math.min(100, Math.max(0, clientHealthScore));
  daysSinceFollowUp = Math.max(0, daysSinceFollowUp);

  // Normalize Progress
  const normalizedProgress = String(progress).trim().toLowerCase();

  // DORMANT
  if (daysSinceFollowUp > 90) {
    return "Dormant";
  }

  // UPSELL
  const isUpsell =
    normalizedProgress === "excellent" &&
    totalRevenue >= 500000 &&
    clientHealthScore >= 80 &&
    supportTickets <= 2 &&
    daysSinceFollowUp <= 30;

  if (isUpsell) {
    return "Upsell";
  }

  // AT RISK
  const isAtRisk =
    normalizedProgress === "poor" ||
    clientHealthScore < 70 ||
    supportTickets >= 5 ||
    daysSinceFollowUp > 30;

  if (isAtRisk) {
    return "At Risk";
  }

  // TOP VALUE
  return "Top Value";
};

// Value category based on deal amount
const getValueCategory = (amount) => {
  if (amount > 500000) return "High Value";
  if (amount >= 100000 && amount <= 500000) return "Medium Value";
  return "Low Value";
};

/**
 * PRICING CALCULATION
 */
const calculatePricingRecommendation = (metrics) => {
  const { progress, supportTickets, clientHealthScore, totalRevenue, delivered } = metrics;
  
  const normalizedProgress = String(progress).trim().toLowerCase();
  
  // Progress-based discount
  let progressDiscount = 0;
  switch(normalizedProgress) {
    case "excellent": progressDiscount = 30; break;
    case "good": progressDiscount = 30; break;
    case "average": progressDiscount = 20; break;
    case "poor": progressDiscount = 0; break;
    default: progressDiscount = 20;
  }
  
  // Support ticket override
  let supportDiscount = 30;
  if (supportTickets > 10) supportDiscount = 0;
  else if (supportTickets > 5) supportDiscount = 20;
  else if (supportTickets > 2) supportDiscount = 30;
  else supportDiscount = 30;
  
  // Health score discount
  let healthDiscount = 0;
  if (clientHealthScore > 75) healthDiscount = 30;
  else if (clientHealthScore > 50) healthDiscount = 20;
  else healthDiscount = 0;
  
  // Delivery bonus
  const deliveryBonus = delivered ? 15 : 0;
  
  // Calculate final discount
  const discounts = [progressDiscount, supportDiscount, healthDiscount, deliveryBonus];
  const averageDiscount = discounts.reduce((a, b) => a + b, 0) / discounts.length;
  const finalDiscount = Math.min(Math.round(averageDiscount), 50);
  
  // Suggested price range
  const minPrice = Math.round(totalRevenue * (1 - finalDiscount / 100));
  const maxPrice = Math.round(totalRevenue * 1.1);
  
  // Confidence score
  let confidenceScore = 70;
  if (supportTickets < 3 && normalizedProgress === "excellent") confidenceScore = 90;
  else if (supportTickets > 10 || normalizedProgress === "poor") confidenceScore = 50;
  
  return {
    suggestedMinPrice: minPrice,
    suggestedMaxPrice: maxPrice,
    recommendedDiscount: finalDiscount,
    confidenceScore,
    deliveryBonus
  };
};

/**
 * Clean up invalid clients
 */
const cleanupInvalidClients = async () => {
  try {
    const activeWonDealIds = await Deal.find({ stage: "Closed Won" }).distinct("_id");
    const result = await ClientLTV.deleteMany({
      companyId: { $nin: activeWonDealIds }
    });
    
    if (result.deletedCount > 0) {
      console.log(`🧹 Cleaned up ${result.deletedCount} invalid clients from CLV collection`);
    }
    
    return result.deletedCount;
  } catch (error) {
    console.error("Error cleaning up invalid clients:", error);
    return 0;
  }
};

/**
 * Recalculate metrics from deal data
 */
const recalculateMetricsFromDeal = async (companyId, companyName) => {
  try {
    const deal = await Deal.findById(companyId).lean();
    if (!deal) {
      console.error(`Deal not found for companyId: ${companyId}`);
      return null;
    }

    // Only process Closed Won deals
    if (deal.stage !== "Closed Won") {
      console.log(` Deal ${companyName} is not Closed Won - removing from CLV`);
      await ClientLTV.findOneAndDelete({ companyId });
      return null;
    }

    // Get the latest review
    const latestReview = await ClientReview.findOne({ companyId }).sort({ reviewedAt: -1 }).lean();

    // Parse numeric value
    const numericMatch = deal.value?.toString().match(/\d+/g);
    const totalRevenue = numericMatch ? parseInt(numericMatch.join('')) : 0;

    // Get support metrics
    const supportMetrics = await getSupportMetrics(companyId);
    const supportTickets = supportMetrics.total;

    // Get follow-up metrics directly from deal
    const followUpMetrics = await getFollowUpMetrics(companyId);
    const followUpCount = followUpMetrics.count;
    const lastFollowUpDate = followUpMetrics.lastDate;
    const daysSinceFollowUp = followUpMetrics.daysSince;

    // Use review data if available
    const progress = latestReview?.progress || "Average";
    const clientHealthScore = latestReview?.clientHealthScore || 50;
    const delivered = latestReview?.delivered || false;

    // Prepare metrics for classification
    const metrics = {
      totalRevenue,
      supportTickets,
      clientHealthScore,
      daysSinceFollowUp,
      progress
    };

    // Get classification
    const classification = classifyDeal(metrics);
    
    // Generate reason
    let reason = "";
    const riskFactors = [];
    if (daysSinceFollowUp > 60) riskFactors.push(`No follow-up for ${daysSinceFollowUp} days`);
    if (supportTickets > 10) riskFactors.push(`${supportTickets} support tickets`);
    if (clientHealthScore < 50) riskFactors.push(`Low health score: ${clientHealthScore}`);
    
    switch(classification) {
      case "Upsell":
        reason = `Upsell: ${supportTickets} tickets, revenue > ₹500k, health ${clientHealthScore}`;
        break;
      case "Top Value":
        reason = `Top value: revenue > ₹500k, ${supportTickets} tickets, health ${clientHealthScore}, recent follow-up`;
        break;
      case "Dormant":
        reason = `Dormant: ${supportTickets} tickets, value < ₹500k, no follow-up for ${daysSinceFollowUp} days`;
        break;
      case "At Risk":
        reason = riskFactors.length > 0 
          ? `At risk: ${riskFactors.join(", ")}`
          : `At risk: Health score ${clientHealthScore}, ${daysSinceFollowUp} days inactive, ${supportTickets} tickets`;
        break;
    }
    
    // Calculate value category
    const valueCategory = getValueCategory(totalRevenue);
    
    // Get risk factors (re-calc for storage)
    const finalRiskFactors = [];
    if (daysSinceFollowUp > 60) finalRiskFactors.push(`No follow-up for ${daysSinceFollowUp} days`);
    if (supportTickets > 10) finalRiskFactors.push(`${supportTickets} support tickets`);
    if (clientHealthScore < 50) finalRiskFactors.push(`Low health score: ${clientHealthScore}`);
    
    // Calculate pricing recommendation
    const pricing = calculatePricingRecommendation({
      progress,
      supportTickets,
      clientHealthScore,
      totalRevenue,
      delivered
    });

    // Update or create ClientLTV
    let clientLTV = await ClientLTV.findOne({ companyId });

    if (!clientLTV) {
      clientLTV = new ClientLTV({
        companyId,
        companyName
      });
    }

    // Update all fields
    clientLTV.totalRevenue = totalRevenue;
    clientLTV.totalDeals = 1;
    clientLTV.lastFollowUpDate = lastFollowUpDate;
    clientLTV.daysSinceFollowUp = daysSinceFollowUp;
    clientLTV.totalSupportTickets = supportTickets;
    clientLTV.supportPoints = supportMetrics.supportPoints;
    clientLTV.followUpCount = followUpCount;
    clientLTV.openSupportTickets = supportMetrics.open;
    clientLTV.lastSupportDate = supportMetrics.lastSupportDate;
    clientLTV.riskFactors = finalRiskFactors;
    clientLTV.classification = classification;
    clientLTV.classificationReason = reason;
    clientLTV.valueCategory = valueCategory;
    clientLTV.customerLifetimeValue = totalRevenue;
    clientLTV.clientHealthScore = clientHealthScore;
    clientLTV.delivered = delivered;
    clientLTV.progress = progress;
    if (latestReview) {
      clientLTV.latestReview = latestReview._id;
    }
    clientLTV.suggestedMinPrice = pricing.suggestedMinPrice;
    clientLTV.suggestedMaxPrice = pricing.suggestedMaxPrice;
    clientLTV.recommendedDiscount = pricing.recommendedDiscount;
    clientLTV.lastClassificationUpdate = new Date();

    await clientLTV.save();

    return clientLTV;
  } catch (error) {
    console.error("Error in recalculateMetricsFromDeal:", error);
    throw error;
  }
};

// Core function to calculate metrics from review data
const calculateMetricsFromReview = async (companyId, companyName, reviewData) => {
  try {
    // Get the deal
    const deal = await Deal.findById(companyId).lean();
    if (!deal) {
      console.error(`Deal not found for companyId: ${companyId}`);
      return null;
    }

    // Parse numeric value
    const numericMatch = deal.value?.toString().match(/\d+/g);
    const totalRevenue = numericMatch ? parseInt(numericMatch.join('')) : 0;

    // Use supportTickets from reviewData (manual override)
    const supportTickets = reviewData.supportTickets !== undefined 
      ? reviewData.supportTickets 
      : 0;
    
    // Get support metrics
    const supportMetrics = await getSupportMetrics(companyId);
    
    // Get follow-up metrics from deal
    const followUpMetrics = await getFollowUpMetrics(companyId);
    const followUpCount = followUpMetrics.count;
    const lastFollowUpDate = followUpMetrics.lastDate;
    const daysSinceFollowUp = followUpMetrics.daysSince;

    // Prepare metrics for classification
    const metrics = {
      totalRevenue,
      supportTickets,
      clientHealthScore: reviewData.clientHealthScore || 50,
      daysSinceFollowUp,
      progress: reviewData.progress
    };

    // Get classification
    const classification = classifyDeal(metrics);
    
    // Generate reason
    let reason = "";
    const riskFactors = [];
    if (daysSinceFollowUp > 60) riskFactors.push(`No follow-up for ${daysSinceFollowUp} days`);
    if (supportTickets > 10) riskFactors.push(`${supportTickets} support tickets`);
    if (reviewData.clientHealthScore < 50) riskFactors.push(`Low health score: ${reviewData.clientHealthScore}`);
    
    switch(classification) {
      case "Upsell":
        reason = `Upsell: ${supportTickets} tickets, revenue > ₹500k, health ${reviewData.clientHealthScore}`;
        break;
      case "Top Value":
        reason = `Top value: revenue > ₹500k, ${supportTickets} tickets, health ${reviewData.clientHealthScore}, recent follow-up`;
        break;
      case "Dormant":
        reason = `Dormant: ${supportTickets} tickets, value < ₹500k, no follow-up for ${daysSinceFollowUp} days`;
        break;
      case "At Risk":
        reason = riskFactors.length > 0 
          ? `At risk: ${riskFactors.join(", ")}`
          : `At risk: Health score ${reviewData.clientHealthScore}, ${daysSinceFollowUp} days inactive, ${supportTickets} tickets`;
        break;
    }
    
    // Calculate value category
    const valueCategory = getValueCategory(totalRevenue);
    
    // Get risk factors
    const finalRiskFactors = [];
    if (daysSinceFollowUp > 60) finalRiskFactors.push(`No follow-up for ${daysSinceFollowUp} days`);
    if (supportTickets > 10) finalRiskFactors.push(`${supportTickets} support tickets`);
    if (reviewData.clientHealthScore < 50) finalRiskFactors.push(`Low health score: ${reviewData.clientHealthScore}`);
    
    // Calculate pricing recommendation
    const pricing = calculatePricingRecommendation({
      progress: reviewData.progress,
      supportTickets,
      clientHealthScore: reviewData.clientHealthScore,
      totalRevenue,
      delivered: reviewData.delivered
    });

    // Update or create ClientLTV
    let clientLTV = await ClientLTV.findOne({ companyId });

    if (!clientLTV) {
      clientLTV = new ClientLTV({
        companyId,
        companyName
      });
    }

    // Update all fields
    clientLTV.totalRevenue = totalRevenue;
    clientLTV.totalDeals = 1;
    clientLTV.lastFollowUpDate = lastFollowUpDate;
    clientLTV.daysSinceFollowUp = daysSinceFollowUp;
    clientLTV.totalSupportTickets = supportTickets;
    clientLTV.supportPoints = supportMetrics.supportPoints;
    clientLTV.followUpCount = followUpCount;
    clientLTV.openSupportTickets = supportMetrics.open;
    clientLTV.lastSupportDate = supportMetrics.lastSupportDate;
    clientLTV.riskFactors = finalRiskFactors;
    clientLTV.classification = classification;
    clientLTV.classificationReason = reason;
    clientLTV.valueCategory = valueCategory;
    clientLTV.customerLifetimeValue = totalRevenue;
    clientLTV.clientHealthScore = reviewData.clientHealthScore;
    clientLTV.delivered = reviewData.delivered === true ? true : false;
    clientLTV.progress = reviewData.progress;
    clientLTV.latestReview = reviewData._id;
    clientLTV.suggestedMinPrice = pricing.suggestedMinPrice;
    clientLTV.suggestedMaxPrice = pricing.suggestedMaxPrice;
    clientLTV.recommendedDiscount = pricing.recommendedDiscount;
    clientLTV.lastClassificationUpdate = new Date();

    await clientLTV.save();

    return clientLTV;
  } catch (error) {
    console.error("Error in calculateMetricsFromReview:", error);
    throw error;
  }
};

// ---------- CONTROLLER METHODS ----------

export default {
  //calculating the client value
  calculateClientCLV: async (req, res) => {
    try {
      const { companyName } = req.params;
      const decodedName = decodeURIComponent(companyName);

      console.log(" API: calculateClientCLV called for:", decodedName);

      const deal = await Deal.findOne({ companyName: decodedName }).lean();

      if (!deal) {
        return res.status(404).json({
          success: false,
          message: "No deal found for this company"
        });
      }

      if (deal.stage !== "Closed Won") {
        await ClientLTV.findOneAndDelete({ companyId: deal._id });
        return res.json({
          success: true,
          message: "Deal is not Closed Won - removed from CLV",
          data: null
        });
      }

      const latestReview = await ClientReview.findOne({ companyId: deal._id })
        .sort({ reviewedAt: -1 })
        .lean();

      if (!latestReview) {
        return res.status(404).json({
          success: false,
          message: "No review found for this client"
        });
      }

      const result = await calculateMetricsFromReview(
        deal._id,
        decodedName,
        latestReview
      );

      res.json({
        success: true,
        data: result,
        message: "CLV calculated successfully"
      });

    } catch (error) {
      console.error(" Error in calculateClientCLV controller:", error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  },

  // FIXED: getWonDeals with proper days calculation
  getWonDeals: async (req, res) => {
    try {
      const { 
        page = 1, 
        limit = 10, 
        classification = "all",
        showUnreviewedFirst = "true",
        search = ""
      } = req.query;
      
      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const skip = (pageNum - 1) * limitNum;

      console.log(` Fetching deals - Page: ${pageNum}, Search: "${search}", Unreviewed First: ${showUnreviewedFirst}`);

      // Helper function to calculate days since
      const calculateDaysSince = (dateToCheck) => {
        if (!dateToCheck) return 0;
        
        try {
          const lastDate = new Date(dateToCheck);
          const now = new Date();
          
          lastDate.setHours(0, 0, 0, 0);
          now.setHours(0, 0, 0, 0);
          
          const diffTime = now - lastDate;
          return Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
        } catch (error) {
          console.error("Error calculating days:", error);
          return 0;
        }
      };

      // Build search query
      let searchQuery = { stage: "Closed Won" };
      
      if (search && search.trim() !== "") {
        const searchRegex = new RegExp(search.trim(), 'i');
        searchQuery = {
          ...searchQuery,
          $or: [
            { dealName: searchRegex },
            { companyName: searchRegex }
          ]
        };
      }

      // Get TOTAL COUNT first
      const totalDeals = await Deal.countDocuments(searchQuery);
      
      if (totalDeals === 0) {
        return res.json({
          success: true,
          data: [],
          pagination: { 
            total: 0, 
            page: pageNum, 
            pages: 0,
            unreviewedCount: 0 
          }
        });
      }

      // Get ONLY the deals for this page
      const deals = await Deal.find(searchQuery)
        .select('_id dealName companyName value assignedTo wonAt createdAt followUpDate followUpHistory')
        .populate("assignedTo", "firstName lastName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean();

      const dealIds = deals.map(d => d._id.toString());

      // Get reviews for THESE deals only
      const reviews = await ClientReview.find({ 
        companyId: { $in: dealIds } 
      }).select('companyId').lean();
      
      const reviewedDealIds = new Set(reviews.map(r => r.companyId.toString()));

      // Get CLV data for THESE deals only
      const clvData = await ClientLTV.find({ 
        companyId: { $in: dealIds } 
      }).lean();
      
      const clvMap = {};
      clvData.forEach(c => { 
        if (c.companyId) clvMap[c.companyId.toString()] = c; 
      });

      // Format deals
      let formattedDeals = deals.map(deal => {
        const dealId = deal._id.toString();
        const hasReview = reviewedDealIds.has(dealId);
        const clvEntry = clvMap[dealId];

        // Calculate days using the helper function
        let daysSince = 0;
        
        if (clvEntry?.lastFollowUpDate) {
          daysSince = calculateDaysSince(clvEntry.lastFollowUpDate);
        } else if (deal.followUpDate) {
          daysSince = calculateDaysSince(deal.followUpDate);
        } else if (deal.followUpHistory && deal.followUpHistory.length > 0) {
          // Get most recent follow-up from history
          const sortedHistory = [...deal.followUpHistory].sort((a, b) => {
            const dateA = a.date ? new Date(a.date).getTime() : 0;
            const dateB = b.date ? new Date(b.date).getTime() : 0;
            return dateB - dateA;
          });
          if (sortedHistory[0]?.date) {
            daysSince = calculateDaysSince(sortedHistory[0].date);
          }
        }

        return {
          _id: deal._id,
          clientName: deal.dealName || "Unnamed",
          companyName: deal.companyName || "Unknown",
          companyId: deal._id,
          dealId: deal._id,
          dealValue: deal.value || "0",
          delivered: clvEntry?.delivered === true,
          assignedTo: deal.assignedTo
            ? `${deal.assignedTo.firstName || ''} ${deal.assignedTo.lastName || ''}`.trim()
            : "Unassigned",
          salespersonId: deal.assignedTo?._id,
          supportTicketCount: clvEntry?.totalSupportTickets || 0,
          daysSinceFollowUp: daysSince,
          reviewProgress: clvEntry?.progress || null,
          classification: clvEntry?.classification || "At Risk",
          clientHealthScore: clvEntry?.clientHealthScore || 50,
          reviewStatus: hasReview ? "Submitted" : "Pending",
          hasReview: hasReview,
          createdAt: deal.createdAt,
          followUpDate: deal.followUpDate
        };
      });

      // Create a filtered version based on classification
      let filteredDeals = formattedDeals;
      if (classification !== "all") {
        filteredDeals = formattedDeals.filter(d => d.classification === classification);
      }

      // Apply unreviewed first sorting based on the toggle
      if (showUnreviewedFirst === "true") {
        filteredDeals.sort((a, b) => {
          if (a.hasReview !== b.hasReview) {
            return a.hasReview ? 1 : -1;
          }
          return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
        });
      } else {
        filteredDeals.sort((a, b) => {
          return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
        });
      }

      // Calculate unreviewed count from ALL matching deals
      const allMatchingDeals = await Deal.find(searchQuery)
        .select('_id')
        .lean();
      
      const allDealIds = allMatchingDeals.map(d => d._id.toString());
      const allReviews = await ClientReview.find({ 
        companyId: { $in: allDealIds } 
      }).select('companyId').lean();
      
      const allReviewedDealIds = new Set(allReviews.map(r => r.companyId.toString()));
      const totalUnreviewedCount = allDealIds.filter(id => !allReviewedDealIds.has(id)).length;

      const pages = Math.ceil(totalDeals / limitNum);

      console.log(` Page ${pageNum}: Returning ${filteredDeals.length} deals, Unreviewed total: ${totalUnreviewedCount}`);

      res.json({
        success: true,
        data: filteredDeals,
        pagination: {
          total: totalDeals,
          page: pageNum,
          pages,
          unreviewedCount: totalUnreviewedCount,
          limit: limitNum
        }
      });

    } catch (error) {
      console.error("Error in getWonDeals:", error);
      res.status(500).json({ 
        success: false, 
        message: error.message 
      });
    }
  },

  //creating client reivew
  createClientReview: async (req, res) => {
    try {
      console.log("=".repeat(50));
      console.log(" RECEIVED REVIEW REQUEST:");
      console.log("Body:", JSON.stringify(req.body, null, 2));
      
      const {
        companyId,
        companyName,
        clientName,
        dealId,
        dealValue,
        delivered,
        salespersonId,
        salespersonName,
        supportTickets,
        progress,
        reviewNotes,
        clientHealthScore
      } = req.body;

      if (!companyId || !companyName || !clientName || !dealId) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields"
        });
      }

      const userId = req.user?._id || req.user?.id;

      // Create review data
      const reviewData = {
        companyId,
        companyName,
        clientName,
        dealId,
        dealValue: parseFloat(dealValue?.toString().replace(/[^0-9.-]+/g, '')) || 0,
        delivered: delivered === true ? true : false,
        salespersonId,
        salespersonName,
        supportTickets: parseInt(supportTickets) || 0,
        progress: progress || "Average",
        reviewNotes: reviewNotes || "",
        clientHealthScore: parseInt(clientHealthScore) || 50,
        reviewedAt: new Date(),
        reviewedBy: userId
      };

      console.log(" Saving review with:", {
        supportTickets: reviewData.supportTickets,
        delivered: reviewData.delivered
      });

      // Save review
      const review = await ClientReview.findOneAndUpdate(
        { companyId },
        reviewData,
        { new: true, upsert: true }
      );

      // Update deal with review reference
      await Deal.findByIdAndUpdate(dealId, {
        clientReviewId: review._id
      });

      // Create review object for metrics
      const reviewForMetrics = {
        ...review.toObject(),
        delivered: reviewData.delivered,
        supportTickets: reviewData.supportTickets
      };

      // Calculate all metrics from the review
      const updatedClient = await calculateMetricsFromReview(
        companyId, 
        companyName, 
        reviewForMetrics
      );

      res.status(201).json({
        success: true,
        data: {
          review,
          client: updatedClient
        },
        message: "Review saved successfully. Client metrics calculated."
      });

    } catch (error) {
      console.error(" Error in createClientReview:", error);
      res.status(500).json({ 
        success: false, 
        message: error.message
      });
    }
  },

  /**
   * Endpoint to sync follow-up data after updates
   */
  syncFollowUpData: async (req, res) => {
    try {
      const { companyName } = req.params;
      const decodedName = decodeURIComponent(companyName);

      console.log(" SYNC - Syncing follow-up data for:", decodedName);

      const deal = await Deal.findOne({ companyName: decodedName }).lean();
      
      if (!deal) {
        return res.status(404).json({
          success: false,
          message: "No deal found for this company"
        });
      }

      // Only process Closed Won deals
      if (deal.stage !== "Closed Won") {
        return res.json({
          success: true,
          message: "Deal is not Closed Won - no CLV data to update",
          data: null
        });
      }

      // Get fresh follow-up metrics
      const followUpMetrics = await getFollowUpMetrics(deal._id);

      // Update ClientLTV
      const updatedClient = await recalculateMetricsFromDeal(deal._id, decodedName);

      res.json({
        success: true,
        data: {
          followUpCount: followUpMetrics.count,
          lastFollowUpDate: followUpMetrics.lastDate,
          daysSinceFollowUp: followUpMetrics.daysSince,
          client: updatedClient
        },
        message: "Follow-up data synced successfully. Days inactive updated."
      });

    } catch (error) {
      console.error("Error in syncFollowUpData:", error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  },
  //refresh the metrics for updated status
  refreshClientMetrics: async (req, res) => {
    try {
      const { companyName } = req.params;
      const decodedName = decodeURIComponent(companyName);

      console.log(" Refreshing metrics for:", decodedName);

      const deal = await Deal.findOne({ companyName: decodedName }).lean();
      
      if (!deal) {
        return res.status(404).json({
          success: false,
          message: "No deal found for this company"
        });
      }

      const updatedClient = await recalculateMetricsFromDeal(deal._id, decodedName);

      res.json({
        success: true,
        data: updatedClient,
        message: "Client metrics refreshed successfully"
      });

    } catch (error) {
      console.error("Error in refreshClientMetrics:", error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  },

  // FIXED: getCLVDashboard with better performance
  getCLVDashboard: async (req, res) => {
    try {
      console.log("Fetching CLV dashboard data...");

      await cleanupInvalidClients();

      const clients = await ClientLTV.find()
        .populate("latestReview")
        .lean();

      console.log(`Found ${clients.length} clients in LTV collection`);
      
      // Apply dynamic days calculation to all clients AND RE-CLASSIFY
      const clientsWithDynamicDays = clients.map(client => {
        let dynamicDaysSinceFollowUp = 365;
        if (client.lastFollowUpDate) {
          const lastDate = new Date(client.lastFollowUpDate);
          const now = new Date();
          lastDate.setHours(0, 0, 0, 0);
          now.setHours(0, 0, 0, 0);
          const diffTime = now - lastDate;
          dynamicDaysSinceFollowUp = Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
        }
        
        // Re-classify with dynamic days
        const dynamicClassification = classifyDeal({
          totalRevenue: client.customerLifetimeValue || 0,
          supportTickets: client.totalSupportTickets || 0,
          clientHealthScore: client.clientHealthScore || 50,
          daysSinceFollowUp: dynamicDaysSinceFollowUp,
          progress: client.progress || "Average"
        });
        
        return {
          ...client,
          daysSinceFollowUp: dynamicDaysSinceFollowUp,
          classification: dynamicClassification
        };
      });
      
      const classificationCounts = {
        "Upsell": 0,
        "Top Value": 0,
        "Dormant": 0,
        "At Risk": 0
      };

      const valueCategoryCounts = {
        "High Value": 0,
        "Medium Value": 0,
        "Low Value": 0,
      };

      clientsWithDynamicDays.forEach(c => {
        if (c.classification) {
          classificationCounts[c.classification] = (classificationCounts[c.classification] || 0) + 1;
        }
        if (c.valueCategory) {
          valueCategoryCounts[c.valueCategory] = (valueCategoryCounts[c.valueCategory] || 0) + 1;
        }
      });

      const totalCLV = clientsWithDynamicDays.reduce((sum, c) => sum + (c.customerLifetimeValue || 0), 0);
      const avgCLV = clientsWithDynamicDays.length ? totalCLV / clientsWithDynamicDays.length : 0;
      
      const atRiskCount = classificationCounts["At Risk"] || 0;
      const dormantCount = classificationCounts["Dormant"] || 0;
      const totalRisky = atRiskCount + dormantCount;
      const clientsAtRiskPercent = clientsWithDynamicDays.length > 0 
        ? Math.round((totalRisky / clientsWithDynamicDays.length) * 100) 
        : 0;

      // Prepare data for frontend - LIMIT large arrays for performance
      const topClients = clientsWithDynamicDays
        .filter(c => c.classification === "Top Value")
        .sort((a, b) => (b.customerLifetimeValue || 0) - (a.customerLifetimeValue || 0))
        .slice(0, 50) // Limit to 50 for performance
        .map(c => ({
          companyName: c.companyName,
          clv: c.customerLifetimeValue,
          classification: c.classification,
          valueCategory: c.valueCategory,
          daysSinceFollowUp: c.daysSinceFollowUp,
          lastActivity: c.lastFollowUpDate,
          progress: c.latestReview?.progress,
          supportPoints: c.supportPoints,
          supportTickets: c.totalSupportTickets,
          followUpCount: c.followUpCount,
          delivered: c.delivered,
          clientHealthScore: c.clientHealthScore
        }));

      const riskyClients = clientsWithDynamicDays
        .filter(c => c.classification === "At Risk")
        .sort((a, b) => (b.daysSinceFollowUp || 0) - (a.daysSinceFollowUp || 0))
        .slice(0, 50)
        .map(c => ({
          companyName: c.companyName,
          daysSinceFollowUp: c.daysSinceFollowUp,
          supportTickets: c.totalSupportTickets,
          progress: c.progress,
          supportPoints: c.supportPoints,
          classificationReason: c.classificationReason,
          delivered: c.delivered,
          clientHealthScore: c.clientHealthScore
        }));

      const dormantClients = clientsWithDynamicDays
        .filter(c => c.classification === "Dormant")
        .sort((a, b) => (b.daysSinceFollowUp || 0) - (a.daysSinceFollowUp || 0))
        .slice(0, 50)
        .map(c => ({
          companyName: c.companyName,
          daysSinceFollowUp: c.daysSinceFollowUp,
          lastFollowUp: c.lastFollowUpDate,
          classificationReason: c.classificationReason,
          supportTickets: c.totalSupportTickets,
          delivered: c.delivered,
          clientHealthScore: c.clientHealthScore
        }));

      const upsellClients = clientsWithDynamicDays
        .filter(c => c.classification === "Upsell")
        .sort((a, b) => (b.customerLifetimeValue || 0) - (a.customerLifetimeValue || 0))
        .slice(0, 50)
        .map(c => ({
          companyName: c.companyName,
          clv: c.customerLifetimeValue,
          classification: c.classification,
          progress: c.latestReview?.progress,
          supportTickets: c.totalSupportTickets,
          delivered: c.delivered,
          clientHealthScore: c.clientHealthScore,
          daysSinceFollowUp: c.daysSinceFollowUp
        }));

      // For all clients list, limit to 100 for performance
      const allClientsList = clientsWithDynamicDays
        .slice(0, 100)
        .map(c => ({
          companyName: c.companyName,
          dealValue: c.customerLifetimeValue,
          progress: c.progress,
          supportPoints: c.supportPoints,
          followUpCount: c.followUpCount,
          classification: c.classification,
          classificationReason: c.classificationReason,
          delivered: c.delivered,
          supportTickets: c.totalSupportTickets,
          clientHealthScore: c.clientHealthScore,
          daysSinceFollowUp: c.daysSinceFollowUp
        }));

      const recentReviews = await ClientReview.find()
        .sort({ reviewedAt: -1 })
        .limit(5)
        .populate("reviewedBy", "firstName lastName")
        .lean();

      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      
      const revenueTrends = await Deal.aggregate([
        {
          $match: {
            stage: "Closed Won",
            wonAt: { $exists: true, $ne: null, $gte: sixMonthsAgo }
          }
        },
        {
          $addFields: {
            numericValue: {
              $toDouble: {
                $reduce: {
                  input: { $regexFindAll: { input: "$value", regex: "\\d+" } },
                  initialValue: "",
                  in: { $concat: ["$$value", "$$this.match"] }
                }
              }
            }
          }
        },
        {
          $group: {
            _id: {
              year: { $year: "$wonAt" },
              month: { $month: "$wonAt" }
            },
            revenue: { $sum: "$numericValue" },
            count: { $sum: 1 }
          }
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
        { $limit: 12 }
      ]);

      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const formattedTrends = revenueTrends.map(item => ({
        month: `${monthNames[item._id.month - 1]} ${item._id.year}`,
        revenue: item.revenue || 0,
        count: item.count || 0
      }));

      const now = new Date();
      const allMonths = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthStr = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
        const existing = formattedTrends.find(t => t.month === monthStr);
        allMonths.push(existing || { month: monthStr, revenue: 0, count: 0 });
      }

      console.log(" Sending to frontend:", {
        topClients: topClients.length,
        riskyClients: riskyClients.length,
        dormantClients: dormantClients.length,
        upsellClients: upsellClients.length,
        allClientsList: allClientsList.length,
        totalClients: clientsWithDynamicDays.length
      });

      res.json({
        success: true,
        data: {
          summary: {
            totalClients: clientsWithDynamicDays.length,
            totalCLV,
            avgCLV,
            clientsAtRiskPercent,
            upsellCount: classificationCounts["Upsell"] || 0,
            topValueCount: classificationCounts["Top Value"] || 0,
            dormantCount: classificationCounts["Dormant"] || 0,
            atRiskCount: classificationCounts["At Risk"] || 0,
          },
          valueCategories: valueCategoryCounts,
          classificationDistribution: classificationCounts,
          topClients,
          riskyClients,
          dormantClients,
          upsellClients,
          allClientsList,
          recentReviews,
          revenueTrends: allMonths,
          pricingRiskAlerts: []
        },
      });
    } catch (error) {
      console.error("Dashboard error:", error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  },
  //get client value
  getClientCLV: async (req, res) => {
    try {
      const { companyName } = req.params;
      const decoded = decodeURIComponent(companyName);

      let client = await ClientLTV.findOne({ companyName: decoded }).lean();

      // FALLBACK: If CLV record doesn't exist yet
      if (!client) {
        const deals = await Deal.find({ companyName: decoded, stage: "Closed Won" })
          .populate("assignedTo", "firstName lastName")
          .sort({ wonAt: -1, createdAt: -1 })
          .lean();

        if (!deals.length) {
          return res.status(404).json({
            success: false,
            message: "Client not found"
          });
        }

        return res.json({
          success: true,
          data: {
            client: {
              companyName: decoded,
              totalRevenue: 0,
              daysSinceFollowUp: 0,
              supportPoints: 0
            },
            deals,
            tickets: [],
            renewals: [],
            reviews: [],
            pricingRisk: null,
            supportAnalysis: {
              totalTickets: 0,
              openTickets: 0,
              lastSupportDate: null,
              ticketsPerMonth: 0,
              avgResolutionDays: 0,
              supportToRevenueRatio: 0,
              supportPoints: 0
            }
          }
        });
      }

      // DYNAMIC CALCULATION: Recalculate days since follow-up
      let dynamicDaysSinceFollowUp = 365;

      if (client.lastFollowUpDate) {
        const lastDate = new Date(client.lastFollowUpDate);
        const now = new Date();

        lastDate.setHours(0,0,0,0);
        now.setHours(0,0,0,0);

        const diffTime = now - lastDate;
        dynamicDaysSinceFollowUp = Math.max(
          0,
          Math.floor(diffTime / (1000 * 60 * 60 * 24))
        );
      }

      const clientWithDynamicDays = {
        ...client,
        daysSinceFollowUp: dynamicDaysSinceFollowUp
      };

      // Check if deal still active
      const activeDeal = client.companyId
        ? await Deal.findOne({
            _id: client.companyId,
            stage: "Closed Won"
          }).lean()
        : null;

      if (!activeDeal) {
        return res.json({
          success: true,
          data: {
            client: clientWithDynamicDays,
            deals: [],
            tickets: [],
            renewals: [],
            reviews: [],
            pricingRisk: null,
            supportAnalysis: {
              totalTickets: 0,
              openTickets: 0,
              lastSupportDate: null,
              ticketsPerMonth: 0,
              avgResolutionDays: 0,
              supportToRevenueRatio: 0,
              supportPoints: client.supportPoints || 0
            }
          }
        });
      }

      const [deals, tickets, renewals, reviews, pricingRisk] = await Promise.all([

        Deal.find({ companyName: decoded, stage: "Closed Won" })
          .populate("assignedTo", "firstName lastName")
          .sort({ wonAt: -1, createdAt: -1 })
          .lean(),

        client.companyId
          ? SupportTicket.find({ companyId: client.companyId })
              .sort({ openedAt: -1 })
              .lean()
          : [],

        Renewal.find({ companyName: decoded })
          .sort({ renewalDate: -1 })
          .lean(),

        client.companyId
          ? ClientReview.find({ companyId: client.companyId })
              .sort({ reviewedAt: -1 })
              .lean()
          : [],

        client.companyId
          ? PricingRisk.findOne({
              companyId: client.companyId,
              status: "Active"
            }).lean()
          : null
      ]);

      const totalTickets = tickets.length;
      const openTickets = tickets.filter(t => t.status === "Open").length;
      const lastSupportDate = totalTickets ? tickets[0].openedAt : null;

      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const recentTickets = tickets.filter(
        t => new Date(t.openedAt) >= sixMonthsAgo
      );

      const ticketsPerMonth = recentTickets.length / 6;

      let avgResolutionDays = 0;

      const closedTickets = tickets.filter(
        t => t.status === "Closed" && t.resolutionTimeHours
      );

      if (closedTickets.length > 0) {
        const totalHours = closedTickets.reduce(
          (sum, t) => sum + (t.resolutionTimeHours || 0),
          0
        );

        avgResolutionDays = totalHours / 24 / closedTickets.length;
      }

      const supportToRevenueRatio =
        client.totalRevenue > 0
          ? (totalTickets / client.totalRevenue) * 1000000
          : 0;

      const supportAnalysis = {
        totalTickets,
        openTickets,
        lastSupportDate,
        ticketsPerMonth: ticketsPerMonth.toFixed(1),
        avgResolutionDays: avgResolutionDays.toFixed(1),
        supportToRevenueRatio: supportToRevenueRatio.toFixed(2),
        supportPoints: client.supportPoints || 0
      };

      res.json({
        success: true,
        data: {
          client: clientWithDynamicDays,
          deals,
          tickets,
          renewals,
          reviews,
          pricingRisk,
          supportAnalysis
        }
      });

    } catch (error) {
      console.error("Get client error:", error);

      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  },

  //  calculateAllCLV - Ultra light version
  calculateAllCLV: async (req, res) => {
    try {
      const reviews = await ClientReview.find().lean();
      
      if (!reviews.length) {
        return res.json({ success: true, count: 0, message: "No reviews found" });
      }

      //  Respond immediately 
      res.json({
        success: true,
        count: reviews.length,
        message: `Started processing ${reviews.length} clients in background. This may take a few minutes.`
      });

      //   Process in smaller batches with longer delays
      const BATCH_SIZE = 3; // Ultra small batches
      let processed = 0;
      let errors = 0;

      console.log(` Starting background processing of ${reviews.length} clients...`);

      for (let i = 0; i < reviews.length; i += BATCH_SIZE) {
        const batch = reviews.slice(i, i + BATCH_SIZE);

        // Process batch sequentially
        for (const review of batch) {
          try {
            await calculateMetricsFromReview(review.companyId, review.companyName, review);
            processed++;
          } catch (err) {
            errors++;
            console.error(` Error for ${review.companyName}:`, err.message);
          }
        }

        // Log progress
        console.log(` Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(reviews.length/BATCH_SIZE)} complete - ${processed}/${reviews.length} processed`);

        //  CRITICAL: Longer delay between batches to prevent memory issues
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      console.log(` calculateAllCLV complete: ${processed} ok, ${errors} errors`);

    } catch (error) {
      console.error("calculateAllCLV error:", error);
      // Can't send response here because we already sent one
    }
  },
  //create the support ticket 
  createSupportTicket: async (req, res) => {
    try {
      const { companyName, companyId, subject, description, priority, category } = req.body;

      if (!companyName || !companyId || !subject || !description) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields"
        });
      }

      const userId = req.user?._id || req.user?.id;

      const date = new Date();
      const year = date.getFullYear().toString().slice(-2);
      const month = (date.getMonth() + 1).toString().padStart(2, "0");
      const count = await SupportTicket.countDocuments();
      const ticketNumber = `TKT-${year}${month}-${(count + 1).toString().padStart(4, "0")}`;

      const ticket = new SupportTicket({
        ticketNumber,
        companyName,
        companyId,
        subject,
        description,
        priority: priority || "Medium",
        category: category || "General",
        openedAt: new Date(),
        createdBy: userId,
      });

      await ticket.save();

      // After creating ticket, refresh client metrics (don't await - do in background)
      recalculateMetricsFromDeal(companyId, companyName).catch(err => {
        console.error("Error refreshing metrics after ticket creation:", err);
      });

      res.status(201).json({ success: true, data: ticket });
    } catch (error) {
      console.error("Create ticket error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },
  //create Reneval record for client
  createRenewal: async (req, res) => {
    try {
      const { dealId, companyName, renewalDate, renewalValue, currency } = req.body;

      if (!dealId || !companyName || !renewalDate || !renewalValue) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields"
        });
      }

      const renewal = new Renewal({
        dealId,
        companyName,
        renewalDate,
        renewalValue: parseFloat(renewalValue.toString().replace(/[^0-9.-]+/g, '')) || 0,
        currency: currency || "INR",
        assignedTo: req.user?._id || req.user?.id,
      });

      await renewal.save();

      res.status(201).json({ success: true, data: renewal });
    } catch (error) {
      console.error("Create renewal error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },
  // Get all active pricing risks 
  getPricingRisks: async (req, res) => {
    try {
      const risks = await PricingRisk.find({ status: "Active" })
        .sort({ detectedAt: -1 })
        .limit(50)
        .lean();

      res.json({ success: true, data: risks });
    } catch (error) {
      console.error("Error in getPricingRisks:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },
  // Mark a pricing risk as resolved
  resolvePricingRisk: async (req, res) => {
    try {
      const { id } = req.params;

      await PricingRisk.findByIdAndUpdate(id, {
        status: "Resolved",
        resolvedAt: new Date()
      });

      res.json({ success: true, message: "Risk resolved" });
    } catch (error) {
      console.error("Error in resolvePricingRisk:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },
  //show pricing recommendation
  getPricingRecommendation: async (req, res) => {
    try {
      const { companyName } = req.params;
      const decodedName = decodeURIComponent(companyName);
      
      console.log("Pricing recommendation requested for:", decodedName);
      
      const client = await ClientLTV.findOne({ companyName: decodedName }).lean();
      
      if (!client) {
        return res.status(200).json({ 
          success: false, 
          message: "Client not found in CLV system",
          data: null
        });
      }

      const latestReview = await ClientReview.findOne({ companyId: client.companyId })
        .sort({ reviewedAt: -1 })
        .lean();

      const metrics = {
        progress: latestReview?.progress || client.progress || "Average",
        supportTickets: client.totalSupportTickets || 0,
        clientHealthScore: latestReview?.clientHealthScore || client.clientHealthScore || 50,
        delivered: client.delivered || false,
        totalRevenue: client.customerLifetimeValue || 0
      };

      const pricing = calculatePricingRecommendation(metrics);

      res.json({
        success: true,
        data: {
          ...pricing,
          classification: client.classification
        }
      });

    } catch (error) {
      console.error("Error in getPricingRecommendation:", error);
      res.status(200).json({ 
        success: false, 
        message: error.message || "Error calculating pricing recommendation",
        data: null
      });
    }
  }
};