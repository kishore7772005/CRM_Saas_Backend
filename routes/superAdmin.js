import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

import { superAdminAuth } from "../middlewares/superAdminAuth.js";
import SuperAdmin from "../models/master/SuperAdmin.js";
import Tenant from "../models/master/Tenant.js";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";

dotenv.config();

const router = express.Router();

// Reserved slugs that cannot be used as tenant slugs
const RESERVED_SLUGS = new Set(["superadmin", "api", "admin", "www", "static", "public"]);
const SLUG_REGEX = /^[a-z0-9-]+$/;

// ─────────────────────────────────────────────
// POST /superadmin/api/auth/login
// ─────────────────────────────────────────────
router.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const admin = await SuperAdmin.findOne({ email: email.toLowerCase() });
    if (!admin) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const match = await bcrypt.compare(password, admin.password);
    if (!match) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: admin._id, email: admin.email },
      process.env.SUPERADMIN_JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token, admin: { id: admin._id, name: admin.name, email: admin.email } });
  } catch (err) {
    console.error("SuperAdmin login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// POST /superadmin/api/tenants/create  [protected]
// ─────────────────────────────────────────────
router.post("/api/tenants/create", superAdminAuth, async (req, res) => {
  try {
    const { name, slug, adminName, adminEmail, adminPassword } = req.body;

    // a) Validate slug format
    if (!slug || !SLUG_REGEX.test(slug)) {
      return res.status(400).json({
        error: "Invalid slug. Use only lowercase letters, digits, and hyphens.",
      });
    }

    if (RESERVED_SLUGS.has(slug)) {
      return res.status(400).json({ error: `Slug '${slug}' is reserved.` });
    }

    // b) Check uniqueness
    const exists = await Tenant.findOne({ slug });
    if (exists) {
      return res.status(409).json({ error: "Slug already taken" });
    }

    // c) Create Tenant doc
    const dbName = `crm_${slug}`;
    const tenant = await Tenant.create({
      name,
      slug,
      dbName,
      adminEmail: adminEmail.toLowerCase(),
      adminName,
      createdBy: req.superAdmin.id,
    });

    // d) Connect to tenant DB (registers all 17 models automatically)
    const tenantDB = await getTenantDB(dbName);

    // e) Get tenant models
    const { Role, User } = getTenantModels(tenantDB);

    // f) Seed Admin role
    const adminRole = await Role.create({
      name: "Admin",
      description: "Full access",
      permissions: {
        dashboard:           true,
        leads:               true,
        create_lead:         true,
        deals_all:           true,
        create_deal:         true,
        deals_pipeline:      true,
        proposal:            true,
        invoices:            true,
        activities_calendar: true,
        activities_list:     true,
        users_roles:         true,
        email_chat:          true,
        email_campaigns:     true,
        reports:             true,
        settings:            true,
        whatsapp_chat:       true,
        streak_leaderboard:  true,
      },
    });

    // g) Seed Sales role
    await Role.create({
      name: "Sales",
      description: "Limited access",
      permissions: {
        dashboard:           true,
        leads:               true,
        create_lead:         true,
        deals_all:           true,
        create_deal:         true,
        deals_pipeline:      true,
        proposal:            true,
        invoices:            true,
        activities_calendar: true,
        activities_list:     true,
        users_roles:         false,
        email_chat:          true,
        email_campaigns:     false,
        reports:             false,
        settings:            false,
        whatsapp_chat:       true,
        streak_leaderboard:  true,
      },
    });

    // h) Create tenant admin user
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    await User.create({
      firstName:   adminName.split(" ")[0],
      lastName:    adminName.split(" ").slice(1).join(" ") || adminName.split(" ")[0],
      email:       adminEmail.toLowerCase(),
      password:    hashedPassword,
      role:        adminRole._id,
      dateOfBirth: new Date("1990-01-01"), // placeholder — tenant admin must update
      status:      "Active",
    });

    // i) Return success
    res.status(201).json({
      success: true,
      tenant,
      loginUrl: `stagingzar.com/${slug}`,
    });
  } catch (err) {
    console.error("Create tenant error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ error: "Slug or dbName already exists" });
    }
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ─────────────────────────────────────────────
// GET /superadmin/api/tenants  [protected]
// ─────────────────────────────────────────────
router.get("/api/tenants", superAdminAuth, async (req, res) => {
  try {
    const tenants = await Tenant.find().sort({ createdAt: -1 });
    res.json({ tenants });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// PATCH /superadmin/api/tenants/:id/toggle  [protected]
// ─────────────────────────────────────────────
router.patch("/api/tenants/:id/toggle", superAdminAuth, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    tenant.isActive = !tenant.isActive;
    await tenant.save();

    res.json({ success: true, isActive: tenant.isActive, tenant });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// DELETE /superadmin/api/tenants/:id  [protected] — soft delete
// ─────────────────────────────────────────────
router.delete("/api/tenants/:id", superAdminAuth, async (req, res) => {
  try {
    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    res.json({ success: true, tenant });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// GET /superadmin/api/dashboard/stats  [protected]
// ─────────────────────────────────────────────
router.get("/api/dashboard/stats", superAdminAuth, async (req, res) => {
  try {
    const [totalTenants, activeTenants, recentTenants] = await Promise.all([
      Tenant.countDocuments(),
      Tenant.countDocuments({ isActive: true }),
      Tenant.find().sort({ createdAt: -1 }).limit(5),
    ]);

    res.json({
      totalTenants,
      activeTenants,
      inactiveTenants: totalTenants - activeTenants,
      recentTenants,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
