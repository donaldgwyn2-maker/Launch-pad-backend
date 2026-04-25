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

// ════════════════════════════════════════════════════════
// MONGODB CONNECTION
// ════════════════════════════════════════════════════════
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ════════════════════════════════════════════════════════
// SUBMISSION SCHEMA
// ════════════════════════════════════════════════════════
const SubmissionSchema = new mongoose.Schema({
  // Step 1 - Role
  role: String,
  experience: String,
  timeline: String,
  budget: String,
  hasLandingPage: Boolean,
  hasAudience: Boolean,
  needsExports: Boolean,
  needsGuidance: Boolean,
  // Step 2 - App Identity
  appName: { type: String, required: true },
  appUrl: { type: String, required: true },
  description: String,
  category: String,
  targetAudience: String,
  // Step 3 - Technical
  builderTool: String,
  targetStores: [String],
  hasAppleAccount: Boolean,
  hasGoogleAccount: Boolean,
  // Step 4 - Monetization
  monetization: String,
  revenueModel: String,
  hasIAP: Boolean,
  // Step 5 - Compliance
  hasPrivacyPolicy: Boolean,
  collectsUserData: Boolean,
  dataTypes: [String],
  // Step 6 - Privacy
  hasAnalytics: Boolean,
  analyticsTools: [String],
  // Step 7 - ASO
  appKeywords: String,
  competitorApps: String,
  hasScreenshots: Boolean,
  hasAppIcon: Boolean,
  // Meta
  email: String,
  launchScore: Number,
  appleScore: Number,
  googleScore: Number,
  tier: String,
  paid: { type: Boolean, default: false },
  paidAt: Date,
  stripeSessionId: String,
  kitSent: { type: Boolean, default: false },
  submittedAt: { type: Date, default: Date.now },
});

const Submission = mongoose.model("Submission", SubmissionSchema);

// ════════════════════════════════════════════════════════
// SCORE ENGINE
// ════════════════════════════════════════════════════════
function calculateScores(data) {
  let apple = 70;
  let google = 70;

  if (data.hasPrivacyPolicy) { apple += 10; google += 10; }
  if (data.hasIAP) apple -= 5;
  if (data.hasAppIcon) { apple += 5; google += 5; }
  if (data.hasScreenshots) { apple += 5; google += 5; }
  if (data.hasAppleAccount) apple += 5;
  if (data.hasGoogleAccount) google += 5;
  if (data.appKeywords && data.appKeywords.length > 20) { apple += 5; google += 5; }
  if (data.collectsUserData && !data.hasPrivacyPolicy) { apple -= 15; google -= 15; }
  if (data.builderTool === "lovable" || data.builderTool === "bubble") { apple -= 5; google -= 3; }
  if (data.hasAudience) { apple += 3; google += 3; }
  if (data.hasLandingPage) { apple += 2; google += 2; }

  apple = Math.min(100, Math.max(0, apple));
  google = Math.min(100, Math.max(0, google));
  const total = Math.round((apple + google) / 2);

  return { total, apple, google };
}

// ════════════════════════════════════════════════════════
// WRAPPER CONFIG ENGINE
// ════════════════════════════════════════════════════════
function generateWrapperConfig(data) {
  const builder = (data.builderTool || "").toLowerCase();
  const stores = data.targetStores || [];
  const bothStores = stores.includes("apple") && stores.includes("google");

  let wrapperPath = "Capacitor";
  let wrapperReason = "Best for web-based no-code builders";

  if (builder === "flutterflow") {
    wrapperPath = "FlutterFlow Native Export";
    wrapperReason = "Direct native export — no WebView, maximum performance";
  } else if (builder === "expo" || builder === "react-native") {
    wrapperPath = "Expo EAS";
    wrapperReason = "Managed React Native builds — no Mac required for iOS";
  } else if (builder === "bubble" || builder === "webflow" || builder === "lovable") {
    wrapperPath = "Capacitor";
    wrapperReason = "Industry standard for web apps — works with your builder";
  }

  const iosConfig = `{
  "appId": "com.${(data.appName || "yourapp").toLowerCase().replace(/\s/g, "")}.app",
  "appName": "${data.appName || "Your App"}",
  "webDir": "dist",
  "server": {
    "androidScheme": "https"
  },
  "ios": {
    "contentInset": "automatic"
  },
  "plugins": {
    "PushNotifications": {
      "presentationOptions": ["badge", "sound", "alert"]
    }
  }
}`;

  return {
    wrapperPath,
    wrapperReason,
    bothStores,
    capacitorConfig: iosConfig,
  };
}

