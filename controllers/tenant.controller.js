import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import Tenant from "../models/master/Tenant.js";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";

dotenv.config();

const RESERVED_SLUGS = new Set(["superadmin", "api", "admin", "www", "static", "public"]);
const SLUG_REGEX = /^[a-z0-9-]+$/;

export const createTenant = async (req, res) => {
  try {
    const { name, slug, adminName, adminEmail, adminPassword } = req.body;

    if (!slug || !SLUG_REGEX.test(slug)) {
      return res.status(400).json({
        error: "Invalid slug. Use only lowercase letters, digits, and hyphens.",
      });
    }

    if (RESERVED_SLUGS.has(slug)) {
      return res.status(400).json({ error: `Slug '${slug}' is reserved.` });
    }

    const exists = await Tenant.findOne({ slug });
    if (exists) {
      return res.status(409).json({ error: "Slug already taken" });
    }

    const dbName = `crm_${slug}`;
    const tenant = await Tenant.create({
      name,
      slug,
      dbName,
      adminEmail: adminEmail.toLowerCase(),
      adminName,
      createdBy: req.superAdmin.id,
    });

    try {
      const tenantDB = await getTenantDB(dbName);
      const { Role, User } = getTenantModels(tenantDB);

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



      await User.create({
        firstName:   adminName.split(" ")[0],
        lastName:    adminName.split(" ").slice(1).join(" ") || adminName.split(" ")[0],
        email:       adminEmail.toLowerCase(),
        password:    adminPassword,
        role:        adminRole._id,
        dateOfBirth: new Date("1990-01-01"),
        status:      "Active",
      });
    } catch (setupErr) {
      // Setup failed — remove the orphaned tenant record so the slug can be retried
      await Tenant.findByIdAndDelete(tenant._id);
      console.error("Tenant setup failed, rolled back tenant record:", setupErr.message);
      return res.status(500).json({ error: "Tenant setup failed: " + setupErr.message });
    }

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
};

export const listTenants = async (req, res) => {
  try {
    const tenants = await Tenant.find().sort({ createdAt: -1 });
    res.json({ tenants });
  } catch (err) {
    console.error("List tenants error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const toggleTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    tenant.isActive = !tenant.isActive;
    await tenant.save();

    res.json({ success: true, isActive: tenant.isActive, tenant });
  } catch (err) {
    console.error("Toggle tenant error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const deleteTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    res.json({ success: true, tenant });
  } catch (err) {
    console.error("Delete tenant error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const getDashboardStats = async (req, res) => {
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
    console.error("Dashboard stats error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
