import express from "express";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import fs from "fs";
import crypto from "crypto";
import { initDb, getDb } from "./database";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const JWT_SECRET = process.env.JWT_SECRET || "fathers-house-secret-key";

// Ensure uploads folder exists
const uploadDir = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use("/uploads", express.static(uploadDir));

// Config multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Initialize server-side Gemini Client with standard agent header
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

// Middleware to authenticate JWT
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Access token required" });

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ error: "Invalid or expired token" });
    req.user = user;
    next();
  });
};

// Middleware to require Admin role
const requireAdmin = (req: any, res: any, next: any) => {
  authenticateToken(req, res, () => {
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  });
};


// ChMS Gemini API: 1. Generate Scripture-grounded Pastoral Comfort response
app.post("/api/gemini/pastoral-response", async (req, res) => {
  try {
    const { name, category, requestText } = req.body;
    if (!requestText) {
      return res.status(400).json({ error: "requestText is required" });
    }

    const userName = name || "Dear Friend";
    const categoryName = category || "Pastoral Support";

    const prompt = `You are Dr Bishop Lufuno Nemavhola, a warm, caring, loving, and supportive senior leader of Fathers House Church.
    A member or visitor named "${userName}" has submitted a pastoral request under the category "${categoryName}":
    "${requestText}"

    Write a personal, warm, encouraging pastoral response addressing this request.
    - Be deeply comforting, empathetic, and respectful.
    - Offer custom prayer and include exactly one relevant, inspiring biblical Scripture verse (including reference and text, e.g., "Romans 8:28...").
    - Keep it concise, natural, and personal (between 3 to 5 sentences).
    - Address the user as "${userName}" and sign off warmly as "Dr Bishop Lufuno Nemavhola and the Care Team".`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
    });

    const aiDraft = response.text || "Grace and peace to you. We are standing with you in prayer. - Dr Bishop Lufuno Nemavhola and the Care Team";
    res.json({ aiDraft });
  } catch (error: any) {
    console.error("Gemini Response Generation Error:", error);
    res.status(500).json({ error: error.message || "Failed to generate AI response draft." });
  }
});

// ChMS Gemini API: 2. Auto-categorize Emergency Level (High, Medium, Low)
app.post("/api/gemini/categorize-emergency", async (req, res) => {
  try {
    const { requestText } = req.body;
    if (!requestText) {
      return res.status(400).json({ error: "requestText is required" });
    }

    const prompt = `Read the following pastoral care or prayer request from a church member:
"${requestText}"

Based on the message context, classify its urgency / emergency level into exactly one of these categories:
- 'High': If there is mentions of critical illness, hospitalization, surgery, ICU, death/loss, accidents, or immediate crisis.
- 'Medium': If there is mentions of general sickness, pain, job loss, marital struggle, high anxiety, fear, or minor struggles.
- 'Low': If it is a general prayer request, volunteer inquiry, visitor greetings, birthday milestone, or non-urgent update.

Respond ONLY with a valid JSON block containing a single key "emergencyLevel" whose value is one of ["High", "Medium", "Low"]. Do not output any other text or markdown wrappers. Example output:
{"emergencyLevel": "Medium"}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
    });

    let rawText = response.text || "";
    // Clean potential markdown blocks
    rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

    try {
      const parsed = JSON.parse(rawText);
      const level = parsed.emergencyLevel || "Low";
      res.json({ emergencyLevel: level });
    } catch {
      // Fallback based on keywords
      let level = "Low";
      const textLower = requestText.toLowerCase();
      if (['surgery', 'hospital', 'critical', 'accident', 'icu', 'death', 'loss', 'grief', 'passed away', 'funeral', 'bereavement'].some(k => textLower.includes(k))) {
        level = "High";
      } else if (['sick', 'pain', 'volunteer', 'depressed', 'struggle', 'job', 'finances', 'anxious', 'fear'].some(k => textLower.includes(k))) {
        level = "Medium";
      }
      res.json({ emergencyLevel: level });
    }
  } catch (error: any) {
    console.error("Gemini Categorization Error:", error);
    res.status(500).json({ error: error.message || "Failed to auto-categorize emergency level." });
  }
});

// ChMS Gemini API: 3. Summarize Analytics Executive Report
app.post("/api/gemini/summarize-analytics", async (req, res) => {
  try {
    const { metrics } = req.body;
    if (!metrics) {
      return res.status(400).json({ error: "metrics data is required" });
    }

    const { totalMembers, attendanceRate, totalDonations, totalEvents, categoriesDistribution } = metrics;

    const prompt = `You are the executive director of administration at Fathers House Church.
Review the following metrics collected from our real-time Google Sheets database:
- Total Members: ${totalMembers}
- Attendance Rate: ${attendanceRate}%
- Weekly/Recent Offerings Total: R ${totalDonations}
- Upcoming Scheduled Events: ${totalEvents}
- Contributions Distribution by Category: ${JSON.stringify(categoriesDistribution)}

Write a professional, encouraging, and narrative executive summary (1-2 paragraphs) for the Church board and staff.
- Highlight key insights (e.g. attendance rate status, giving allocations, and events).
- Suggest exactly one actionable administrative milestone or focus area based on the numbers (e.g., if attendance is high, highlight community cell engagement; if tithes are strong, suggest outreach expansion).
- Use warm, hopeful language to motivate the leaders and maintain high administrative momentum.
- Keep the final response strictly within 120-150 words. Do not use markdown titles.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
    });

    const narrativeSummary = response.text || "Metrics compiled successfully. The church maintains steady community engagement and healthy stewardship.";
    res.json({ narrativeSummary });
  } catch (error: any) {
    console.error("Gemini Analytics Summary Error:", error);
    res.status(500).json({ error: error.message || "Failed to generate analytics summary." });
  }
});

