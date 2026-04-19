const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const cors = require("cors");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use((req, res, next) => {
  if (req.originalUrl === '/api/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json({ limit: "10mb" })(req, res, next);
  }
});

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

const SubmissionSchema = new mongoose.Schema({
  role: String, experience: String, timeline: String, budget: String,
  hasLandingPage: Boolean, hasAudience: Boolean, needsExports: Boolean, needsGuidance: Boolean,
  appName: { type: String, required: true },
  appUrl: { type: String, required: true },
  description: String, category: String, targetAudience: String,
  builder: String, features: [String],
  monetization: String, price: String, targetStores: [String],
  privacyPolicyUrl: String, supportEmail: String,
  loginRequired: Boolean, testEmail: String, testPassword: String,
  email: { type: String, required: true },
  launchScore: Number, appleScore: Number, googleScore: Number,
  tier: { type: String, default: "none" },
  status: { type: String, default: "pending_payment" },
  kit: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});
const Submission = mongoose.model("Submission", SubmissionSchema);

function calculateScores(data) {
  let launchScore = 0, appleScore = 70, googleScore = 70;
  const risks = [], recommendations = [];
  if (data.appName) launchScore += 10;
  if (data.appUrl) launchScore += 10;
  if (data.description && data.description.length > 100) launchScore += 15;
  else { risks.push("Weak description weakens ASO"); recommendations.push("Write 100+ character description"); }
  if (data.category) launchScore += 5;
  if (data.targetAudience) launchScore += 5;
  if (data.privacyPolicyUrl) { launchScore += 15; appleScore += 10; googleScore += 10; }
  else { risks.push("Missing privacy policy = store rejection risk"); appleScore -= 20; googleScore -= 15; recommendations.push("Create privacy policy at privacypolicygenerator.info"); }
  if (data.supportEmail) { launchScore += 10; appleScore += 5; googleScore += 5; }
  else { risks.push("Missing support email"); appleScore -= 10; googleScore -= 10; recommendations.push("Add support email"); }
  if (data.loginRequired && (!data.testEmail || !data.testPassword)) { risks.push("Login required but no test credentials"); appleScore -= 15; googleScore -= 15; recommendations.push("Add test credentials for reviewers"); }
  if (data.monetization === "subscription" && data.targetStores && data.targetStores.includes("ios")) { risks.push("iOS subscriptions require Apple IAP - Stripe alone causes rejection"); recommendations.push("Integrate Apple IAP for iOS"); }
  if (data.monetization) launchScore += 5;
  if (data.targetStores && data.targetStores.length > 0) launchScore += 5;
  const builderInsights = { lovable: "React app - excellent for Capacitor wrapping", bubble: "Bubble needs special wrapper config", flutterflow: "Native code - best store compatibility", webflow: "Works well as PWA", wordpress: "Needs performance optimization", wix: "May have iframe restrictions", react: "Ideal for Capacitor wrapping", custom: "Full flexibility for optimization" };
  const builderNote = builderInsights[data.builder] || "Ensure app is responsive and mobile-optimized";
  return { launchScore: Math.min(100, launchScore), appleScore: Math.min(100, Math.max(0, appleScore)), googleScore: Math.min(100, Math.max(0, googleScore)), risks, recommendations, builderNote };
}

function generateWrapperConfig(data) {
  const appId = `com.${(data.appName || "app").toLowerCase().replace(/[^a-z0-9]/g, "")}.app`;
  return {
    ios: { bundleId: appId, displayName: data.appName, version: "1.0.0", deploymentTarget: "14.0", capacitorConfig: { appId, appName: data.appName, webDir: "dist", server: { url: data.appUrl, cleartext: true } } },
    android: { packageName: appId, versionName: "1.0.0", versionCode: 1, minSdkVersion: 22, targetSdkVersion: 34, capacitorConfig: { appId, appName: data.appName, webDir: "dist", server: { url: data.appUrl, cleartext: true } } },
    installCommands: ["npm install @capacitor/core @capacitor/cli", "npx cap init", "npm install @capacitor/ios @capacitor/android", "npx cap add ios", "npx cap add android", "npx cap sync"]
  };
}

function generateStoreChecklist(data, scores) {
  return {
    apple: { score: scores.appleScore, passed: scores.appleScore >= 70, required: [{ item: "Privacy Policy URL", status: data.privacyPolicyUrl ? "✅" : "❌" }, { item: "Support Email", status: data.supportEmail ? "✅" : "❌" }, { item: "Test Credentials", status: (!data.loginRequired || data.testEmail) ? "✅" : "❌" }, { item: "Screenshots (6.5\" required)", status: "⚠️", action: "Generate screenshots" }, { item: "App Icon 1024x1024", status: "⚠️", action: "Prepare icon" }], monetizationWarning: data.monetization === "subscription" ? "⚠️ Apple requires IAP for subscriptions" : null },
    google: { score: scores.googleScore, passed: scores.googleScore >= 70, required: [{ item: "Privacy Policy URL", status: data.privacyPolicyUrl ? "✅" : "❌" }, { item: "Data Safety Section", status: "⚠️", action: "Complete in Play Console" }, { item: "Target API 34+", status: "✅" }] }
  };
}

