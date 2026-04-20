const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
require("dotenv").config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

// ── Raw body for Stripe webhook, JSON for everything else ──
app.use((req, res, next) => {
  if (req.originalUrl === "/api/webhook") {
    express.raw({ type: "application/json" })(req, res, next);
  } else {
    express.json({ limit: "10mb" })(req, res, next);
  }
});

// ══════════════════════════════════════════
// MONGODB CONNECTION
// ══════════════════════════════════════════
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ══════════════════════════════════════════
// SUBMISSION SCHEMA
// ══════════════════════════════════════════
const SubmissionSchema = new mongoose.Schema({
  role: String,
  experience: String,
  timeline: String,
  budget: String,
  hasLandingPage: Boolean,
  hasAudience: Boolean,
  needsExports: Boolean,
  needsGuidance: Boolean,
  appName: { type: String, required: true },
  appUrl: { type: String, required: true },
  description: String,
  category: String,
  targetAudience: String,
  builder: String,
  features: [String],
  monetization: String,
  price: String,
  targetStores: [String],
  privacyPolicyUrl: String,
  supportEmail: String,
  loginRequired: Boolean,
  testEmail: String,
  testPassword: String,
  email: { type: String, required: true },
  launchScore: Number,
  appleScore: Number,
  googleScore: Number,
  tier: { type: String, default: "none" },
  status: { type: String, default: "pending_payment" },
  kit: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
});

const Submission = mongoose.model("Submission", SubmissionSchema);

// ══════════════════════════════════════════
// ENGINE 1 — CALCULATE SCORES
// ══════════════════════════════════════════
function calculateScores(data) {
  let launchScore = 0,
    appleScore = 70,
    googleScore = 70;
  const risks = [],
    recommendations = [];

  if (data.appName) launchScore += 10;
  if (data.appUrl) launchScore += 10;
  if (data.description && data.description.length > 100) launchScore += 15;
  else {
    risks.push("Weak description weakens ASO");
    recommendations.push("Write 100+ character description");
  }
  if (data.category) launchScore += 5;
  if (data.targetAudience) launchScore += 5;
  if (data.privacyPolicyUrl) {
    launchScore += 15;
    appleScore += 10;
    googleScore += 10;
  } else {
    risks.push("Missing privacy policy = store rejection risk");
    appleScore -= 20;
    googleScore -= 15;
    recommendations.push("Add a privacy policy page");
  }
  if (data.supportEmail) {
    launchScore += 10;
    appleScore += 5;
    googleScore += 5;
  } else {
    risks.push("Missing support email");
    appleScore -= 10;
    googleScore -= 10;
    recommendations.push("Add support email");
  }
  if (data.loginRequired && !data.testPassword)
    risks.push("Login required but no test credentials");
  if (data.monetization) launchScore += 5;
  if (data.targetStores && data.targetStores.length > 0) launchScore += 5;

  const builderInsights = {
    lovable: "React app — excellent for Capacitor wrapping",
    bubble: "Bubble needs special export steps",
    webflow: "Webflow exports clean HTML — wrap with Capacitor",
    flutterflow: "FlutterFlow outputs native Flutter — direct store ready",
  };
  const builderNote =
    builderInsights[data.builder] || "Ensure app is mobile-optimized";

  return {
    launchScore: Math.min(100, launchScore),
    appleScore: Math.min(100, Math.max(0, appleScore)),
    googleScore: Math.min(100, Math.max(0, googleScore)),
    risks,
    recommendations,
    builderNote,
  };
}

// ══════════════════════════════════════════
// ENGINE 2 — WRAPPER CONFIG
// ══════════════════════════════════════════
function generateWrapperConfig(data) {
  const appId = `com.${(data.appName || "app")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")}.app`;
  return {
    ios: {
      bundleId: appId,
      displayName: data.appName,
      version: "1.0.0",
      deploymentTarget: "14.0",
    },
    android: {
      packageName: appId,
      versionName: "1.0.0",
      versionCode: 1,
      minSdkVersion: 22,
      targetSdkVersion: 34,
    },
    installCommands: [
      "npm install @capacitor/core @capacitor/cli",
      "npx cap init",
      "npm install @capacitor/ios @capacitor/android",
      "npx cap add ios",
      "npx cap add android",
      "npx cap sync",
    ],
  };
}

// ══════════════════════════════════════════
// ENGINE 3 — STORE CHECKLIST
// ══════════════════════════════════════════
function generateStoreChecklist(data, scores) {
  return {
    apple: {
      ready: scores.appleScore >= 60,
      score: scores.appleScore,
      items: [
        { item: "App Name", status: data.appName ? "✅" : "❌" },
        { item: "Description", status: data.description ? "✅" : "❌" },
        { item: "Privacy Policy", status: data.privacyPolicyUrl ? "✅" : "❌" },
        { item: "Support Email", status: data.supportEmail ? "✅" : "❌" },
        { item: "Category", status: data.category ? "✅" : "❌" },
      ],
    },
    google: {
      ready: scores.googleScore >= 60,
      score: scores.googleScore,
      items: [
        { item: "App Name", status: data.appName ? "✅" : "❌" },
        { item: "Description", status: data.description ? "✅" : "❌" },
        { item: "Privacy Policy", status: data.privacyPolicyUrl ? "✅" : "❌" },
        { item: "Support Email", status: data.supportEmail ? "✅" : "❌" },
        { item: "Target Audience", status: data.targetAudience ? "✅" : "❌" },
      ],
    },
  };
}

// ══════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
});