// Auth routes
app.post("/api/auth/login", (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const db = getDb();
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user: any) => {
      try {
        if (err) {
          console.error("Login database query error:", err);
          return res.status(500).json({ error: err.message });
        }
        if (!user) {
          return res.status(401).json({ error: "Invalid credentials" });
        }
        
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
          return res.status(401).json({ error: "Invalid credentials" });
        }
        
        const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
        return res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
      } catch (innerErr: any) {
        console.error("Login hash/sign error:", innerErr);
        return res.status(500).json({ error: innerErr.message || "Failed to process login" });
      }
    });
  } catch (outerErr: any) {
    console.error("Login outer route error:", outerErr);
    return res.status(500).json({ error: outerErr.message || "Server error during login" });
  }
});

app.post("/api/auth/register", (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }
    const db = getDb();
    db.get("SELECT id FROM users WHERE email = ?", [email], async (err, row) => {
      try {
        if (err) {
          console.error("Registration query error:", err);
          return res.status(500).json({ error: err.message });
        }
        if (row) {
          return res.status(400).json({ error: "User already exists" });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(
          "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
          [name, email, hashedPassword, 'member'],
          function (insertErr) {
            try {
              if (insertErr) {
                console.error("Registration insert error:", insertErr);
                return res.status(500).json({ error: insertErr.message });
              }
              return res.json({ message: "Registration successful" });
            } catch (innerRunErr: any) {
              return res.status(500).json({ error: innerRunErr.message || "Registration write failed" });
            }
          }
        );
      } catch (innerErr: any) {
        console.error("Registration hash error:", innerErr);
        return res.status(500).json({ error: innerErr.message || "Registration failed" });
      }
    });
  } catch (outerErr: any) {
    console.error("Registration outer error:", outerErr);
    return res.status(500).json({ error: outerErr.message || "Server error during registration" });
  }
});