// ════════════════════════════════════════════════════════
// STORE CHECKLIST ENGINE
// ════════════════════════════════════════════════════════
function generateStoreChecklist(data, scores) {
  const issues = [];

  if (!data.hasPrivacyPolicy) issues.push({ severity: "HIGH", item: "Missing privacy policy URL — required by both Apple and Google" });
  if (!data.hasAppIcon) issues.push({ severity: "HIGH", item: "No app icon — submission blocked without it" });
  if (!data.hasScreenshots) issues.push({ severity: "HIGH", item: "No screenshots — required minimum 3 for App Store" });
  if (data.hasIAP && !data.hasAppleAccount) issues.push({ severity: "HIGH", item: "In-App Purchases require Apple Developer account with banking set up" });
  if (data.collectsUserData && !data.hasPrivacyPolicy) issues.push({ severity: "CRITICAL", item: "Collecting user data without privacy policy — automatic rejection" });
  if (!data.appKeywords || data.appKeywords.length < 10) issues.push({ severity: "MEDIUM", item: "Weak or missing keywords — hurts ASO and discoverability" });
  if (!data.hasAppleAccount && data.targetStores?.includes("apple")) issues.push({ severity: "HIGH", item: "No Apple Developer account — required before submission ($99/yr)" });
  if (!data.hasGoogleAccount && data.targetStores?.includes("google")) issues.push({ severity: "HIGH", item: "No Google Play account — required before submission ($25 one-time)" });

  return issues;
}