function generateASO(data) {
  const categoryKeywords = { business: ["business app", "productivity tool", "workflow", "team management"], productivity: ["productivity app", "task manager", "time tracking", "efficiency"], finance: ["finance app", "money management", "budget tracker", "expense tracking"], fitness: ["fitness app", "workout tracker", "health monitoring", "wellness"], education: ["learning app", "education platform", "online courses", "e-learning"], social: ["social app", "community platform", "networking", "connect"], entertainment: ["entertainment app", "media player", "streaming", "content"], utilities: ["utility app", "tools app", "helper", "system tools"] };
  const keywords = categoryKeywords[data.category] || ["mobile app", "app solution"];
  if (data.appName) keywords.unshift(data.appName.toLowerCase());
  return { title: `${(data.appName || "App").substring(0, 30)} - ${data.category || "App"} Platform`, subtitle: `Solution for ${data.targetAudience || "everyone"}`, keywords: keywords.slice(0, 10).join(", "), shortDescription: `${data.appName} helps ${data.targetAudience || "users"}. ${(data.description || "").substring(0, 80)}`, longDescription: `${data.appName} is a powerful ${data.category || "mobile"} app for ${data.targetAudience || "modern users"}.\n\n${data.description || ""}\n\nKEY FEATURES:\n${(data.features || []).map(f => `• ${f.replace(/_/g, " ")}`).join("\n") || "• Powerful mobile experience"}\n\nDownload ${data.appName} today.`, disclaimer: "AI-generated — validate before submission" };
}

function generateScreenshotSpecs(data) {
  return { required: [{ device: "iPhone 6.7\"", size: "1290x2796", count: "3-10 required" }, { device: "iPhone 6.5\"", size: "1242x2688", count: "3-10 required" }, { device: "iPad Pro 12.9\"", size: "2048x2732", count: "3-10 if iPad" }, { device: "Google Pixel", size: "1080x1920", count: "2-8 required" }], suggestedFrames: [`Frame 1: "${data.appName} — Hero shot"`, "Frame 2: Key feature in action", "Frame 3: Social proof", "Frame 4: Second feature", "Frame 5: Download CTA"], tools: ["Canva (free)", "AppLaunchpad.com", "Figma"] };
}

function generateGrowthPlan(data, scores) {
  const basePrice = parseFloat(data.price) || 9.99;
  const monthlyDownloads = scores.launchScore * 10;
  const mrm1 = Math.round(monthlyDownloads * 0.03 * basePrice);
  return { revenueProjection: { year1ARR: `$${(mrm1 * 12).toLocaleString()}`, year2ARR: `$${(mrm1 * 30).toLocaleString()}`, year3ARR: `$${(mrm1 * 60).toLocaleString()}`, confidence: scores.launchScore > 70 ? "High" : "Medium" }, pricingTiers: [{ tier: "Starter", price: `$${(basePrice * 0.5).toFixed(2)}/mo` }, { tier: "Pro", price: `$${basePrice}/mo` }, { tier: "Agency", price: `$${(basePrice * 5).toFixed(2)}/mo` }], growthActions: ["Submit to Product Hunt on Tuesday", "Post in r/SideProject", "Create LinkedIn demo video", "Get 10 beta users for feedback", "Set up App Store Connect analytics"] };
}

function generateCompleteKit(data) {
  const scores = calculateScores(data);
  return {
    meta: { appName: data.appName, generatedAt: new Date().toISOString(), version: "LaunchPad OS v7.0", kitId: `kit_${Date.now()}` },
    scores: { launchScore: scores.launchScore, appleScore: scores.appleScore, googleScore: scores.googleScore },
    engine1_validation: { score: scores.launchScore, risks: scores.risks, recommendations: scores.recommendations, builderNote: scores.builderNote, readinessLevel: scores.launchScore >= 80 ? "Launch Ready" : scores.launchScore >= 60 ? "Almost Ready" : "Needs Work" },
    engine2_wrapper: generateWrapperConfig(data),
    engine3_storeChecklist: generateStoreChecklist(data, scores),
    engine4_aso: generateASO(data),
    engine5_screenshots: generateScreenshotSpecs(data),
    engine6_growth: generateGrowthPlan(data, scores),
    engine7_launchMap: { week1: ["Fix all ❌ items", "Generate screenshots", "Write final description"], week2: ["Submit to TestFlight/Internal Testing", "Fix review feedback"], week3: ["Submit to App Store + Google Play", "Prepare launch marketing"], week4: ["Monitor reviews", "Plan first update"] },
    complianceKit: { privacyPolicy: data.privacyPolicyUrl || "MISSING - Required", supportEmail: data.supportEmail || "MISSING - Required", coppa: "Declare if not directed at children under 13" }
  };
}

app.get("/", (req, res) => res.json({ status: "live", product: "LaunchPad OS", version: "7.0", engines: 7 }));

