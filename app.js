const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

const submissionSchema = new mongoose.Schema({
  appName: { type: String, required: true },
  appUrl: { type: String, required: true },
  email: { type: String, required: true },
  category: String,
  description: String,
  role: String,
  timeline: String,
  budget: String,
  monetization: String,
  targetStores: [String],
  status: { type: String, default: "pending_payment" },
  tier: { type: String, default: "none" },
  createdAt: { type: Date, default: Date.now }
});

const Submission = mongoose.model("Submission", submissionSchema);

app.get("/", (req, res) => {
  res.json({ status: "live", product: "LaunchPad OS", version: "7.0" });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    timestamp: new Date().toISOString()
  });
});

app.post("/api/submit", async (req, res) => {
  try {
    const { appName, appUrl, email, category, description, role, timeline, budget, monetization, targetStores } = req.body;

    if (!appName || !appUrl || !email) {
      return res.status(400).json({ success: false, error: "appName, appUrl, and email are required" });
    }

    const submission = await Submission.create({
      appName, appUrl, email, category, description,
      role, timeline, budget, monetization, targetStores
    });

    console.log("✅ New submission:", submission._id, appName, email);

    res.json({
      success: true,
      submissionId: submission._id,
      message: "Submission received. Unlock your kit to get everything.",
      next: "payment"
    });

  } catch (err) {
    console.error("Submit error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/api/submission/:id", async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    if (!submission) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, submission });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/api/admin/submissions", async (req, res) => {
  try {
    const submissions = await Submission.find().sort({ createdAt: -1 });
    res.json({ success: true, count: submissions.length, submissions });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 LaunchPad OS v7.0 running on port ${PORT}`));