// Users management routes (admin-only)
app.get("/api/users", requireAdmin, (req, res) => {
  const db = getDb();
  db.all("SELECT id, name, email, role, created_at FROM users", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post("/api/users", requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "Name, email, password, and role are required" });
  }
  const db = getDb();
  db.get("SELECT id FROM users WHERE email = ?", [email], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row) return res.status(400).json({ error: "User already exists" });
    
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      db.run(
        "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
        [name, email, hashedPassword, role],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ id: this.lastID, name, email, role, created_at: new Date().toISOString() });
        }
      );
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.put("/api/users/:id/role", requireAdmin, (req, res) => {
  const { role } = req.body;
  const { id } = req.params;
  if (!role || !['admin', 'member'].includes(role)) {
    return res.status(400).json({ error: "Invalid role specified" });
  }
  const db = getDb();
  db.run("UPDATE users SET role = ? WHERE id = ?", [role, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "User role updated successfully" });
  });
});

app.delete("/api/users/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const db = getDb();
  db.run("DELETE FROM users WHERE id = ?", [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "User deleted successfully" });
  });
});

// Media endpoints
app.get("/api/media", (req, res) => {
  const db = getDb();
  db.all("SELECT * FROM media_files ORDER BY created_at DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post("/api/media/upload", requireAdmin, upload.single('file'), (req, res) => {
  const { title } = req.body;
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  const uploadedBy = (req as any).user.name;
  
  const db = getDb();
  db.run(
    "INSERT INTO media_files (title, file_url, uploaded_by) VALUES (?, ?, ?)",
    [title || req.file.originalname, fileUrl, uploadedBy],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        id: this.lastID,
        title: title || req.file!.originalname,
        file_url: fileUrl,
        uploaded_by: uploadedBy,
        created_at: new Date().toISOString()
      });
    }
  );
});

// PayFast Initiate Payment Route
app.post("/api/payment/initiate", (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { name, email, amount, category } = req.body || {};
    if (!name || !email || !amount) {
      return res.status(400).json({ error: "Missing required fields: name, email, and amount are required" });
    }

    const donationCategory = category || "General Offering";
    const pfMerchantId = process.env.PAYFAST_MERCHANT_ID || "10000100";
    const pfMerchantKey = process.env.PAYFAST_MERCHANT_KEY || "46f0z58xyz58z";
    const pfPassPhrase = process.env.PAYFAST_PASS_PHRASE || "jt77662s45k1";
    const isSandbox = process.env.PAYFAST_SANDBOX !== "false";
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

    const pfHost = isSandbox ? "sandbox.payfast.co.za" : "www.payfast.co.za";
    const gatewayUrl = `https://${pfHost}/eng/process`;

    const db = getDb();
    const dateStr = new Date().toISOString().split('T')[0];

    db.run(
      "INSERT INTO donations (name, email, category, amount, date, status) VALUES (?, ?, ?, ?, ?, ?)",
      [name, email, donationCategory, parseFloat(amount), dateStr, 'Pending'],
      function (err) {
        try {
          if (err) {
            console.error("Database insert error in payment initiate:", err);
            return res.status(500).json({ error: err.message });
          }
          const dbId = this.lastID;
          const mPaymentId = `DON-${dbId}-${Date.now()}`;

          // Update donation record with pf_payment_id
          db.run("UPDATE donations SET pf_payment_id = ? WHERE id = ?", [mPaymentId, dbId], (updErr) => {
            try {
              if (updErr) {
                console.error("Database update error in payment initiate:", updErr);
                return res.status(500).json({ error: updErr.message });
              }

              const payfastData: any = {
                merchant_id: pfMerchantId,
                merchant_key: pfMerchantKey,
                return_url: `${appUrl}/payment-success?id=${mPaymentId}`,
                cancel_url: `${appUrl}/payment-cancel?id=${mPaymentId}`,
                notify_url: `${appUrl}/api/payment/notify`,
                name_first: name.split(" ")[0] || "Donor",
                name_last: name.split(" ").slice(1).join(" ") || "Member",
                email_address: email,
                m_payment_id: mPaymentId,
                amount: parseFloat(amount).toFixed(2),
                item_name: `${donationCategory} Donation`
              };

              // Generate PayFast MD5 signature (alphabetically sorted parameters)
              const sortedKeys = Object.keys(payfastData).sort();
              let pfParamString = "";
              sortedKeys.forEach(key => {
                const val = payfastData[key];
                if (val !== "") {
                  pfParamString += `${key}=${encodeURIComponent(val.toString().trim()).replace(/%20/g, "+")}&`;
                }
              });
              let signatureString = pfParamString.slice(0, -1);
              if (pfPassPhrase) {
                signatureString += `&pass_phrase=${encodeURIComponent(pfPassPhrase.trim()).replace(/%20/g, "+")}`;
              }
              const signature = crypto.createHash("md5").update(signatureString).digest("hex");

              return res.json({
                gatewayUrl,
                fields: {
                  ...payfastData,
                  signature
                }
              });
            } catch (innerUpdErr: any) {
              console.error("Signature calculation inner error:", innerUpdErr);
              return res.status(500).json({ error: innerUpdErr.message || "Failed to compile payment signature" });
            }
          });
        } catch (innerErr: any) {
          console.error("Database run callback inner error:", innerErr);
          return res.status(500).json({ error: innerErr.message || "Failed to save payment info" });
        }
      }
    );
  } catch (outerErr: any) {
    console.error("Payment initiate outer route error:", outerErr);
    return res.status(500).json({ error: outerErr.message || "Server error during payment checkout initiation" });
  }
});

