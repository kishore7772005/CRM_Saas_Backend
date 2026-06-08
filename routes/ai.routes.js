import express from "express";
import aiController from "../controllers/ai.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
const router = express.Router();

// POST /api/ai/process
router.post("/chat", protect, aiController.processMessage); 

// GET /api/ai/process (optional GET endpoint)
router.get("/chat", protect, aiController.processMessage);

export default router;