// Submit intake form
app.post("/api/submit", async (req, res) => {
  try {
    const data = req.body;
    const scores = calculateScores(data);
    const submission = new Submission({ ...data, ...scores });
    await submission.save();
    res.json({ success: true, submissionId: submission._id, scores });
  } catch (err) {
    console.error("Submit error:", err);
    res.status(500).json({ error: "Submission failed" });
  }
});

// Get all submissions (admin)
app.get("/api/admin/submissions", async (req, res) => {
  try {
    const submissions = await Submission.find().sort({ createdAt: -1 });
    res.json(submissions);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch submissions" });
  }
});

// ══════════════════════════════════════════
// STRIPE WEBHOOK — AUTO KIT DELIVERY
// ══════════════════════════════════════════
app.post("/api/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    const amountPaid = session.amount_total;

    console.log(`✅ Payment: ${customerEmail} — $${amountPaid / 100}`);

    try {
      const submission = await Submission.findOne({
        email: customerEmail,
      }).sort({ createdAt: -1 });

      if (!submission) {
        console.log("No submission found for:", customerEmail);
        return res.json({ received: true });
      }

      // Determine tier
      let tier = "launch-map";
      if (amountPaid >= 99700) tier = "agency";
      else if (amountPaid >= 59700) tier = "ios-full";
      else if (amountPaid >= 19700) tier = "launch-map";

      await Submission.findByIdAndUpdate(submission._id, {
        status: "paid",
        tier,
      });

      // Generate kit
      const scores = calculateScores(submission);
      const wrapperConfig = generateWrapperConfig(submission);
      const checklist = generateStoreChecklist(submission, scores);

      // Send kit email
      const msg = {
        to: customerEmail,
        from: {
          email: process.env.FROM_EMAIL,
          name: process.env.FROM_NAME || "LaunchPad Pro",
        },
        subject: "🚀 Your LaunchPad Pro Kit is Ready!",
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#08060A;color:#fff;padding:40px;border-radius:16px;">
            <h1 style="color:#C9991A;font-size:28px;margin-bottom:8px;">Your Launch Kit is Ready 🔥</h1>
            <p style="color:#aaa;">Payment confirmed for <strong>${submission.appName}</strong>. Here's everything you need.</p>

            <div style="background:#111;border:1px solid #C9991A;padding:24px;border-radius:12px;margin:24px 0;">
              <h2 style="color:#C9991A;margin-top:0;">📊 LaunchScore: ${scores.launchScore}/100</h2>
              <p style="margin:4px 0;">🍎 Apple Store Readiness: <strong style="color:#C9991A;">${scores.appleScore}/100</strong></p>
              <p style="margin:4px 0;">🤖 Google Play Readiness: <strong style="color:#C9991A;">${scores.googleScore}/100</strong></p>
            </div>

            <div style="background:#111;border:1px solid #333;padding:24px;border-radius:12px;margin:24px 0;">
              <h2 style="color:#C9991A;margin-top:0;">⚙️ Wrapper Config</h2>
              <p style="color:#aaa;font-size:13px;">Bundle ID: <code style="color:#E8431A;">${wrapperConfig.ios.bundleId}</code></p>
              <p style="color:#aaa;font-size:13px;">iOS Target: ${wrapperConfig.ios.deploymentTarget}+</p>
              <p style="color:#aaa;font-size:13px;">Android Min SDK: ${wrapperConfig.android.minSdkVersion}</p>
              <p style="color:#C9991A;font-size:13px;font-weight:bold;">Install Commands:</p>
              ${wrapperConfig.installCommands.map(cmd => `<p style="color:#E8431A;font-size:12px;font-family:monospace;margin:2px 0;">${cmd}</p>`).join("")}
            </div>

            <div style="background:#111;border:1px solid #333;padding:24px;border-radius:12px;margin:24px 0;">
              <h2 style="color:#C9991A;margin-top:0;">✅ Store Checklist</h2>
              <p style="color:#aaa;font-size:13px;font-weight:bold;">Apple App Store:</p>
              ${checklist.apple.items.map(i => `<p style="margin:2px 0;font-size:13px;">${i.status} ${i.item}</p>`).join("")}
              <p style="color:#aaa;font-size:13px;font-weight:bold;margin-top:12px;">Google Play:</p>
              ${checklist.google.items.map(i => `<p style="margin:2px 0;font-size:13px;">${i.status} ${i.item}</p>`).join("")}
            </div>

            ${scores.risks.length > 0 ? `
            <div style="background:#1a0a0a;border:1px solid #E8431A;padding:24px;border-radius:12px;margin:24px 0;">
              <h2 style="color:#E8431A;margin-top:0;">⚠️ Risks to Fix</h2>
              ${scores.risks.map(r => `<p style="margin:4px 0;font-size:13px;color:#ffaaaa;">• ${r}</p>`).join("")}
            </div>` : ""}

            <div style="background:#111;border:1px solid #333;padding:24px;border-radius:12px;margin:24px 0;">
              <h2 style="color:#C9991A;margin-top:0;">💡 Builder Note</h2>
              <p style="color:#aaa;font-size:13px;">${scores.builderNote}</p>
            </div>

            <p style="color:#555;font-size:12px;margin-top:32px;border-top:1px solid #222;padding-top:16px;">
              LaunchPad Pro OS · Salisbury, NC · Reply to this email for support<br>
              <a href="https://applilaunchpro.com" style="color:#C9991A;">applilaunchpro.com</a>
            </p>
          </div>
        `,
      };

      await sgMail.send(msg);
      console.log(`📧 Kit emailed to: ${customerEmail}`);
    } catch (err) {
      console.error("Kit delivery error:", err);
    }
  }

  res.json({ received: true });
});

// ══════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 LaunchPad OS v7.0 — All 7 engines running on port ${PORT}`);
});
