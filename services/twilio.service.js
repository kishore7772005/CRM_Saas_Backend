import twilio from "twilio";
import dotenv from "dotenv";
dotenv.config();

// ─── Twilio Client ───────────────────────────────────────────────────────────
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error(" TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing in .env");
  process.exit(1);
}

const client = twilio(accountSid, authToken);

// ─── Validate FROM number at startup ────────────────────────────────────────
const validateFromNumber = () => {
  const rawFrom = process.env.TWILIO_WHATSAPP_FROM;
  if (!rawFrom) {
    throw new Error(
      "TWILIO_WHATSAPP_FROM is not defined in .env.\n" +
      "Set it to your registered WhatsApp Sender:\n" +
      "Twilio Console → Messaging → Senders → WhatsApp Senders\n" +
      "Your registered sender is: whatsapp:+15558854931"
    );
  }

  let from = rawFrom.trim();
  if (from.startsWith("whatsapp:")) from = from.slice("whatsapp:".length);
  if (!from.startsWith("+")) from = "+" + from;
  const formattedFrom = `whatsapp:${from}`;

  console.log(` Twilio WhatsApp FROM: ${formattedFrom}`);
  console.log(
    "    Ensure this number is listed under:\n" +
    "    Twilio Console → Messaging → Senders → WhatsApp Senders\n" +
    "    and Sender Status = Online\n" +
    "    NOTE: +13049443661 is a voice/SMS number, NOT a WhatsApp sender."
  );

  return formattedFrom;
};

let FROM;
try {
  FROM = validateFromNumber();
} catch (err) {
  console.error("❌", err.message);
  process.exit(1);
}

// ─── Number normaliser ───────────────────────────────────────────────────────
// Called ONCE in the controller. Service functions receive an already-
// normalised "whatsapp:+XXXXXXXXXXX" string — they never re-normalise.
// Re-normalising produced "whatsapp:whatsapp:+91..." (double-prefix) which
// Twilio rejected with channel/21211 errors.
export const normaliseWhatsappNumber = (raw = "") => {
  let num = raw.trim();
  if (num.startsWith("whatsapp:")) {
    num = num.slice("whatsapp:".length);
  }
  num = num.replace(/[\s\-().]/g, "");
  if (!num.startsWith("+")) {
    // 10-digit Indian mobile (starts with 6-9)
    if (/^[6-9]\d{9}$/.test(num)) {
      num = "+91" + num;
    } else {
      num = "+" + num;
    }
  }
  return `whatsapp:${num}`;
};

export const displayNumber = (num = "") => num.replace("whatsapp:", "");

// ─── Internal pre-flight ──────────────────────────────────────────────────────
const validate = (to) => {
  if (!FROM) throw new Error("WhatsApp sender (FROM) not configured. Check TWILIO_WHATSAPP_FROM in .env");
  if (!to)   throw new Error("Recipient phone number is required");
};

// ─── Send plain text ──────────────────────────────────────────────────────────
//   Only works within the 24-hour conversation window (customer must have
//     messaged you first within the last 24 hrs).
//     Outside that window Twilio returns error 63016.
//     Use sendTemplateMessage for first-contact or expired-window scenarios.
export const sendTextMessage = async (to, body) => {
  validate(to);
  console.log(` WhatsApp text | from: ${FROM} → to: ${to}`);
  try {
    const message = await client.messages.create({ from: FROM, to, body });
    console.log(` Sent | SID: ${message.sid} | status: ${message.status}`);
    return message;
  } catch (err) {
    err.twilioCode = err.code || null;
    if (err.code === 63016) {
      err.message =
        "Cannot send freeform message: the 24-hour WhatsApp conversation window has expired. " +
        "The customer must send you a message first, OR use a WhatsApp-approved Template for first contact.";
    }
    throw err;
  }
};

// ─── Send template (Content SID) ─────────────────────────────────────────────
// Use for first-contact or when 24-hour window has expired.
// Templates must be approved via Twilio Console → Content Template Builder.
export const sendTemplateMessage = async (to, contentSid, variables = {}) => {
  validate(to);
  if (!contentSid) throw new Error("contentSid is required for template messages");
  console.log(` WhatsApp template | to: ${to} | contentSid: ${contentSid}`);
  try {
    const message = await client.messages.create({
      from:             FROM,
      to,
      contentSid,
      contentVariables: JSON.stringify(variables),
    });
    console.log(` Template sent | SID: ${message.sid}`);
    return message;
  } catch (err) {
    err.twilioCode = err.code || null;
    throw err;
  }
};

// ─── Send media ───────────────────────────────────────────────────────────────
export const sendMediaMessage = async (to, body, mediaUrl) => {
  validate(to);
  console.log(` WhatsApp media | to: ${to}`);
  try {
    const message = await client.messages.create({
      from:     FROM,
      to,
      body:     body || "",
      mediaUrl: [mediaUrl],
    });
    console.log(` Media sent | SID: ${message.sid}`);
    return message;
  } catch (err) {
    err.twilioCode = err.code || null;
    throw err;
  }
};

// ─── Fetch status ─────────────────────────────────────────────────────────────
export const fetchMessageStatus = async (messageSid) => {
  const msg = await client.messages(messageSid).fetch();
  return msg.status;
};

export default client;