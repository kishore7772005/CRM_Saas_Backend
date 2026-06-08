import cron from "node-cron";
import MassEmail from "../models/massEmail.model.js";
import sendEmail from "../utils/sendEmail.js";
import fs from "fs";

//  Runs every minute
cron.schedule("* * * * *", async () => {
  try {
    console.log(" Checking scheduled emails...");

    const now = new Date();

    // Find pending emails that should be sent
    const pendingEmails = await MassEmail.find({
      status: "scheduled",
      scheduledFor: { $ne: null, $lte: now },
    });

    for (const emailDoc of pendingEmails) {
      const logoUrl =
        "https://res.cloudinary.com/djpljugqo/image/upload/v1771404424/TZI_Logo-04_-_Copy-removebg-preview_o6ocur.png";

      const finalHTML = `
        <div style="background-color:#f4f6f8; padding:40px 0;">
          <div style="max-width:600px; margin:auto; background:white; padding:30px; border-radius:8px;">

            <div style="text-align:center; margin-bottom:25px;">
              <img src="${logoUrl}" alt="TZI Logo" width="180" />
            </div>

            <div style="font-size:14px; line-height:1.6; color:#333;">
              ${emailDoc.content}
            </div>

            <hr style="margin:30px 0; border:none; border-top:1px solid #eee;" />

            <div style="text-align:center; font-size:12px; color:#888;">
              © ${new Date().getFullYear()} TZI. All rights reserved.
            </div>

          </div>
        </div>
      `;

      for (const recipient of emailDoc.recipients) {
        await sendEmail({
          to: recipient,
          subject: emailDoc.subject,
          html: finalHTML,
          attachments: emailDoc.attachments,
        });
      }

      // Update status to sent
      emailDoc.status = "sent";
      await emailDoc.save();

      //  Delete attachment files after sending
      if (emailDoc.attachments && emailDoc.attachments.length > 0) {
        emailDoc.attachments.forEach((file) => {
          fs.unlink(file.path, (err) => {
            if (err) console.error("File delete error:", err);
          });
         });
        }


      console.log(` Scheduled email sent: ${emailDoc._id}`);
    }
  } catch (error) {
    console.error(" Cron email error:", error);
  }
});

export default cron;
