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

  return router;
};