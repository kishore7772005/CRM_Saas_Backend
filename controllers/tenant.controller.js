import crypto from "crypto";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import Tenant from "../models/master/Tenant.js";
import { getTenantDB } from "../config/tenantDB.js";
import { getTenantModels } from "../models/tenant/index.js";
import sendEmail from "../utils/sendEmail.js";

dotenv.config();

const RESERVED_SLUGS = new Set(["superadmin", "api", "admin", "www", "static", "public"]);
const SLUG_REGEX = /^[a-z0-9-]+$/;

function generatePassword(length = 12) {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$!";
  return Array.from(crypto.randomBytes(length))
    .map(b => charset[b % charset.length])
    .join("");
}

function welcomeEmailHtml({ adminName, adminEmail, password, loginUrl, tenantName }) {
  const firstName = adminName.split(" ")[0];
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Welcome to ${tenantName} CRM</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a73e8 0%,#0d47a1 100%);padding:36px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">
                Welcome to ${tenantName} CRM
              </h1>
              <p style="margin:8px 0 0;color:#c8dcff;font-size:14px;">Your workspace is ready</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 20px;color:#333;font-size:16px;">Hi <strong>${firstName}</strong>,</p>
              <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">
                Your CRM account has been created successfully. Below are your login credentials — please keep them safe and change your password after your first login.
              </p>

              <!-- Credentials box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;border:1px solid #d0dcff;border-radius:8px;margin-bottom:32px;">
                <tr>
                  <td style="padding:24px 28px;">
                    <p style="margin:0 0 14px;font-size:13px;font-weight:600;color:#1a73e8;text-transform:uppercase;letter-spacing:0.8px;">Login Credentials</p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:6px 0;color:#666;font-size:14px;width:90px;">Email</td>
                        <td style="padding:6px 0;color:#111;font-size:14px;font-weight:600;">${adminEmail}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#666;font-size:14px;">Password</td>
                        <td style="padding:6px 0;">
                          <span style="background:#fff;border:1px solid #d0dcff;border-radius:4px;padding:4px 12px;font-family:monospace;font-size:15px;color:#1a73e8;font-weight:700;letter-spacing:1px;">${password}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom:28px;">
                    <a href="${loginUrl}" target="_blank"
                       style="display:inline-block;background:linear-gradient(135deg,#1a73e8 0%,#0d47a1 100%);color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 44px;border-radius:8px;letter-spacing:0.3px;box-shadow:0 4px 12px rgba(26,115,232,0.35);">
                      Login to Dashboard →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#888;font-size:13px;line-height:1.6;border-top:1px solid #eee;padding-top:20px;">
                For security, please change your password immediately after logging in.<br/>
                If you did not request this account, please contact your administrator.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafc;padding:20px 40px;text-align:center;border-top:1px solid #eee;">
              <p style="margin:0;color:#aaa;font-size:12px;">© ${new Date().getFullYear()} TZI Support. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export const createTenant = async (req, res) => {
  try {
    const { name, slug, adminName, adminEmail } = req.body;

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

    const plainPassword = generatePassword();
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
        password:    plainPassword,
        role:        adminRole._id,
        dateOfBirth: new Date("1990-01-01"),
        status:      "Active",
      });
    } catch (setupErr) {
      await Tenant.findByIdAndDelete(tenant._id);
      console.error("Tenant setup failed, rolled back tenant record:", setupErr.message);
      return res.status(500).json({ error: "Tenant setup failed: " + setupErr.message });
    }

    const loginUrl = `${process.env.FRONTEND_URL || "https://crm.stagingzar.com"}/${slug}`;

    // Send welcome email — failure does not block the response
    sendEmail({
      to: adminEmail,
      subject: `Welcome to ${name} CRM — Your Login Credentials`,
      html: welcomeEmailHtml({ adminName, adminEmail, password: plainPassword, loginUrl, tenantName: name }),
    }).catch(err => console.error("Welcome email failed:", err.message));

    res.status(201).json({
      success: true,
      tenant,
      loginUrl,
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

export const impersonateTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    const tenantDB = await getTenantDB(tenant.dbName);
    const { User } = getTenantModels(tenantDB);

    // Find the tenant admin user
    const user = await User.findOne({ email: tenant.adminEmail.toLowerCase() }).populate("role");
    if (!user) {
      return res.status(404).json({ error: "Tenant administrator user not found" });
    }

    // Generate JWT token (signed with tenant SECRET_KEY and tokenVersion)
    const token = jwt.sign(
      {
        id: user._id,
        tokenVersion: user.tokenVersion || 0,
        dbName: tenant.dbName,
        slug: tenant.slug,
        tenantId: tenant._id,
      },
      process.env.SECRET_KEY,
      { expiresIn: "1d" }
    );

    res.json({
      success: true,
      token,
      slug: tenant.slug,
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profileImage: user.profileImage,
        role: user.role,
      }
    });
  } catch (err) {
    console.error("Impersonate tenant error:", err);
    res.status(500).json({ error: "Server error during impersonation" });
  }
};