app.get("/health", (req, res) => res.json({ status: "ok", mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected", timestamp: new Date().toISOString() }));

app.post("/api/submit", async (req, res) => {
  try {
    const data = req.body;
    if (!data.appName || !data.appUrl || !data.email) return res.status(400).json({ success: false, error: "appName, appUrl, and email are required" });
    const scores = calculateScores(data);
    const submission = await Submission.create({ ...data, ...scores });
    console.log("✅ Submission:", submission._id, data.appName, data.email);
    res.json({ success: true, submissionId: submission._id, preview: { launchScore: scores.launchScore, appleScore: scores.appleScore, googleScore: scores.googleScore, risks: scores.risks, recommendations: scores.recommendations, builderNote: scores.builderNote }, message: "Unlock your complete kit to get wrapper configs, ASO copy, store checklist, and growth plan.", unlockUrl: "https://applilaunchpro.com/pricing" });
  } catch (err) { console.error("Submit error:", err); res.status(500).json({ success: false, error: "Server error" }); }
});

app.post("/api/generate-kit/:id", async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    if (!submission) return res.status(404).json({ success: false, error: "Not found" });
    const kit = generateCompleteKit(submission.toObject());
    submission.kit = kit; submission.status = "kit_generated";
    await submission.save();
    res.json({ success: true, kit });
  } catch (err) { res.status(500).json({ success: false, error: "Server error" }); }
});

app.get("/api/submission/:id", async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    if (!submission) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, submission });
  } catch (err) { res.status(500).json({ success: false, error: "Server error" }); }
});

app.get("/api/admin/submissions", async (req, res) => {
  try {
    const submissions = await Submission.find().sort({ createdAt: -1 });
    res.json({ success: true, count: submissions.length, submissions });
  } catch (err) { res.status(500).json({ success: false, error: "Server error" }); }
});

const PORT = process.env.PORT || 10000;
// ══════════════════════════════════════════
// STRIPE WEBHOOK — AUTO KIT DELIVERY
// ══════════════════════════════════════════
app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    const amountPaid = session.amount_total;

    console.log(`✅ Payment received: ${customerEmail} — $${amountPaid/100}`);

    try {
      // Find their submission by email
      const submission = await Submission.findOne({ 
        email: customerEmail 
      }).sort({ createdAt: -1 });

      if (!submission) {
        console.log('No submission found for:', customerEmail);
        return res.json({ received: true });
      }

      // Determine tier from amount paid
      let tier = 'launch-map';
      if (amountPaid >= 99700) tier = 'agency';
      else if (amountPaid >= 99700) tier = 'bundle';
      else if (amountPaid >= 59700) tier = 'ios-full';
      else if (amountPaid >= 19700) tier = 'launch-map';

      // Update submission status
      await Submission.findByIdAndUpdate(submission._id, {
        status: 'paid',
        tier: tier
      });

      // Generate kit
      const scores = calculateScores(submission);
      const wrapperConfig = generateWrapperConfig(submission);
      const checklist = generateStoreChecklist(submission, scores);

      // Send kit email
      const kitEmail = {
        to: customerEmail,
        from: {
          email: process.env.FROM_EMAIL,
          name: process.env.FROM_NAME || 'LaunchPad Pro'
        },
        subject: '🚀 Your LaunchPad Pro Kit is Ready!',
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#08060A;color:#fff;padding:40px;border-radius:16px;">
            <h1 style="color:#C9991A;font-size:28px;">Your Launch Kit is Ready 🔥</h1>
            <p style="color:#ccc;">Payment confirmed. Here's everything you need to launch.</p>
            
            <div style="background:#1a1a2e;padding:24px;border-radius:12px;margin:24px 0;">
              <h2 style="color:#C9991A;">📊 Your LaunchScore: ${scores.launchScore}/100</h2>
              <p>Apple Store Readiness: <strong style="color:#C9991A;">${scores.appleScore}/100</strong></p>
              <p>Google Play Readiness: <strong style="color:#C9991A;">${scores.googleScore}/100</strong></p>
            </div>

            <div style="background:#1a1a2e;padding:24px;border-radius:12px;margin:24px 0;">
              <h2 style="color:#C9991A;">⚙️ Wrapper Config</h2>
              <pre style="color:#E8431A;font-size:12px;overflow-x:auto;">${JSON.stringify(wrapperConfig, null, 2)}</pre>
            </div>

            <div style="background:#1a1a2e;padding:24px;border-radius:12px;margin:24px 0;">
              <h2 style="color:#C9991A;">✅ Store Submission Checklist</h2>
              <pre style="color:#ccc;font-size:12px;">${JSON.stringify(checklist, null, 2)}</pre>
            </div>

            <p style="color:#888;font-size:12px;margin-top:32px;">
              LaunchPad Pro OS · Salisbury, NC · Reply to this email for support
            </p>
          </div>
        `
      };

      await sgMail.send(kitEmail);
      console.log(`📧 Kit emailed to: ${customerEmail}`);

    } catch (err) {
      console.error('Kit delivery error:', err);
    }
  }

  res.json({ received: true });
});
app.listen(PORT, () => console.log(`🚀 LaunchPad OS v7.0 — All 7 engines running on port ${PORT}`));
