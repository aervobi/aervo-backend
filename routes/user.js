const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("cloudinary").v2;

// ── Cloudinary config ──────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:         "aervo/avatars",
    allowed_formats: ["jpg", "jpeg", "png", "webp", "gif"],
    transformation: [{ width: 400, height: 400, crop: "fill", gravity: "face" }],
    public_id: (req) => `user_${req.user.userId}_${Date.now()}`,
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
});

module.exports = (pool, authenticateToken) => {

  // ── GET /api/user/me ──────────────────────────────────────────
  // Returns full user profile including settings fields
  router.get("/api/user/me", authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, email, company_name, name, role, email_verified,
                avatar_url, business_type, location, google_id,
                CASE WHEN password_hash IS NOT NULL AND password_hash != '' THEN true ELSE false END AS has_password,
                created_at, last_login, onboarded, platform
         FROM users WHERE id = $1`,
        [req.user.userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const user = result.rows[0];

      // Get connected shop
      const storeResult = await pool.query(
        `SELECT id, integration_name, store_name, store_origin, connected_at
         FROM connected_stores
         WHERE user_id = $1 AND is_active = true
         LIMIT 1`,
        [req.user.userId]
      );

      let activeStore = null;
      if (storeResult.rows.length > 0) {
        activeStore = storeResult.rows[0];
      } else {
        const anyStore = await pool.query(
          `SELECT id, integration_name, store_name, store_origin, connected_at
           FROM connected_stores WHERE user_id = $1
           ORDER BY connected_at DESC LIMIT 1`,
          [req.user.userId]
        );
        if (anyStore.rows.length > 0) {
          activeStore = anyStore.rows[0];
          await pool.query(
            `UPDATE connected_stores SET is_active = true WHERE id = $1`,
            [activeStore.id]
          );
        }
      }

      return res.json({
        success: true,
        user: {
          id:            user.id,
          email:         user.email,
          name:          user.name || user.company_name || "",
          companyName:   user.company_name,
          role:          user.role,
          emailVerified: user.email_verified,
          avatarUrl:     user.avatar_url,
          businessType:  user.business_type,
          location:      user.location,
          googleId:      user.google_id,
          hasPassword:   user.has_password,
          onboarded:     user.onboarded,
          platform:      user.platform,
          createdAt:     user.created_at,
          lastLogin:     user.last_login,
        },
        shop: activeStore ? {
          shopOrigin:   activeStore.store_origin,
          installedAt:  activeStore.connected_at,
          storeName:    activeStore.store_name,
          integration:  activeStore.integration_name,
        } : null,
      });
    } catch (err) {
      console.error("Get user error:", err);
      return res.status(500).json({ success: false, message: "Failed to fetch user data" });
    }
  });

  // ── POST /api/user/update ─────────────────────────────────────
  router.post("/api/user/update", authenticateToken, async (req, res) => {
    try {
      const { name, email, business_name, business_type, role, location } = req.body;

      const fields = [];
      const values = [];
      let idx = 1;

      if (name !== undefined) {
        fields.push(`name = $${idx++}`);
        values.push(name.trim());
        // Keep company_name in sync
        fields.push(`company_name = $${idx++}`);
        values.push(name.trim());
      }
      if (email !== undefined) {
        // Check email not taken by someone else
        const existing = await pool.query(
          "SELECT id FROM users WHERE email = $1 AND id != $2",
          [email.toLowerCase(), req.user.userId]
        );
        if (existing.rows.length > 0) {
          return res.status(409).json({ success: false, error: "Email already in use." });
        }
        fields.push(`email = $${idx++}`);
        values.push(email.toLowerCase().trim());
      }
      if (business_name !== undefined) {
        fields.push(`company_name = $${idx++}`);
        values.push(business_name.trim());
      }
      if (business_type !== undefined) {
        fields.push(`business_type = $${idx++}`);
        values.push(business_type);
      }
      if (role !== undefined) {
        fields.push(`role = $${idx++}`);
        values.push(role);
      }
      if (location !== undefined) {
        fields.push(`location = $${idx++}`);
        values.push(location.trim());
      }

      if (fields.length === 0) {
        return res.status(400).json({ success: false, error: "No fields to update." });
      }

      values.push(req.user.userId);
      await pool.query(
        `UPDATE users SET ${fields.join(", ")} WHERE id = $${idx}`,
        values
      );

      return res.json({ success: true, message: "Profile updated." });
    } catch (err) {
      console.error("Update user error:", err);
      return res.status(500).json({ success: false, error: "Failed to update profile." });
    }
  });

  // ── POST /api/user/avatar ─────────────────────────────────────
  router.post("/api/user/avatar", authenticateToken, upload.single("avatar"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: "No file uploaded." });
      }

      const avatarUrl = req.file.path; // Cloudinary URL

      // Delete old avatar from Cloudinary if it exists and isn't a Google avatar
      const oldUser = await pool.query("SELECT avatar_url FROM users WHERE id = $1", [req.user.userId]);
      if (oldUser.rows[0]?.avatar_url && oldUser.rows[0].avatar_url.includes("cloudinary.com/aervo")) {
        const publicId = oldUser.rows[0].avatar_url.split("/").pop().split(".")[0];
        await cloudinary.uploader.destroy(`aervo/avatars/${publicId}`).catch(() => {});
      }

      await pool.query(
        "UPDATE users SET avatar_url = $1 WHERE id = $2",
        [avatarUrl, req.user.userId]
      );

      return res.json({ success: true, avatarUrl });
    } catch (err) {
      console.error("Avatar upload error:", err);
      return res.status(500).json({ success: false, error: "Failed to upload photo." });
    }
  });

  // ── POST /api/user/change-password ───────────────────────────
  router.post("/api/user/change-password", authenticateToken, async (req, res) => {
    try {
      const { current_password, new_password } = req.body;

      if (!new_password || new_password.length < 8) {
        return res.status(400).json({ success: false, error: "Password must be at least 8 characters." });
      }

      const result = await pool.query(
        "SELECT password_hash, google_id FROM users WHERE id = $1",
        [req.user.userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: "User not found." });
      }

      const user = result.rows[0];

      // If they have an existing password, verify current password
      if (user.password_hash) {
        if (!current_password) {
          return res.status(400).json({ success: false, error: "Current password is required." });
        }
        const match = await bcrypt.compare(current_password, user.password_hash);
        if (!match) {
          return res.status(401).json({ success: false, error: "Current password is incorrect." });
        }
      }
      // If Google-only user, they can set a password without providing current

      const hashed = await bcrypt.hash(new_password, 10);
      await pool.query(
        "UPDATE users SET password_hash = $1 WHERE id = $2",
        [hashed, req.user.userId]
      );

      return res.json({ success: true, message: "Password updated successfully." });
    } catch (err) {
      console.error("Change password error:", err);
      return res.status(500).json({ success: false, error: "Failed to update password." });
    }
  });

  // ── DELETE /api/user/delete ───────────────────────────────────
  router.delete("/api/user/delete", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;

      // Delete avatar from Cloudinary if exists
      const userResult = await pool.query("SELECT avatar_url FROM users WHERE id = $1", [userId]);
      if (userResult.rows[0]?.avatar_url?.includes("cloudinary.com/aervo")) {
        const publicId = userResult.rows[0].avatar_url.split("/").pop().split(".")[0];
        await cloudinary.uploader.destroy(`aervo/avatars/${publicId}`).catch(() => {});
      }

      // Delete in order (FK constraints)
      await pool.query("DELETE FROM connected_stores WHERE user_id = $1", [userId]);
      await pool.query("DELETE FROM alert_preferences WHERE user_id = $1", [userId]).catch(() => {});
      await pool.query("DELETE FROM alerts_log WHERE user_id = $1", [userId]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);

      return res.json({ success: true, message: "Account deleted." });
    } catch (err) {
      console.error("Delete user error:", err);
      return res.status(500).json({ success: false, error: "Failed to delete account." });
    }
  });

  return router;
};