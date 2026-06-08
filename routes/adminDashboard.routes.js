import express from "express";
import indexControllers from "../controllers/index.controllers.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();

// protect middleware to ensure req.user is available
//get the summary dashboard
router.get("/summary", protect, indexControllers.adminDashboardController.getDashboardSummary);
//get the pipeline data for dashboard
router.get("/pipeline", protect, indexControllers.adminDashboardController.getPipeline);

export default router;