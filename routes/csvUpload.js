const express = require("express");
const router = express.Router();
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const XLSX = require("xlsx");
const Anthropic = require("@anthropic-ai/sdk");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ["text/csv", "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/plain"];
    if (allowed.includes(file.mimetype) ||
        file.originalname.endsWith(".csv") ||
        file.originalname.endsWith(".xlsx") ||
        file.originalname.endsWith(".xls")) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV and Excel files are allowed"));
    }
  }
});

module.exports = (pool, authenticateToken) => {

  // ── GET /api/reports/csv-usage ────────────────────────────────
  router.get("/api/reports/csv-usage", authenticateToken, async (req, res) => {
    try {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const result = await pool.query(
        `SELECT COUNT(*) as count FROM csv_uploads 
         WHERE user_id = $1 AND created_at >= $2`,
        [req.user.userId, startOfMonth.toISOString()]
      );

      const used = parseInt(result.rows[0].count);
      
      // Check if pro user (you can expand this later with Stripe)
      const userResult = await pool.query(
        `SELECT plan FROM users WHERE id = $1`,
        [req.user.userId]
      );
      const plan = userResult.rows[0]?.plan || "free";
      const limit = plan === "pro" ? 10 : 1;

      return res.json({ success: true, used, limit, plan });
    } catch (err) {
      console.error("CSV usage error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── GET /api/reports/csv-history ──────────────────────────────
  router.get("/api/reports/csv-history", authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, filename, row_count, detected_columns, ai_insights, created_at
         FROM csv_uploads WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [req.user.userId]
      );
      return res.json({ success: true, uploads: result.rows });
    } catch (err) {
      console.error("CSV history error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── GET /api/reports/csv/:id ──────────────────────────────────
  router.get("/api/reports/csv/:id", authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM csv_uploads WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Upload not found" });
      }
      return res.json({ success: true, upload: result.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── POST /api/reports/upload-csv ──────────────────────────────
  router.post("/api/reports/upload-csv", authenticateToken, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded" });
      }

      // Check usage limit
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const usageResult = await pool.query(
        `SELECT COUNT(*) as count FROM csv_uploads 
         WHERE user_id = $1 AND created_at >= $2`,
        [req.user.userId, startOfMonth.toISOString()]
      );

      const used = parseInt(usageResult.rows[0].count);
      const userResult = await pool.query(
        `SELECT plan FROM users WHERE id = $1`,
        [req.user.userId]
      );
      const plan = userResult.rows[0]?.plan || "free";
      const limit = plan === "pro" ? 10 : 1;

      if (used >= limit) {
        return res.status(403).json({
          success: false,
          message: `You've used all ${limit} upload${limit > 1 ? 's' : ''} for this month.`,
          upgradeRequired: plan === "free"
        });
      }

      // Parse file
      let rows = [];
      const filename = req.file.originalname;

      if (filename.endsWith(".xlsx") || filename.endsWith(".xls")) {
        const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      } else {
        // CSV
        const content = req.file.buffer.toString("utf-8");
        rows = parse(content, {
          columns: true,
          skip_empty_lines: true,
          trim: true
        });
      }

      if (rows.length === 0) {
        return res.status(400).json({ success: false, message: "File appears to be empty" });
      }

      const headers = Object.keys(rows[0]);
      const sampleRows = rows.slice(0, 5);

      // Use Claude to analyze the CSV structure and generate insights
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const analysisPrompt = `You are analyzing a business data CSV file. Here are the column headers: ${JSON.stringify(headers)}

Here are the first 5 rows of data: ${JSON.stringify(sampleRows)}

Total rows: ${rows.length}

Please respond with ONLY a JSON object (no markdown, no explanation) in this exact format:
{
  "detectedType": "sales|inventory|customers|appointments|payroll|other",
  "columns": {
    "date": "column name or null",
    "revenue": "column name or null", 
    "orders": "column name or null",
    "quantity": "column name or null",
    "customer": "column name or null",
    "product": "column name or null",
    "status": "column name or null"
  },
  "summary": "2-3 sentence description of what this data contains",
  "insights": "4-5 sentence business insight paragraph based on the data patterns you can see. Be specific and actionable.",
  "metrics": [
    {"label": "metric name", "value": "computed value", "color": "green|blue|purple|cyan|red|yellow"}
  ]
}

Compute the metrics from the actual data. For example if there's a revenue column, sum it up. If there's a date column, find the date range. Include 4 metrics maximum.`;

      let analysisResult = null;
      try {
        const aiResponse = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1000,
          messages: [{ role: "user", content: analysisPrompt }]
        });

        const rawText = aiResponse.content[0]?.text || "{}";
        const cleanJson = rawText.replace(/```json|```/g, "").trim();
        analysisResult = JSON.parse(cleanJson);
      } catch (aiErr) {
        console.error("AI analysis error:", aiErr);
        analysisResult = {
          detectedType: "other",
          columns: {},
          summary: "Data uploaded successfully.",
          insights: "Your data has been uploaded. We detected " + rows.length + " rows across " + headers.length + " columns.",
          metrics: [
            { label: "Total Rows", value: rows.length, color: "blue" },
            { label: "Columns", value: headers.length, color: "purple" }
          ]
        };
      }

      // Build table data (first 100 rows)
      const tableRows = rows.slice(0, 100).map(row => headers.map(h => row[h] ?? ""));

      const reportData = {
        headers,
        tableRows,
        totalRows: rows.length,
        metrics: analysisResult.metrics || [],
        summary: analysisResult.summary,
        detectedType: analysisResult.detectedType,
        detectedColumns: analysisResult.columns
      };

      // Save to DB
      const saved = await pool.query(
        `INSERT INTO csv_uploads (user_id, filename, row_count, detected_columns, report_data, ai_insights)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          req.user.userId,
          filename,
          rows.length,
          JSON.stringify(analysisResult.columns),
          JSON.stringify(reportData),
          analysisResult.insights
        ]
      );

      return res.json({
        success: true,
        uploadId: saved.rows[0].id,
        report: reportData,
        aiInsights: analysisResult.insights,
        used: used + 1,
        limit
      });

    } catch (err) {
      console.error("CSV upload error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });
  // ── POST /api/reports/csv/:id/ask ────────────────────────────
  router.post("/api/reports/csv/:id/ask", authenticateToken, async (req, res) => {
    try {
      const { question } = req.body;
      const uploadId = req.params.id;

      if (!question || question.trim().length === 0) {
        return res.status(400).json({ success: false, message: "Question is required" });
      }

      // Verify upload belongs to user
      const uploadResult = await pool.query(
        `SELECT * FROM csv_uploads WHERE id = $1 AND user_id = $2`,
        [uploadId, req.user.userId]
      );

      if (uploadResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Upload not found" });
      }

      const upload = uploadResult.rows[0];

      // Check question limit (10 per upload)
      const questionCount = await pool.query(
        `SELECT COUNT(*) as count FROM csv_questions 
         WHERE upload_id = $1 AND user_id = $2`,
        [uploadId, req.user.userId]
      );

      const used = parseInt(questionCount.rows[0].count);
      const limit = 10;

      if (used >= limit) {
        return res.status(403).json({
          success: false,
          message: `You've reached the ${limit} question limit for this upload.`,
          limitReached: true
        });
      }

      // Get previous questions for context
      const prevQuestions = await pool.query(
        `SELECT question, answer FROM csv_questions 
         WHERE upload_id = $1 AND user_id = $2
         ORDER BY created_at ASC`,
        [uploadId, req.user.userId]
      );

      // Build conversation history
      const messages = [];

      // Add previous Q&A as conversation history
      prevQuestions.rows.forEach(q => {
        messages.push({ role: "user", content: q.question });
        messages.push({ role: "assistant", content: q.answer });
      });

      // Add current question
      messages.push({ role: "user", content: question });

      // Get report data for context
      const reportData = upload.report_data;
      const tablePreview = reportData.tableRows ? 
        reportData.headers.join(", ") + "\n" + 
        reportData.tableRows.slice(0, 50).map(r => r.join(", ")).join("\n") 
        : "";

      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: `You are Aervo, an expert business analyst. The user has uploaded a CSV file called "${upload.filename}" with ${upload.row_count} rows of data.

Here is the data context:
${tablePreview}

AI Summary previously generated: ${upload.ai_insights}

Answer the user's questions about this specific data. Be specific, reference actual numbers from the data, and be conversational. Keep answers concise — 2-4 sentences max unless a longer answer is truly needed. Never make up data that isn't in the file.`,
        messages
      });

      const answer = response.content[0]?.text || "I couldn't generate an answer. Please try again.";

      // Save question and answer
      await pool.query(
        `INSERT INTO csv_questions (user_id, upload_id, question, answer)
         VALUES ($1, $2, $3, $4)`,
        [req.user.userId, uploadId, question.trim(), answer]
      );

      return res.json({
        success: true,
        answer,
        used: used + 1,
        limit
      });

    } catch (err) {
      console.error("CSV question error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── GET /api/reports/csv/:id/questions ───────────────────────
  router.get("/api/reports/csv/:id/questions", authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT question, answer, created_at FROM csv_questions
         WHERE upload_id = $1 AND user_id = $2
         ORDER BY created_at ASC`,
        [req.params.id, req.user.userId]
      );

      const countResult = await pool.query(
        `SELECT COUNT(*) as count FROM csv_questions
         WHERE upload_id = $1 AND user_id = $2`,
        [req.params.id, req.user.userId]
      );

      return res.json({
        success: true,
        questions: result.rows,
        used: parseInt(countResult.rows[0].count),
        limit: 10
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });
// ─────────────────────────────────────────────────────────────────────────────
// ADD THESE 3 ROUTES TO csvUpload.js
// Paste them just before the final:  return router;
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/csv/latest ───────────────────────────────────────────────────────
// Returns the most recent upload's dashboard summary (called on CSV dashboard load)
router.get("/api/csv/latest", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, filename, row_count, detected_columns, report_data, ai_insights, created_at
       FROM csv_uploads WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, summary: null, uploadId: null });
    }

    const upload = result.rows[0];
    const reportData = upload.report_data || {};
    const summary = buildDashboardSummary(reportData, upload);

    return res.json({ success: true, summary, uploadId: upload.id });
  } catch (err) {
    console.error("CSV latest error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/csv/upload ──────────────────────────────────────────────────────
// Dashboard-facing upload endpoint — same processing as /api/reports/upload-csv
// but returns a summary object shaped for the CSV dashboard
router.post("/api/csv/upload", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    // Check usage limit
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const usageResult = await pool.query(
      `SELECT COUNT(*) as count FROM csv_uploads WHERE user_id = $1 AND created_at >= $2`,
      [req.user.userId, startOfMonth.toISOString()]
    );
    const used = parseInt(usageResult.rows[0].count);
    const userResult = await pool.query(`SELECT plan FROM users WHERE id = $1`, [req.user.userId]);
    const plan = userResult.rows[0]?.plan || "free";
    const limit = plan === "pro" ? 10 : 3; // CSV-only users get 3/month

    if (used >= limit) {
      return res.status(403).json({
        success: false,
        message: `You've used all ${limit} uploads for this month.`,
        upgradeRequired: plan === "free"
      });
    }

    // Parse file
    let rows = [];
    const filename = req.file.originalname;

    if (filename.endsWith(".xlsx") || filename.endsWith(".xls")) {
      const XLSX = require("xlsx");
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    } else {
      const { parse } = require("csv-parse/sync");
      const content = req.file.buffer.toString("utf-8");
      rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    }

    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: "File appears to be empty" });
    }

    const headers = Object.keys(rows[0]);
    const sampleRows = rows.slice(0, 5);

    // AI analysis to detect column mapping and generate insights
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const analysisPrompt = `You are analyzing a business sales/orders CSV file. Headers: ${JSON.stringify(headers)}
First 5 rows: ${JSON.stringify(sampleRows)}
Total rows: ${rows.length}

Respond ONLY with a JSON object, no markdown:
{
  "detectedType": "sales|inventory|customers|appointments|other",
  "columns": {
    "date": "exact column name or null",
    "revenue": "exact column name or null",
    "orders": "exact column name or null",
    "quantity": "exact column name or null",
    "customer": "exact column name or null",
    "product": "exact column name or null",
    "status": "exact column name or null"
  },
  "summary": "2-3 sentence description of this data",
  "insights": "4-5 sentence actionable business insight based on visible data patterns"
}`;

    let analysisResult = null;
    try {
      const aiResponse = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{ role: "user", content: analysisPrompt }]
      });
      const raw = aiResponse.content[0]?.text || "{}";
      analysisResult = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch (e) {
      analysisResult = { detectedType: "other", columns: {}, summary: "Data uploaded.", insights: "Your data has been processed." };
    }

    const colMap = analysisResult.columns || {};

    // ── Compute dashboard metrics from the raw rows ──────────────────────────
    let totalRevenue = 0;
    let totalOrders = rows.length;
    const customerSet = new Set();
    const productSales = {};
    const dailyMap = {};

    rows.forEach(row => {
      // Revenue
      const revCol = colMap.revenue;
      if (revCol && row[revCol]) {
        const val = parseFloat(String(row[revCol]).replace(/[$,]/g, ""));
        if (!isNaN(val)) totalRevenue += val;
      }

      // Unique customers
      const custCol = colMap.customer;
      if (custCol && row[custCol]) customerSet.add(String(row[custCol]).trim());

      // Top products
      const prodCol = colMap.product;
      const qtyCol = colMap.quantity;
      if (prodCol && row[prodCol]) {
        const name = String(row[prodCol]).trim();
        if (!productSales[name]) productSales[name] = { name, revenue: 0, units: 0 };
        const revVal = revCol ? parseFloat(String(row[revCol]).replace(/[$,]/g, "")) || 0 : 0;
        const qtyVal = qtyCol ? parseInt(row[qtyCol]) || 1 : 1;
        productSales[name].revenue += revVal;
        productSales[name].units += qtyVal;
      }

      // Revenue by date
      const dateCol = colMap.date;
      if (dateCol && row[dateCol]) {
        const raw = String(row[dateCol]).trim();
        // Try to parse to YYYY-MM-DD
        const d = new Date(raw);
        if (!isNaN(d.getTime())) {
          const key = d.toISOString().split("T")[0];
          if (!dailyMap[key]) dailyMap[key] = { date: key, revenue: 0, orders: 0 };
          const revVal = revCol ? parseFloat(String(row[revCol]).replace(/[$,]/g, "")) || 0 : 0;
          dailyMap[key].revenue += revVal;
          dailyMap[key].orders += 1;
        }
      }
    });

    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const topProducts = Object.values(productSales)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const revenueByDate = Object.values(dailyMap)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map(d => ({
        date: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        revenue: parseFloat(d.revenue.toFixed(2)),
        orders: d.orders
      }));

    const summary = {
      totalRevenue,
      totalOrders,
      avgOrderValue,
      uniqueCustomers: customerSet.size || null,
      topProducts,
      revenueByDate,
      detectedType: analysisResult.detectedType,
      insights: analysisResult.insights
    };

    // Save to DB
    const reportData = {
      headers,
      tableRows: rows.slice(0, 100).map(r => headers.map(h => r[h] ?? "")),
      totalRows: rows.length,
      metrics: [
        { label: "Total Revenue", value: `$${totalRevenue.toFixed(2)}`, color: "cyan" },
        { label: "Total Orders", value: totalOrders, color: "blue" },
        { label: "Avg Order Value", value: `$${avgOrderValue.toFixed(2)}`, color: "purple" },
        { label: "Unique Customers", value: customerSet.size || rows.length, color: "green" }
      ],
      summary: analysisResult.summary,
      detectedType: analysisResult.detectedType,
      detectedColumns: colMap,
      dashboardSummary: summary  // Store the computed summary for /api/csv/latest
    };

    const saved = await pool.query(
      `INSERT INTO csv_uploads (user_id, filename, row_count, detected_columns, report_data, ai_insights)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.user.userId, filename, rows.length, JSON.stringify(colMap), JSON.stringify(reportData), analysisResult.insights]
    );

    return res.json({
      success: true,
      uploadId: saved.rows[0].id,
      summary,
      aiInsights: analysisResult.insights,
      used: used + 1,
      limit
    });

  } catch (err) {
    console.error("CSV dashboard upload error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/csv/chat ────────────────────────────────────────────────────────
// AI chat for the CSV dashboard — aware of the uploaded data + user's goals
router.post("/api/csv/chat", authenticateToken, async (req, res) => {
  try {
    const { message, uploadId } = req.body;
    if (!message) return res.status(400).json({ success: false, message: "Message required" });

    // Get upload data
    let uploadContext = "";
    if (uploadId) {
      const uploadResult = await pool.query(
        `SELECT * FROM csv_uploads WHERE id = $1 AND user_id = $2`,
        [uploadId, req.user.userId]
      );
      if (uploadResult.rows.length > 0) {
        const upload = uploadResult.rows[0];
        const rd = upload.report_data || {};
        const ds = rd.dashboardSummary || {};
        uploadContext = `
FILE: ${upload.filename} (${upload.row_count} rows)
TOTAL REVENUE: $${(ds.totalRevenue || 0).toFixed(2)}
TOTAL ORDERS: ${ds.totalOrders || 0}
AVG ORDER VALUE: $${(ds.avgOrderValue || 0).toFixed(2)}
UNIQUE CUSTOMERS: ${ds.uniqueCustomers || "unknown"}
TOP PRODUCTS: ${(ds.topProducts || []).slice(0, 5).map(p => `${p.name} ($${p.revenue.toFixed(2)})`).join(", ")}
AI INSIGHTS: ${upload.ai_insights || ""}
DATA PREVIEW: ${(rd.headers || []).join(", ")}
${(rd.tableRows || []).slice(0, 20).map(r => r.join(", ")).join("\n")}`.trim();
      }
    }

    // Get user's goals for context
    let goalsContext = "";
    try {
      const goalsResult = await pool.query(
        `SELECT name, target_value, current_value, metric_type FROM goals WHERE user_id = $1`,
        [req.user.userId]
      );
      if (goalsResult.rows.length > 0) {
        goalsContext = "\nUSER GOALS:\n" + goalsResult.rows.map(g =>
          `- ${g.name}: ${g.current_value} / ${g.target_value} (${g.metric_type})`
        ).join("\n");
      }
    } catch (e) {}

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: `You are Aervo, an expert AI business analyst. The user has uploaded their sales data as a CSV.
Answer questions about their business using the data below. Be specific, reference real numbers, and give actionable advice.
Keep responses concise — 2-4 sentences unless more detail is genuinely needed.

${uploadContext}
${goalsContext}`,
      messages: [{ role: "user", content: message }]
    });

    // Save question for history
    if (uploadId) {
      await pool.query(
        `INSERT INTO csv_questions (user_id, upload_id, question, answer) VALUES ($1, $2, $3, $4)`,
        [req.user.userId, uploadId, message.trim(), response.content[0]?.text || ""]
      ).catch(() => {});
    }

    return res.json({
      success: true,
      reply: response.content[0]?.text || "Sorry, I couldn't generate a response."
    });

  } catch (err) {
    console.error("CSV chat error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── Helper: build dashboard summary from stored report_data ──────────────────
function buildDashboardSummary(reportData, upload) {
  // If we stored a dashboardSummary directly, use it
  if (reportData.dashboardSummary) return reportData.dashboardSummary;

  // Otherwise reconstruct basic summary from whatever is stored
  const metrics = reportData.metrics || [];
  const revenueMetric = metrics.find(m => m.label?.toLowerCase().includes("revenue"));
  const ordersMetric = metrics.find(m => m.label?.toLowerCase().includes("order"));

  return {
    totalRevenue: revenueMetric ? parseFloat(String(revenueMetric.value).replace(/[$,]/g, "")) || 0 : 0,
    totalOrders: ordersMetric ? parseInt(ordersMetric.value) || 0 : upload.row_count || 0,
    avgOrderValue: 0,
    uniqueCustomers: null,
    topProducts: [],
    revenueByDate: [],
    detectedType: reportData.detectedType || "other",
    insights: upload.ai_insights || ""
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// END OF PATCH — paste the above before:  return router;
// ─────────────────────────────────────────────────────────────────────────────
// ── GET /api/csv/uploads ─────────────────────────────────────────
// Returns all uploads for the user (for history sidebar)
router.get("/api/csv/uploads", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, filename, row_count, created_at,
              report_data->>'period_label' as period_label
       FROM csv_uploads 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 24`,
      [req.user.userId]
    );
    return res.json({ success: true, uploads: result.rows });
  } catch (err) {
    console.error("CSV uploads list error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});  

// ── GET /api/csv/upload/:id ──────────────────────────────────────
// Returns a specific upload's dashboard summary
router.get("/api/csv/upload/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM csv_uploads WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Upload not found" });
    }
    const upload = result.rows[0];
    const reportData = upload.report_data || {};
    const summary = reportData.dashboardSummary || buildDashboardSummary(reportData, upload);
    return res.json({ success: true, summary, uploadId: upload.id });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/csv/narrative/:id ────────────────────────────────────
router.get("/api/csv/narrative/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM csv_uploads WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Upload not found" });
    }
    const upload = result.rows[0];
    const rd = upload.report_data || {};
    const summary = rd.dashboardSummary || {};

    return res.json({
      success: true,
      narrative: upload.ai_insights || null,
      anomalies: [],
      projection: null
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

  return router;
};
