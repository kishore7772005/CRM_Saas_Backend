import { Server } from "socket.io";
import Redis from "ioredis";
import Notification from "../models/notification.model.js";


const redisConfig = {
  host: "127.0.0.1",
  port: 6379,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
};

const redisClient = new Redis(redisConfig);
const redisPub = new Redis(redisConfig);
const redisSub = new Redis(redisConfig);

redisClient.on("error", (err) => console.warn(" Redis client:", err.message));
redisPub.on("error", (err) => console.warn(" Redis pub:", err.message));
redisSub.on("error", (err) => console.warn(" Redis sub:", err.message));
// In-memory connected users
export const connectedUsers = {};
const offlineMessages = {};

let io;

export const initSocket = (server) => {
  io = new Server(server, { cors: { origin: "*" } });

  io.on("connection", (socket) => {
    const { userId } = socket.handshake.auth;
    if (userId) addUserSocket(userId, socket);

    socket.on("user_connected", (uid) => uid && addUserSocket(uid, socket));
    socket.on("user_logout", (uid) => {
      if (uid) removeUserSocket(uid, socket.id);
      socket.disconnect(true);
    });

    socket.on("disconnect", () => {
      for (const uid of Object.keys(connectedUsers)) {
        removeUserSocket(uid, socket.id);
      }
    });

    console.log("🔌 New socket connected:", socket.id);
  });

  // Redis subscription
  redisSub.subscribe("socket_broadcast", (err) => {
    if (err) console.error("Redis subscribe error:", err);
  });

  redisSub.on("message", (channel, message) => {
    const { userId, event, payload } = JSON.parse(message);
    notifyUser(userId, event, payload);
  });
};

const addUserSocket = async (userId, socket) => {
  const uid = String(userId);
  if (!connectedUsers[uid]) connectedUsers[uid] = [];
  connectedUsers[uid].push(socket);
  console.log(" User connected:", uid);

  // Send unread notifications from DB
  const unread = await Notification.find({ userId: uid, read: false }).sort({ createdAt: 1 });
  unread.forEach((n) =>
    socket.emit("new_notification", {
      _id: n._id,
      text: n.text,
      type: n.type,
      meta: n.meta,
      profileImage: n.profileImage,
      createdAt: n.createdAt,
    })
  );

  // Send offline messages
  if (offlineMessages[userId]?.length) {
    offlineMessages[userId].forEach((msg) => socket.emit(msg.event, msg.payload));
    delete offlineMessages[userId];
  }
};

const removeUserSocket = (userId, socketId) => {
  if (!connectedUsers[userId]) return;
  connectedUsers[userId] = connectedUsers[userId].filter((s) => s.id !== socketId);
  if (!connectedUsers[userId].length) {
    delete connectedUsers[userId];
    console.log(" User removed completely:", userId);
  }
};

// Notify a single user
export const notifyUser = (userId, event, payload) => {
  const uid = String(userId);
  const sockets = connectedUsers[uid];
  if (!sockets?.length) {
    // queue offline
    if (!offlineMessages[uid]) offlineMessages[uid] = [];
    offlineMessages[uid].push({ event, payload });
    console.log(" User offline, queued event:", event, "-> User:", uid);
    return;
  }
  sockets.forEach((s) => s.emit(event, payload));
  console.log(" Event sent:", event, "-> User:", uid);
};

// Notify multiple admins
export const notifyAdmins = (adminIds, event, payload) => {
  adminIds.forEach((id) => {
    redisPub.publish("socket_broadcast", JSON.stringify({ userId: id, event, payload }));
  });
};
