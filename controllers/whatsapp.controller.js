import WhatsappConversation from "../models/Whatsappconversation.model.js";
import WhatsappMessage from "../models/WhatsAppMessage.js";
import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  normaliseWhatsappNumber,
  displayNumber,
} from "../services/twilio.service.js";
import {
  notifyUser,
  connectedUsers,
} from "../realtime/socket.js";

// ─── Helper: upsert conversation on every message ────────────────────────────
const upsertConversation = async ({
  contactNumber,
  contactName,
  lastMessage,
  direction,
  incrementUnread = false,
}) => {
  const baseFields = {
    lastMessage:          lastMessage?.substring(0, 120) || "",
    lastMessageAt:        new Date(),
    lastMessageDirection: direction,
  };
  if (contactName) baseFields.contactName = contactName;

  const updateOp = incrementUnread
    ? { $set: baseFields, $inc: { unreadCount: 1 } }
    : { $set: baseFields };

  const conv = await WhatsappConversation.findOneAndUpdate(
    { contactNumber },
    updateOp,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return conv;
};

// ─────────────────────────────────────────────────────────────────────────────
// Enhanced tip helper
// ─────────────────────────────────────────────────────────────────────────────
const getEnhancedTip = (err) => {
  const msg  = err.message || "";
  const code = err.code || err.twilioCode;

  if (code === 63016 || msg.includes("outside the allowed window") || msg.includes("24-hour")) {
    return (
      "The 24-hour WhatsApp conversation window has expired.\n" +
      "You can only send freeform messages within 24 hours of the customer's last message.\n\n" +
      " Solution: Use a WhatsApp-approved Template message instead.\n" +
      "   - Go to Twilio Console → Content Template Builder\n" +
      "   - Create and submit a template for Meta approval\n" +
      "   - Use 'Send Template' in the New Chat modal"
    );
  }
  if (code === 21408) {
    return (
      "The From number is not a valid WhatsApp sender.\n" +
      "Check TWILIO_WHATSAPP_FROM in .env.\n" +
      "It must match a number listed under:\n" +
      "Twilio Console → Messaging → Senders → WhatsApp Senders\n" +
      "Your registered sender is: whatsapp:+15558854931\n" +
      "NOTE: +13049443661 is a voice/SMS number — it is NOT WhatsApp-enabled."
    );
  }
  if (code === 21211) {
    return "The 'To' phone number is invalid. Include the country code, e.g. +919361444764.";
  }
  if (code === 21610) {
    return "The recipient has not opted in. They must first send a message to your WhatsApp number.";
  }
  if (code === 63007) {
    return (
      "The From number is not WhatsApp-enabled.\n" +
      "Go to Twilio Console → Messaging → Senders → WhatsApp Senders\n" +
      "and verify your sender shows Status = Online."
    );
  }
  if (msg.includes("Channel") || msg.includes("From address")) {
    return (
      "Twilio cannot find a WhatsApp channel for your From address.\n" +
      "1. Verify TWILIO_WHATSAPP_FROM in .env matches a WhatsApp Sender in your Twilio Console.\n" +
      "2. Your registered WhatsApp sender is: +15558854931 → set TWILIO_WHATSAPP_FROM=whatsapp:+15558854931\n" +
      "3. +13049443661 is your voice/SMS number — it is NOT WhatsApp-enabled."
    );
  }
  if (msg.includes("unverified")) {
    return "The recipient is unverified. Add them in Twilio Sandbox verified numbers (trial accounts only).";
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. INBOUND WEBHOOK  POST /api/whatsapp/webhook
// ─────────────────────────────────────────────────────────────────────────────
export const inboundWebhook = async (req, res) => {
  try {
    const { From, Body, MessageSid, NumMedia, ProfileName } = req.body;

    const mediaUrls = [];
    const numMedia = parseInt(NumMedia || "0", 10);
    for (let i = 0; i < numMedia; i++) {
      const url = req.body[`MediaUrl${i}`];
      if (url) mediaUrls.push(url);
    }

    const message = await WhatsappMessage.create({
      contactNumber: From,
      contactName:   ProfileName || "",
      direction:     "inbound",
      body:          Body || "",
      messageSid:    MessageSid,
      status:        "received",
      mediaUrls,
      read:          false,
    });

    const conv = await upsertConversation({
      contactNumber:   From,
      contactName:     ProfileName || "",
      lastMessage:     Body || "📎 Media",
      direction:       "inbound",
      incrementUnread: true,
    });

    const payload = {
      _id:           message._id,
      contactNumber: From,
      contactName:   ProfileName || conv.contactName || displayNumber(From),
      direction:     "inbound",
      body:          Body || "",
      mediaUrls,
      status:        "received",
      createdAt:     message.createdAt,
      conversationId: conv._id,
      unreadCount:   conv.unreadCount,
    };

    Object.keys(connectedUsers).forEach((uid) =>
      notifyUser(uid, "whatsapp_new_message", payload)
    );

    res.set("Content-Type", "text/xml");
    res.status(200).send("<Response></Response>");
  } catch (err) {
    console.error(" Inbound webhook error:", err);
    res.set("Content-Type", "text/xml");
    res.status(200).send("<Response></Response>");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. SEND TEXT MESSAGE  POST /api/whatsapp/send
// ─────────────────────────────────────────────────────────────────────────────
export const sendMessage = async (req, res) => {
  try {
    const { to, body, sentBy } = req.body;
    if (!to || !body)
      return res.status(400).json({ message: "to and body are required" });

    // Normalise ONCE here — twilio.service does NOT re-normalise
    const toFormatted = normaliseWhatsappNumber(to);
    console.log(` Send | raw: "${to}" → normalised: "${toFormatted}"`);

    const twilioMsg = await sendTextMessage(toFormatted, body);

    const message = await WhatsappMessage.create({
      contactNumber: toFormatted,
      direction:     "outbound",
      body,
      messageSid:    twilioMsg.sid,
      status:        twilioMsg.status,
      sentBy:        sentBy || null,
    });

    await upsertConversation({
      contactNumber: toFormatted,
      lastMessage:   body,
      direction:     "outbound",
    });

    const payload = {
      _id:           message._id,
      contactNumber: toFormatted,
      direction:     "outbound",
      body,
      status:        twilioMsg.status,
      createdAt:     message.createdAt,
    };
    Object.keys(connectedUsers).forEach((uid) =>
      notifyUser(uid, "whatsapp_message_sent", payload)
    );

    res.status(201).json({ success: true, message });
  } catch (err) {
    console.error(" Send message error:", err.message);
    res.status(500).json({
      message:     err.message || "Failed to send WhatsApp message",
      twilioCode:  err.code || err.twilioCode || null,
      tip:         getEnhancedTip(err),
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. SEND TEMPLATE  POST /api/whatsapp/send-template
// ─────────────────────────────────────────────────────────────────────────────
export const sendTemplate = async (req, res) => {
  try {
    const { to, contentSid, variables, sentBy } = req.body;
    if (!to || !contentSid)
      return res.status(400).json({ message: "to and contentSid are required" });

    const toFormatted = normaliseWhatsappNumber(to);
    const sid = contentSid || process.env.TWILIO_CONTENT_SID;

    const twilioMsg = await sendTemplateMessage(toFormatted, sid, variables || {});

    const message = await WhatsappMessage.create({
      contactNumber: toFormatted,
      direction:     "outbound",
      body:          `[Template: ${sid}]`,
      messageSid:    twilioMsg.sid,
      status:        twilioMsg.status,
      sentBy:        sentBy || null,
    });

    await upsertConversation({
      contactNumber: toFormatted,
      lastMessage:   "[Template message]",
      direction:     "outbound",
    });

    // Broadcast so all agents see it in real-time
    const payload = {
      _id:           message._id,
      contactNumber: toFormatted,
      direction:     "outbound",
      body:          `[Template: ${sid}]`,
      status:        twilioMsg.status,
      createdAt:     message.createdAt,
    };
    Object.keys(connectedUsers).forEach((uid) =>
      notifyUser(uid, "whatsapp_message_sent", payload)
    );

    res.status(201).json({ success: true, message });
  } catch (err) {
    console.error(" Send template error:", err);
    res.status(500).json({
      message:    err.message,
      twilioCode: err.code || err.twilioCode || null,
      tip:        getEnhancedTip(err),
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. SEND MEDIA  POST /api/whatsapp/send-media
// ─────────────────────────────────────────────────────────────────────────────
export const sendMedia = async (req, res) => {
  try {
    const { to, body, mediaUrl, sentBy } = req.body;
    if (!to || !mediaUrl)
      return res.status(400).json({ message: "to and mediaUrl are required" });

    const toFormatted = normaliseWhatsappNumber(to);
    const twilioMsg   = await sendMediaMessage(toFormatted, body || "", mediaUrl);

    const message = await WhatsappMessage.create({
      contactNumber: toFormatted,
      direction:     "outbound",
      body:          body || "",
      messageSid:    twilioMsg.sid,
      status:        twilioMsg.status,
      mediaUrls:     [mediaUrl],
      sentBy:        sentBy || null,
    });

    await upsertConversation({
      contactNumber: toFormatted,
      lastMessage:   body || "📎 Media",
      direction:     "outbound",
    });

    const payload = {
      _id:           message._id,
      contactNumber: toFormatted,
      direction:     "outbound",
      body:          body || "",
      mediaUrls:     [mediaUrl],
      status:        twilioMsg.status,
      createdAt:     message.createdAt,
    };
    Object.keys(connectedUsers).forEach((uid) =>
      notifyUser(uid, "whatsapp_message_sent", payload)
    );

    res.status(201).json({ success: true, message });
  } catch (err) {
    console.error(" Send media error:", err);
    res.status(500).json({
      message:    err.message,
      twilioCode: err.code || err.twilioCode || null,
      tip:        getEnhancedTip(err),
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. GET ALL CONVERSATIONS  GET /api/whatsapp/conversations
// ─────────────────────────────────────────────────────────────────────────────
export const getConversations = async (req, res) => {
  try {
    const { page = 1, limit = 30, search = "" } = req.query;
    const query = { isArchived: false };
    if (search) {
      query.$or = [
        { contactName:   { $regex: search, $options: "i" } },
        { contactNumber: { $regex: search, $options: "i" } },
      ];
    }

    const conversations = await WhatsappConversation.find(query)
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate("assignedTo", "name email profileImage");

    const total = await WhatsappConversation.countDocuments(query);
    res.json({ conversations, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. GET MESSAGES FOR A CONTACT  GET /api/whatsapp/messages/:contactNumber
// ─────────────────────────────────────────────────────────────────────────────
export const getMessages = async (req, res) => {
  try {
    let { contactNumber } = req.params;
    contactNumber = decodeURIComponent(contactNumber);
    const { page = 1, limit = 50 } = req.query;

    const messages = await WhatsappMessage.find({ contactNumber })
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate("sentBy", "name profileImage");

    const total = await WhatsappMessage.countDocuments({ contactNumber });

    // Mark inbound messages as read
    await WhatsappMessage.updateMany(
      { contactNumber, direction: "inbound", read: false },
      { read: true },
    );
    await WhatsappConversation.findOneAndUpdate(
      { contactNumber },
      { unreadCount: 0 },
    );

    res.json({ messages, total });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. UPDATE CONVERSATION  PATCH /api/whatsapp/conversations/:id
// ─────────────────────────────────────────────────────────────────────────────
export const updateConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const { contactName, assignedTo, isArchived } = req.body;
    const update = {};
    if (contactName !== undefined) update.contactName = contactName;
    if (assignedTo  !== undefined) update.assignedTo  = assignedTo;
    if (isArchived  !== undefined) update.isArchived  = isArchived;

    const conv = await WhatsappConversation.findByIdAndUpdate(id, update, { new: true });
    if (!conv) return res.status(404).json({ message: "Conversation not found" });
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. STATUS CALLBACK  POST /api/whatsapp/status
// ─────────────────────────────────────────────────────────────────────────────
export const statusCallback = async (req, res) => {
  try {
    const { MessageSid, MessageStatus } = req.body;
    if (MessageSid) {
      await WhatsappMessage.findOneAndUpdate(
        { messageSid: MessageSid },
        { status: MessageStatus },
      );
      Object.keys(connectedUsers).forEach((uid) =>
        notifyUser(uid, "whatsapp_status_update", {
          messageSid: MessageSid,
          status:     MessageStatus,
        })
      );
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error(" Status callback error:", err);
    res.status(200).send("OK");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. GET UNREAD COUNT  GET /api/whatsapp/unread-count
// ─────────────────────────────────────────────────────────────────────────────
export const getUnreadCount = async (req, res) => {
  try {
    const result = await WhatsappConversation.aggregate([
      { $match: { isArchived: false } },
      { $group: { _id: null, total: { $sum: "$unreadCount" } } },
    ]);
    res.json({ unreadCount: result[0]?.total || 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};