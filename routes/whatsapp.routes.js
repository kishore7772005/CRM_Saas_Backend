import express from "express";
import {
  inboundWebhook,
  sendMessage,
  sendTemplate,
  sendMedia,
  getConversations,
  getMessages,
  updateConversation,
  statusCallback,
  getUnreadCount,
} from "../controllers/whatsapp.controller.js";

const router = express.Router();

// ── Twilio Webhooks (no auth — Twilio calls these) ───────────────────────────
router.post("/webhook", inboundWebhook);          // Inbound message webhook
router.post("/status", statusCallback);           // Delivery status callback

// ── CRM Internal API ─────────────────────────────────────────────────────────
router.get("/conversations", getConversations);                    // List all chats
router.get("/messages/:contactNumber", getMessages);               // Chat history
router.patch("/conversations/:id", updateConversation);            // Rename / assign
router.get("/unread-count", getUnreadCount);                       // Badge count

router.post("/send", sendMessage);                // Send plain text
router.post("/send-template", sendTemplate);      // Send template
router.post("/send-media", sendMedia);            // Send media

export default router;