import Invoice from "../models/invoice.model.js";
import mongoose from "mongoose";
import path from "path";
import ejs from "ejs";
import fs from "fs";
import puppeteer from "puppeteer";
import nodemailer from "nodemailer";
import { getExchangeRate } from "../services/currencyService.js"; 

// Keep a global browser instance
let browserInstance = null;
const getBrowser = async () => {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
      ],
    });
  }
  return browserInstance;
};

export default {
  //create invoice 
  createInvoice: async (req, res) => {
    try {
      // Only Admin can create invoice – case‑insensitive check
      if (
        !req.user ||
        !req.user.role ||
        req.user.role.name?.toLowerCase() !== "admin"
      ) {
        return res
          .status(403)
          .json({ error: "Only Admin can create invoices" });
      }

      let {
        items,
        tax = 0,
        taxType = "percentage",
        discountValue = 0,
        discountType = "percentage",
        currency = "USD",
        assignTo, // sales user id
        dueDate,
        ...rest
      } = req.body;

      if (!items || items.length === 0) {
        return res
          .status(400)
          .json({ error: "Invoice must contain at least one item" });
      }

      //  Convert tax and discountValue to numbers
      tax = Number(tax) || 0;
      discountValue = Number(discountValue) || 0;

      //  Subtotal calculation with safety
      let subtotal = items.reduce((acc, item) => {
        const quantity = Number(item.quantity) || 0;
        const unitPrice = Number(item.unitPrice) || 0;
        return acc + quantity * unitPrice;
      }, 0);

      //  Tax calculation
      let taxAmount = taxType === "percentage" ? (subtotal * tax) / 100 : tax;

      //  Discount calculation
      let discount =
        discountType === "percentage"
          ? (subtotal * discountValue) / 100
          : discountValue;

      //  Total calculation
      let total = subtotal + taxAmount - discount;
      if (total < 0) total = 0;

      //  Create invoice document
      const newInvoice = new Invoice({
        items,
        subtotal,
        tax,
        taxType,
        taxAmount,
        discountValue,
        discountType,
        discount,
        total,
        currency,
        assignTo,
        dueDate,
        createdBy: req.user._id, // track which admin created
        ...rest,
      });

      await newInvoice.save();

      res.status(201).json({
        message: "Invoice created successfully",
        invoice: newInvoice,
      });
    } catch (error) {
      console.error(" Error creating invoice:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  //  Get Invoice by ID
  getInvoiceById: async (req, res) => {
    try {
      const invoice = await Invoice.findById(req.params.id)
        .populate("assignTo", "firstName lastName email")
        .populate("items.deal", "dealName value stage companyName");

      if (!invoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }
      res.status(200).json(invoice);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  //  Get All Invoices with Pagination
  getAllInvoices: async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized: No user found" });
      }

      let invoicesQuery;

      // Case‑insensitive role check
      const roleName = req.user.role?.name?.toLowerCase();

      if (roleName === "admin") {
        // Admin → all invoices
        invoicesQuery = Invoice.find();
      } else if (roleName === "sales") {
        // Sales → only invoices assigned to them
        invoicesQuery = Invoice.find({ assignTo: req.user._id });
      } else {
        return res.status(403).json({ error: "Access denied" });
      }

      const invoices = await invoicesQuery
        .populate("assignTo", "firstName lastName email")
        .populate("items.deal", "dealName value stage") //  populate deal info
        .sort({ createdAt: -1 });

      res.status(200).json(invoices);
    } catch (error) {
      console.error(" Error fetching invoices:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
  //update Invoice by ID
  updateInvoice: async (req, res) => {
    console.log(req.body);

    try {
      const invoice = await Invoice.findById(req.params.id);

      if (!invoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      let {
        items,
        tax = 0,
        discount = 0,
        discountType = "fixed",
        discountValue = 0,
        taxType = "fixed",
        price,
        status, 
        ...rest
      } = req.body;

      let subtotal = 0;
      let finalDiscount = 0;
      let taxAmount = 0;
      let finalTotal = 0;

      if (items && items.length > 0) {
        items = items.map((item) => {
          const itemPrice = Number(item.price) || 0;
          const quantity = Number(item.quantity) || 1;
          const amount = itemPrice * quantity;
          return {
            ...item,
            amount: amount.toFixed(2),
          };
        });

        subtotal = items.reduce((sum, item) => sum + Number(item.amount), 0);
      } else if (price) {
        subtotal = Number(price) || 0;
        items = [
          {
            deal: rest.deal || invoice.items?.[0]?.deal,
            price: subtotal,
            amount: subtotal,
            quantity: 1,
          },
        ];
      } else {
        subtotal = invoice.subtotal || 0;
      }

      if (discountType === "percentage") {
        finalDiscount = (subtotal * discountValue) / 100;
      } else {
        finalDiscount = Number(discountValue) || Number(discount) || 0;
      }

      if (finalDiscount > subtotal) {
        finalDiscount = subtotal;
      }

      const discountedSubtotal = subtotal - finalDiscount;

      if (taxType === "percentage") {
        taxAmount = (discountedSubtotal * tax) / 100;
      } else {
        taxAmount = Number(tax) || 0;
      }

      finalTotal = discountedSubtotal + taxAmount;
      if (finalTotal < 0) finalTotal = 0;

      const updateData = {
        ...rest,
        items,
        subtotal: Number(subtotal.toFixed(2)),
        discount: Number(finalDiscount.toFixed(2)),
        discountValue: Number(discountValue) || Number(discount) || 0,
        discountType: discountType || "fixed",
        tax: Number(tax) || 0,
        taxType: taxType || "fixed",
        taxAmount: Number(taxAmount.toFixed(2)),
        total: Number(finalTotal.toFixed(2)),
      };

      //  Handle status change to "paid"
      const currentStatus = invoice.status;
      const newStatus = status || currentStatus;

      if (newStatus === "paid" && currentStatus !== "paid") {
        // Calculate INR amount at payment time
        const totalAmount = Number(finalTotal.toFixed(2));
        const exchangeRate = await getExchangeRate(invoice.currency);
        const inrAmount = totalAmount * exchangeRate;
        
        updateData.paidAt = new Date();
        updateData.inrAmount = inrAmount;
        updateData.exchangeRate = exchangeRate;
        updateData.status = "paid";
        
        console.log(` Invoice marked as paid: ${invoice.invoicenumber}`);
        console.log(`   Amount: ${invoice.currency} ${totalAmount}`);
        console.log(`   INR Value: ₹${inrAmount.toFixed(2)}`);
        console.log(`   Exchange Rate: ${exchangeRate}`);
      } else {
        updateData.status = newStatus;
      }

      const updatedInvoice = await Invoice.findByIdAndUpdate(
        req.params.id,
        updateData,
        {
          new: true,
          runValidators: true,
        }
      )
        .populate("assignTo", "firstName lastName email role")
        .populate("items.deal", "dealName value stage");

      res.status(200).json(updatedInvoice);
    } catch (error) {
      console.error(" Error updating invoice:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  //  Delete Invoice
  deleteInvoice: async (req, res) => {
    try {
      const deletedInvoice = await Invoice.findByIdAndDelete(req.params.id);
      if (!deletedInvoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }
      res.status(200).json({ message: "Invoice deleted successfully" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  //  Bulk Delete Invoices
  bulkDeleteInvoices: async (req, res) => {
    try {
      const { ids } = req.body;
      
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ 
          success: false, 
          message: "Please provide an array of invoice IDs to delete" 
        });
      }

      const roleName = req.user.role?.name?.toLowerCase();
      let query = { _id: { $in: ids } };
      
      // If user is not admin, only allow deletion of invoices assigned to them
      if (roleName !== "admin") {
        query.assignTo = req.user._id;
      }

      // Get invoices to be deleted to verify permissions
      const invoicesToDelete = await Invoice.find(query);
      
      if (invoicesToDelete.length === 0) {
        return res.status(404).json({ 
          success: false, 
          message: "No invoices found to delete" 
        });
      }

      const result = await Invoice.deleteMany(query);
      
      res.status(200).json({
        success: true,
        message: `${result.deletedCount} invoice(s) deleted successfully`,
        deletedCount: result.deletedCount
      });
    } catch (error) {
      console.error(" Bulk delete invoices error:", error);
      res.status(500).json({ 
        success: false, 
        message: "Failed to delete invoices", 
        error: error.message 
      });
    }
  },
  //generate Invoice PDF by ID
  generateInvoicePDF: async (req, res) => {
    try {
      const invoiceId = req.params.id;

      if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
        return res.status(400).json({ error: "Invalid invoice ID" });
      }

      const invoice = await Invoice.findById(invoiceId)
        .populate("assignTo", "firstName lastName email")
        .populate(
          "items.deal",
          "dealName value stage email companyName address country phoneNumber"
        );

      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      const templatePath = path.join(
        process.cwd(),
        "views",
        "invoiceTemplate.ejs"
      );

      if (!fs.existsSync(templatePath)) {
        console.error("Invoice template missing at:", templatePath);
        return res.status(500).json({ error: "Template file not found" });
      }

      const templateData = await ejs.renderFile(
        templatePath,
        { invoice },
        { async: true }
      );

      const browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
        ],
      });

      const page = await browser.newPage();
      await page.setContent(templateData, { waitUntil: "networkidle0" });

      const pdfBuffer = await page.pdf({
        format: "A4",
        margin: { top: "20mm", right: "10mm", bottom: "20mm", left: "10mm" },
        printBackground: true,
      });

      await browser.close();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=Invoice_${
          invoice.invoicenumber || invoice._id
        }.pdf`
      );
      res.setHeader("Content-Length", pdfBuffer.length);

      return res.end(pdfBuffer);
    } catch (error) {
      console.error("Error generating PDF:", error);
      res
        .status(500)
        .json({ error: "Failed to generate PDF", details: error.message });
    }
  },
  //send Invoice to Email by ID
  sendInvoiceEmail: async (req, res) => {
    try {
      const { id } = req.params;

      // Validate invoice ID
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid invoice ID" });
      }

      // Fetch invoice with deal info
      const invoice = await Invoice.findById(id).populate(
        "items.deal",
        "dealName email value stage"
      );

      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      // Collect client emails from deals
      const clientEmails = invoice.items
        .map((item) => item.deal?.email)
        .filter((email) => !!email);

      if (clientEmails.length === 0) {
        console.error(
          `Invoice #${
            invoice.invoicenumber || invoice._id
          } has no deal/client emails!`
        );
        return res
          .status(400)
          .json({ error: "No client emails found in invoice deals" });
      }

      // Respond immediately to frontend
      res.status(200).json({ message: "Invoice email is being sent!" });

      // Async email sending
      setImmediate(async () => {
        try {
          const templatePath = path.join(
            process.cwd(),
            "views",
            "invoiceTemplate.ejs"
          );

          if (!fs.existsSync(templatePath)) {
            console.error("Invoice template missing at:", templatePath);
            return;
          }

          // Render EJS template
          const templateData = await ejs.renderFile(
            templatePath,
            { invoice },
            { async: true }
          );

          // Launch or reuse browser
          const browser = await getBrowser();
          const page = await browser.newPage();
          await page.setContent(templateData, { waitUntil: "networkidle0" });

          // Generate PDF
          const pdfBuffer = await page.pdf({
            format: "A4",
            margin: {
              top: "20mm",
              right: "10mm",
              bottom: "20mm",
              left: "10mm",
            },
            printBackground: true,
          });

          await page.close(); 

          // Nodemailer setup
          const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
              user: process.env.EMAIL_USER,
              pass: process.env.EMAIL_PASS,
            },
          });

          // Send email to all client emails
          for (const email of clientEmails) {
            const mailOptions = {
              from: `"TechZarInfo Software Solution" <${process.env.EMAIL_USER}>`,
              to: email,
              subject: `Invoice #${invoice.invoicenumber || invoice._id}`,
              text: `Hello,

Please find attached your invoice #${invoice.invoicenumber || invoice._id}.

Included deals:
${invoice.items
  .map((item) => `- ${item.deal.dealName} `)
  .join("\n")}

Thank you!`,
              attachments: [
                {
                  filename: `Invoice_${
                    invoice.invoicenumber || invoice._id
                  }.pdf`,
                  content: pdfBuffer,
                },
              ],
            };

            await transporter.sendMail(mailOptions);
            console.log(` Invoice email sent to: ${email}`);
          }
        } catch (err) {
          console.error(" Error sending invoice email asynchronously:", err);
        }
      });
    } catch (error) {
      console.error(" Error processing invoice email request:", error);
      res.status(500).json({
        error: "Failed to send invoice email",
        details: error.message,
      });
    }
  },
  //to get the Invoices
  getRecentInvoices: async (_req, res) => {
    try {
      const now = new Date();
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(now.getMonth() - 1);

      const invoices = await Invoice.find({
        createdAt: { $gte: oneMonthAgo, $lte: now }, 
      })
        .sort({ createdAt: -1 }) // recent first
        .populate("assignTo", "firstName lastName email");

      res.status(200).json(invoices);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },

  //  Get Pending Invoices (status = Unpaid / Pending)
  getPendingInvoices: async (_req, res) => {
    try {
      const invoices = await Invoice.find({ status: { $in: ["unpaid"] } })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("assignTo", "firstName lastName email");

      res.status(200).json(invoices);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
};
