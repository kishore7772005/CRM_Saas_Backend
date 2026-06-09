import express from "express";
import { superAdminAuth } from "../middlewares/superAdminAuth.js";
import { login } from "../controllers/superAdmin.controller.js";
import {
  createTenant,
  listTenants,
  toggleTenant,
  deleteTenant,
  getDashboardStats,
} from "../controllers/tenant.controller.js";

const router = express.Router();

// Auth
router.post("/api/auth/login", login);

// Tenant management — all protected
router.post("/api/tenants/create",        superAdminAuth, createTenant);
router.get("/api/tenants",                superAdminAuth, listTenants);
router.patch("/api/tenants/:id/toggle",   superAdminAuth, toggleTenant);
router.delete("/api/tenants/:id",         superAdminAuth, deleteTenant);
router.get("/api/dashboard/stats",        superAdminAuth, getDashboardStats);

export default router;