// PayFast ITN Callback Webhook
app.post("/api/payment/notify", (req, res) => {
  const pfData = req.body;
  const pfPassPhrase = process.env.PAYFAST_PASS_PHRASE || "jt77662s45k1";

  // Verify Signature
  const sortedKeys = Object.keys(pfData).filter(key => key !== 'signature').sort();
  let pfParamString = "";
  sortedKeys.forEach(key => {
    const val = pfData[key];
    if (val !== "") {
      pfParamString += `${key}=${encodeURIComponent(val.toString().trim()).replace(/%20/g, "+")}&`;
    }
  });
  let signatureString = pfParamString.slice(0, -1);
  if (pfPassPhrase) {
    signatureString += `&pass_phrase=${encodeURIComponent(pfPassPhrase.trim()).replace(/%20/g, "+")}`;
  }
  const calculatedSignature = crypto.createHash("md5").update(signatureString).digest("hex");

  if (calculatedSignature !== pfData.signature) {
    console.error("PayFast signature validation failed");
    return res.status(400).json({ error: "Signature validation failed" });
  }

  const mPaymentId = pfData.m_payment_id;
  const paymentStatus = pfData.payment_status; // 'COMPLETE'
  const dbStatus = paymentStatus === 'COMPLETE' ? 'Completed' : 'Failed';

  const db = getDb();
  db.run(
    "UPDATE donations SET status = ? WHERE pf_payment_id = ?",
    [dbStatus, mPaymentId],
    function(err) {
      if (err) {
        console.error("Database update error:", err.message);
        return res.status(500).json({ error: "Database error" });
      }
      res.status(200).json({ success: true, message: "Operation successful" });
    }
  );
});

// GET all donations
app.get("/api/donations", (req, res) => {
  const db = getDb();
  db.all("SELECT * FROM donations ORDER BY created_at DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST a donation manually (Admin only)
app.post("/api/donations", requireAdmin, (req, res) => {
  const { name, category, amount, date } = req.body;
  if (!name || !category || !amount) {
    return res.status(400).json({ error: "Missing name, category, or amount" });
  }
  const db = getDb();
  const dateStr = date || new Date().toISOString().split('T')[0];
  db.run(
    "INSERT INTO donations (name, email, category, amount, date, status) VALUES (?, ?, ?, ?, ?, ?)",
    [name, "staff@fathershouse.com", category, parseFloat(amount), dateStr, "Completed"],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, category, amount, date: dateStr, status: "Completed" });
    }
  );
});

// Serve health route
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

async function startServer() {
  // Initialize SQLite database and seed admin user
  try {
    await initDb();
    console.log("Database initialized successfully.");
  } catch (dbErr) {
    console.error("Database initialization failed:", dbErr);
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