// ════════════════════════════════════════════════════════
// KIT EMAIL GENERATOR
// ════════════════════════════════════════════════════════
function generateKitEmail(submission, tier) {
  const scores = calculateScores(submission);
  const wrapper = generateWrapperConfig(submission);
  const issues = generateStoreChecklist(submission, scores);
  const issuesList = issues.map(i => `<li><b style="color:${i.severity === 'CRITICAL' ? '#ff4444' : i.severity === 'HIGH' ? '#ff8800' : '#ffcc00'}">[${i.severity}]</b> ${i.item}</li>`).join("");

  const tierName = {
    "price_launch_map_27": "Launch Map",
    "price_ios_full_197": "iOS Full Launch",
    "price_both_platforms_347": "Both Platforms Bundle",
    "price_agency_149": "Agency Launcher Pro"
  }[tier] || "LaunchPad Pro";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#04060f;font-family:'DM Sans',Arial,sans-serif;color:#dde4f0;">
  <div style="max-width:640px;margin:0 auto;padding:40px 20px;">

    <div style="text-align:center;margin-bottom:32px;">
      <div style="font-size:48px;margin-bottom:12px;">🚀</div>
      <h1 style="font-size:28px;font-weight:900;color:#ffffff;margin:0 0 8px;">Your LaunchPad Kit Is Ready</h1>
      <p style="color:#8899b8;font-size:15px;margin:0;">Plan: <b style="color:#00b4ff;">${tierName}</b></p>
    </div>

    <!-- LAUNCH SCORE -->
    <div style="background:#0b0f1f;border:1px solid rgba(0,180,255,0.2);border-radius:14px;padding:24px;margin-bottom:20px;">
      <h2 style="font-size:14px;color:#00b4ff;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px;">LaunchScore™ Report</h2>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;text-align:center;background:#080c1a;border-radius:10px;padding:16px;">
          <div style="font-size:36px;font-weight:900;color:${scores.total >= 80 ? '#00e87a' : scores.total >= 60 ? '#f5c518' : '#ff5c2a'};">${scores.total}</div>
          <div style="font-size:11px;color:#6b7899;text-transform:uppercase;letter-spacing:1px;">Overall Score</div>
        </div>
        <div style="flex:1;text-align:center;background:#080c1a;border-radius:10px;padding:16px;">
          <div style="font-size:36px;font-weight:900;color:#00b4ff;">${scores.apple}</div>
          <div style="font-size:11px;color:#6b7899;text-transform:uppercase;letter-spacing:1px;">Apple Score</div>
        </div>
        <div style="flex:1;text-align:center;background:#080c1a;border-radius:10px;padding:16px;">
          <div style="font-size:36px;font-weight:900;color:#00e87a;">${scores.google}</div>
          <div style="font-size:11px;color:#6b7899;text-transform:uppercase;letter-spacing:1px;">Google Score</div>
        </div>
      </div>
    </div>

    <!-- WRAPPER CONFIG -->
    <div style="background:#0b0f1f;border:1px solid rgba(0,180,255,0.15);border-radius:14px;padding:24px;margin-bottom:20px;">
      <h2 style="font-size:14px;color:#00e87a;letter-spacing:2px;text-transform:uppercase;margin:0 0 12px;">Wrapper Config Kit</h2>
      <p style="color:#dde4f0;font-size:14px;margin:0 0 8px;"><b>Recommended Path:</b> ${wrapper.wrapperPath}</p>
      <p style="color:#8899b8;font-size:13px;margin:0 0 16px;">${wrapper.wrapperReason}</p>
      <div style="background:#04060f;border-radius:8px;padding:14px;font-family:monospace;font-size:11px;color:#00b4ff;white-space:pre-wrap;overflow-x:auto;">${wrapper.capacitorConfig}</div>
    </div>

    <!-- REJECTION SHIELD -->
    ${issues.length > 0 ? `
    <div style="background:#0b0f1f;border:1px solid rgba(255,92,42,0.2);border-radius:14px;padding:24px;margin-bottom:20px;">
      <h2 style="font-size:14px;color:#ff5c2a;letter-spacing:2px;text-transform:uppercase;margin:0 0 12px;">Rejection Shield — Fix These First</h2>
      <ul style="padding-left:20px;margin:0;color:#c8d0e0;font-size:13px;line-height:1.8;">${issuesList}</ul>
    </div>` : `
    <div style="background:#0b0f1f;border:1px solid rgba(0,232,122,0.2);border-radius:14px;padding:24px;margin-bottom:20px;">
      <h2 style="font-size:14px;color:#00e87a;letter-spacing:2px;text-transform:uppercase;margin:0 0 8px;">Rejection Shield</h2>
      <p style="color:#8899b8;font-size:13px;margin:0;">✅ No critical issues detected. Your app looks store-ready.</p>
    </div>`}

    <!-- NEXT STEPS -->
    <div style="background:#0b0f1f;border:1px solid rgba(0,180,255,0.1);border-radius:14px;padding:24px;margin-bottom:20px;">
      <h2 style="font-size:14px;color:#00b4ff;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px;">Your Launch Roadmap</h2>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${["Fix every item in your Rejection Shield first", "Set up your wrapper using the Capacitor config above", "Create your app icon (1024x1024px) and screenshots", "Set up TestFlight (iOS) or Google Play Internal Testing", "Submit using your store checklist — nothing skipped", "Launch your ASO kit on day one for organic downloads"].map((step, i) => `
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="width:24px;height:24px;border-radius:50%;background:rgba(0,180,255,0.12);border:1px solid rgba(0,180,255,0.3);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#00b4ff;flex-shrink:0;">${i + 1}</div>
          <div style="font-size:13px;color:#c8d0e0;padding-top:3px;">${step}</div>
        </div>`).join("")}
      </div>
    </div>

    <!-- FOOTER -->
    <div style="text-align:center;padding:20px 0;border-top:1px solid rgba(255,255,255,0.05);">
      <p style="color:#6b7899;font-size:12px;margin:0 0 8px;">Questions? Reply to this email — we respond within 24 hours.</p>
      <p style="color:#6b7899;font-size:12px;margin:0;">LaunchPad Pro · applilaunchpro.com</p>
    </div>

  </div>
</body>
</html>`;
}

// ════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
});

// Form submission
app.post("/api/submit", async (req, res) => {
  try {
    const data = req.body;
    const scores = calculateScores(data);

    const submission = new Submission({
      ...data,
      launchScore: scores.total,
      appleScore: scores.apple,
      googleScore: scores.google,
    });

    await submission.save();

    const issues = generateStoreChecklist(data, scores);
    const wrapper = generateWrapperConfig(data);

    res.json({
      success: true,
      submissionId: submission._id,
      scores,
      issues,
      wrapper,
    });
  } catch (err) {
    console.error("Submit error:", err);
    res.status(500).json({ error: "Submission failed", details: err.message });
  }
});

// Admin view submissions
app.get("/api/admin/submissions", async (req, res) => {
  try {
    const submissions = await Submission.find().sort({ submittedAt: -1 }).limit(50);
    res.json(submissions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// STRIPE WEBHOOK — FIRES KIT EMAIL ON PAYMENT
// ════════════════════════════════════════════════════════
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
    const customerEmail = session.customer_details?.email || session.customer_email;
    const sessionId = session.id;

    // Map Stripe price IDs to tier names
    // UPDATE THESE WITH YOUR LIVE PRICE IDs FROM STRIPE DASHBOARD
    const PRICE_MAP = {
      // Test mode price IDs — replace with live IDs when you go live
      "price_1TPt6ZGdoih5u53aXYZlaunch": "Launch Map",
      "price_1TPt7kGdoih5u53aXYZios": "iOS Full Launch",
      "price_1TPt8RGdoih5u53aXYZboth": "Both Platforms Bundle",
      "price_1TPt9gGdoih5u53aXYZagency": "Agency Launcher Pro",
    };

    // Get the price ID from the line items
    let tierName = "LaunchPad Pro Kit";
    try {
      const lineItems = await stripe.checkout.sessions.listLineItems(sessionId);
      const priceId = lineItems.data[0]?.price?.id;
      if (priceId && PRICE_MAP[priceId]) {
        tierName = PRICE_MAP[priceId];
      }
    } catch (e) {
      console.log("Could not fetch line items:", e.message);
    }

    console.log(`💰 Payment received: ${customerEmail} — ${tierName}`);

    // Find their submission in MongoDB by email
    let submission = null;
    if (customerEmail) {
      submission = await Submission.findOne({ email: customerEmail }).sort({ submittedAt: -1 });
    }

    // Mark as paid
    if (submission) {
      submission.paid = true;
      submission.paidAt = new Date();
      submission.stripeSessionId = sessionId;
      submission.tier = tierName;
      await submission.save();
    }

    // Send kit email to customer
    if (customerEmail) {
      try {
        const kitHtml = generateKitEmail(submission || {}, tierName);

        await sgMail.send({
          to: customerEmail,
          from: {
            email: process.env.FROM_EMAIL || "donaldgwyn2@gmail.com",
            name: "LaunchPad Pro",
          },
          subject: `🚀 Your ${tierName} Kit Is Ready — LaunchPad Pro`,
          html: kitHtml,
        });

        console.log(`✅ Kit email sent to ${customerEmail}`);

        // Mark kit as sent
        if (submission) {
          submission.kitSent = true;
          await submission.save();
        }
      } catch (emailErr) {
        console.error("❌ SendGrid error:", emailErr.message);
      }
    }

    // Notify Donny of every sale
    try {
      await sgMail.send({
        to: "donaldgwyn2@gmail.com",
        from: {
          email: process.env.FROM_EMAIL || "donaldgwyn2@gmail.com",
          name: "LaunchPad Pro — Sales Alert",
        },
        subject: `💰 NEW SALE: ${tierName} — ${customerEmail}`,
        html: `
          <div style="background:#04060f;padding:32px;font-family:Arial,sans-serif;color:#dde4f0;border-radius:12px;">
            <h2 style="color:#00e87a;margin:0 0 16px;">💰 New LaunchPad Sale!</h2>
            <p style="font-size:16px;margin:0 0 8px;"><b>Plan:</b> <span style="color:#00b4ff;">${tierName}</span></p>
            <p style="font-size:16px;margin:0 0 8px;"><b>Customer:</b> ${customerEmail}</p>
            <p style="font-size:16px;margin:0 0 8px;"><b>Session:</b> ${sessionId}</p>
            <p style="font-size:16px;margin:0;"><b>Time:</b> ${new Date().toLocaleString()}</p>
          </div>
        `,
      });
      console.log("✅ Sale notification sent to Donny");
    } catch (notifyErr) {
      console.error("❌ Notify error:", notifyErr.message);
    }
  }

  res.json({ received: true });
});

// ════════════════════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════════════════════
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 LaunchPad OS — Running on port ${PORT}`);
  console.log(`✅ Stripe webhook ready at /api/webhook`);
  console.log(`✅ SendGrid kit delivery active`);
  console.log(`✅ Sale notifications → donaldgwyn2@gmail.com`);
});
