import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import Lead from "../models/leads.model.js";
import Deal from "../models/deals.model.js";
import dotenv from "dotenv";

dotenv.config();

export const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.SECRET_KEY);
    req.user = await User.findById(decoded.id).populate("role");

    if (!req.user) {
      return res.status(401).json({ message: "User not found" });
    }

    next();
  } catch (err) {
    return res.status(401).json({ message: "Token failed" });
  }
};

export const adminOnly = (req, res, next) => {
  const roleName = req.user.role.name?.toLowerCase();
  if (roleName !== "admin" && roleName !== "sales") {
    return res.status(403).json({ message: "Access denied: Admins only" });
  }
  next();
};

export const adminCreateOnly = (req, res, next) => {
  const roleName = req.user.role.name?.toLowerCase();
  if (roleName !== "admin") {
    return res.status(403).json({ message: "Access denied: Admins only" });
  }
  next();
};

export const adminOrAssigned = async (req, res, next) => {
  try {
    const roleName = req.user.role.name?.toLowerCase();
    if (roleName === "admin") {
      return next();
    }

    const leadId = req.params.id;
    const lead = await Lead.findById(leadId);

    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    }

    if (lead.assignTo && lead.assignTo.toString() === req.user._id.toString()) {
      return next();
    }

    return res.status(403).json({
      message: "Access denied: You can only access leads assigned to you",
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const adminOrAssignedToDeal = async (req, res, next) => {
  try {
    const roleName = req.user.role.name?.toLowerCase();
    if (roleName === "admin") {
      return next();
    }

    const dealId = req.params.id;
    const deal = await Deal.findById(dealId);

    if (!deal) {
      return res.status(404).json({ message: "Deal not found" });
    }

    if (deal.assignedTo && deal.assignedTo.toString() === req.user._id.toString()) {
      return next();
    }

    return res.status(403).json({
      message: "Access denied: You can only access deals assigned to you",
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const adminOrSales = (req, res, next) => {
  const roleName = req.user.role.name?.toLowerCase();
  if (roleName === "admin" || roleName === "sales") {
    return next();
  }
  return res.status(403).json({ message: "Access denied: Admins or Sales only" });
};

export const adminOrSelf = (req, res, next) => {
  const roleName = req.user.role.name?.toLowerCase();
  if (roleName === "admin" || req.user._id.toString() === req.params.id) {
    return next();
  }
  return res.status(403).json({ message: "Access denied" });
};