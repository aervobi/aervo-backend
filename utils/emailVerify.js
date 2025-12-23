app.get("/api/verify-email", async (req, res) => {
  try {
    const { token, email } = req.query;

    if (!token || !email) {
      return res.status(400).send("Invalid verification link.");
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const result = await pool.query(
      `
      SELECT id, email_verified, verify_expires_at, company_name
      FROM users
      WHERE email = $1
        AND verify_token_hash = $2
      `,
      [email.toLowerCase(), tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).send("Invalid or expired verification link.");
    }

    const user = result.rows[0];

    if (user.email_verified) {
      return res.redirect("https://aervoapp.com/login.html?verified=1");
    }

    if (user.verify_expires_at && new Date(user.verify_expires_at) < new Date()) {
      return res.status(400).send("Verification link expired.");
    }

    await pool.query(
      `
      UPDATE users
      SET email_verified = TRUE,
          verify_token_hash = NULL,
          verify_expires_at = NULL
      WHERE id = $1
      `,
      [user.id]
    );

    // ✅ Send welcome email AFTER verification
    sendWelcomeEmail({
      toEmail: email.toLowerCase(),
      companyName: user.company_name,
    }).catch((err) => console.error("Welcome email failed:", err));

    return res.redirect("https://aervoapp.com/login.html?verified=1");
  } catch (err) {
    console.error("Verify email error:", err);
    return res.status(500).send("Verification failed.");
  }
});