// utils/email.js
const sgMail = require("@sendgrid/mail");

let SENDGRID_READY = false;

function initSendgrid() {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn("SENDGRID_API_KEY is missing.");
    SENDGRID_READY = false;
    return;
  }
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  SENDGRID_READY = true;
}

function getFromEmail() {
  return process.env.SENDGRID_FROM_EMAIL;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h\d>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function safeSend({ to, subject, html, text }) {
  const from = getFromEmail();

  if (!SENDGRID_READY) {
    throw new Error(
      "SendGrid is not initialized. Call initSendgrid() at startup."
    );
  }

  if (!from) {
    throw new Error("SENDGRID_FROM_EMAIL is missing.");
  }

  return sgMail.send({
    to,
    from,
    subject,
    html,
    text: text || stripHtml(html),
  });
}

function buildWelcomeEmail({ companyName }) {
  const appUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
  const wordmarkUrl = "https://aervoapp.com/assets/aervo-wordmark.png";
  const year = new Date().getFullYear();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to Aervo</title>
</head>
<body style="margin:0; padding:0; background:#020617; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;">
  <table width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px; background:#020617;">
    <tr>
      <td align="center">
        <table width="600" cellspacing="0" cellpadding="0" style="
          max-width:600px;
          background:#020617;
          border-radius:24px;
          border:1px solid #111827;
          box-shadow:0 30px 80px rgba(15,23,42,0.75);
          overflow:hidden;
        ">
          <tr>
            <td align="center" style="padding:26px 32px 6px; background:#020617;">
              <img src="${wordmarkUrl}" alt="Aervo" width="220"
                style="display:block; margin:0 auto; max-width:220px; height:auto;" />
            </td>
          </tr>

          <tr>
            <td style="padding:10px 32px 18px; background:#020617;" align="left">
              <h1 style="margin:0 0 10px 0;font-size:28px;line-height:1.3;color:#f9fafb;font-weight:650;">
                Welcome aboard, ${companyName || "there"} 👋
              </h1>
              <p style="margin:0;font-size:14px;line-height:1.7;color:#cbd5f5;">
                You just spun up a new command center for your business. Aervo pulls your sales,
                inventory, and customer signals into one clear view so you can see what's working
                and what needs attention in seconds.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:18px 32px 10px 32px;">
              <p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#e5e7eb;">
                Here's what Aervo is built to help you do:
              </p>
              <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:#d1d5db;">
                <li><strong>See today at a glance</strong> – one live dashboard instead of ten tabs.</li>
                <li><strong>Ask natural questions</strong> – "How did we do this week?" or "What changed?"</li>
                <li><strong>Catch slowdowns early</strong> – spot dips in sales or low stock before they hurt you.</li>
              </ul>
            </td>
          </tr>

          <tr>
            <td style="padding:10px 32px 20px 32px;">
              <table width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="33.33%" valign="top" style="padding-right:8px;">
                    <div style="border-radius:16px;background:#050816;border:1px solid #111827;padding:14px 12px;">
                      <div style="font-size:22px; margin-bottom:6px;">📊</div>
                      <div style="font-size:13px;font-weight:600;color:#e5e7eb;margin-bottom:4px;">Live overview</div>
                      <div style="font-size:12px;line-height:1.5;color:#9ca3af;">Sales, inventory, and key metrics in one place.</div>
                    </div>
                  </td>
                  <td width="33.33%" valign="top" style="padding:0 4px;">
                    <div style="border-radius:16px;background:#050816;border:1px solid #111827;padding:14px 12px;">
                      <div style="font-size:22px; margin-bottom:6px;">💬</div>
                      <div style="font-size:13px;font-weight:600;color:#e5e7eb;margin-bottom:4px;">Explain the "why"</div>
                      <div style="font-size:12px;line-height:1.5;color:#9ca3af;">Short explanations, not just charts and numbers.</div>
                    </div>
                  </td>
                  <td width="33.33%" valign="top" style="padding-left:8px;">
                    <div style="border-radius:16px;background:#050816;border:1px solid #111827;padding:14px 12px;">
                      <div style="font-size:22px; margin-bottom:6px;">⚡</div>
                      <div style="font-size:13px;font-weight:600;color:#e5e7eb;margin-bottom:4px;">Next best steps</div>
                      <div style="font-size:12px;line-height:1.5;color:#9ca3af;">Suggestions you can act on today to move the needle.</div>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:4px 32px 26px 32px;" align="left">
              <a href="${appUrl}" style="
                display:inline-block;
                padding:12px 24px;
                border-radius:999px;
                background:linear-gradient(135deg,#4f46e5,#6366f1);
                color:#f9fafb;
                text-decoration:none;
                font-size:14px;
                font-weight:600;
                box-shadow:0 14px 32px rgba(79,70,229,0.5);
              ">Open your Aervo dashboard →</a>
            </td>
          </tr>

          <tr>
            <td style="padding:14px 32px 20px 32px;border-top:1px solid #111827;font-size:11px;color:#6b7280;">
              You're receiving this because an Aervo workspace was created for ${companyName || "your business"}.
              If this wasn't you, reply to this email and we'll take a look.
              <br /><br />© ${year} Aervo. All rights reserved.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

  const text = `Welcome to Aervo, ${companyName || "there"}!

You just spun up a new command center for your business.

Here's what Aervo helps you do:
- See today at a glance (one live dashboard instead of ten tabs)
- Ask natural questions ("How did we do this week?" "What changed?")
- Catch slowdowns early (spot dips in sales or low stock)

Open your Aervo dashboard: ${appUrl}

© ${year} Aervo`;

  return { subject: `Welcome to Aervo, ${companyName || "there"}`, html, text };
}

function buildVerifyEmail({ toEmail, token }) {
  const apiBase = (process.env.API_BASE_URL || "https://aervo-backend.onrender.com").replace(/\/+$/, "");

  const verifyUrl = `${apiBase}/api/verify-email?token=${encodeURIComponent(
    token
  )}&email=${encodeURIComponent(toEmail)}`;

  const year = new Date().getFullYear();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify your email - Aervo</title>
</head>
<body style="margin:0; padding:0; background:#020617; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;">
  <table width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px; background:#020617;">
    <tr>
      <td align="center">
        <table width="600" cellspacing="0" cellpadding="0" style="
          max-width:600px;
          background:#020617;
          border-radius:24px;
          border:1px solid #111827;
          box-shadow:0 30px 80px rgba(15,23,42,0.75);
          overflow:hidden;
        ">
          <tr>
            <td align="center" style="padding:26px 32px 6px; background:#020617;">
              <img src="https://aervoapp.com/assets/aervo-wordmark.png" alt="Aervo" width="220"
                style="display:block; margin:0 auto; max-width:220px; height:auto;" />
            </td>
          </tr>

          <tr>
            <td style="padding:10px 32px 10px; background:#020617;" align="left">
              <h1 style="margin:0 0 10px 0;font-size:28px;line-height:1.3;color:#f9fafb;font-weight:650;">
                Verify your email to activate Aervo ✉️
              </h1>
              <p style="margin:0;font-size:14px;line-height:1.7;color:#cbd5f5;">
                One quick step and your workspace is live.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:4px 32px 18px 32px;" align="left">
              <a href="${verifyUrl}" style="
                display:inline-block;
                padding:12px 24px;
                border-radius:999px;
                background:linear-gradient(135deg,#4f46e5,#6366f1);
                color:#f9fafb;
                text-decoration:none;
                font-size:14px;
                font-weight:600;
                box-shadow:0 14px 32px rgba(79,70,229,0.5);
              ">Verify email →</a>

              <p style="margin:14px 0 0; font-size:12px; line-height:1.6; color:#9ca3af;">
                If the button doesn't work, copy and paste this link into your browser:
                <br />
                <span style="color:#a5b4fc; word-break:break-all;">${verifyUrl}</span>
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:14px 32px 20px 32px;border-top:1px solid #111827;font-size:11px;color:#6b7280;">
              If you didn't create an Aervo account, you can safely ignore this email.
              <br /><br />© ${year} Aervo. All rights reserved.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

  const text = `Verify your email to activate Aervo

Verify link: ${verifyUrl}

If you didn't create an Aervo account, ignore this email.
© ${year} Aervo`;

  return { subject: "Verify your email for Aervo", html, text };
}

function buildPasswordResetEmail({ companyName, token }) {
  const baseUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const resetUrl = `${cleanBase}/reset-password.html?token=${encodeURIComponent(
    token
  )}`;
  const year = new Date().getFullYear();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your Aervo password</title>
</head>
<body style="margin:0; padding:0; background:#050817; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
  <div style="padding:40px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#050818;border-radius:16px;overflow:hidden;color:#e5ecff;border:1px solid rgba(129,140,248,0.3)">
      <tr>
        <td style="padding:28px 40px 18px;background:radial-gradient(circle at top,#1d2a4f,#050818);border-bottom:1px solid rgba(129,140,248,0.3);">
          <table width="100%">
            <tr>
              <td style="vertical-align:middle;">
                <div style="display:flex;align-items:center;gap:10px;">
                  <img src="https://aervoapp.com/logo.png" alt="Aervo" width="40" style="border-radius:999px;box-shadow:0 0 12px rgba(129,140,248,0.7);" />
                  <div>
                    <div style="font-size:13px;letter-spacing:4px;color:#a5b4fc;text-transform:uppercase;">AERVO</div>
                    <div style="font-size:12px;color:#9ca3af;">A higher view of your business</div>
                  </div>
                </div>
              </td>
              <td style="text-align:right;font-size:12px;color:#9ca3af;">
                Password reset request
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <tr>
        <td style="padding:32px 40px;">
          <h1 style="margin:0 0 12px;font-size:22px;color:#e5ecff;font-weight:600;">
            Hi${companyName ? ` from ${companyName}` : ""} 👋
          </h1>
          <p style="margin:0 0 10px;font-size:14px;color:#d1d5db;line-height:1.7;">
            We received a request to reset your Aervo password.
          </p>
          <p style="margin:0 0 20px;font-size:14px;color:#d1d5db;line-height:1.7;">
            If this was you, click below to set a new password:
          </p>

          <a href="${resetUrl}" style="
            display:inline-block;
            padding:12px 26px;
            border-radius:999px;
            background:linear-gradient(135deg,#4f46e5,#6366f1);
            color:#fff;
            text-decoration:none;
            font-size:14px;
            font-weight:600;
            box-shadow:0 12px 30px rgba(79,70,229,0.45);
          ">Reset password</a>

          <p style="margin:18px 0 0;font-size:12px;color:#9ca3af;">
            If you didn't request this, you can safely ignore this message.
          </p>

          <p style="margin:14px 0 0;font-size:12px;color:#9ca3af; line-height:1.6;">
            Or paste this link into your browser:<br />
            <span style="color:#a5b4fc; word-break:break-all;">${resetUrl}</span>
          </p>
        </td>
      </tr>

      <tr>
        <td style="padding:18px 40px 26px;text-align:center;font-size:11px;color:#6b7280;border-top:1px solid rgba(55,65,81,0.8);">
          © ${year} Aervo. All rights reserved.
        </td>
      </tr>
    </table>
  </div>
</body>
</html>
`;

  const text = `Reset your Aervo password

Reset link: ${resetUrl}

If you didn't request this, ignore this email.
© ${year} Aervo`;

  return { subject: "Reset your Aervo password", html, text };
}

async function sendWelcomeEmail({ toEmail, companyName }) {
  const { subject, html, text } = buildWelcomeEmail({ companyName });
  return safeSend({ to: toEmail, subject, html, text });
}

async function sendVerifyEmail({ toEmail, token }) {
  const { subject, html, text } = buildVerifyEmail({ toEmail, token });
  return safeSend({ to: toEmail, subject, html, text });
}

async function sendPasswordResetEmail({ toEmail, companyName, token }) {
  const { subject, html, text } = buildPasswordResetEmail({ companyName, token });
  return safeSend({ to: toEmail, subject, html, text });
}

// ============= SEND ALERT EMAIL (DARK THEME MATCHING WELCOME EMAIL) =============
async function sendAlertEmail(toEmail, companyName, storeName, alerts, dailyData) {
  const appUrl = process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
  const wordmarkUrl = "https://aervoapp.com/assets/aervo-wordmark.png";
  const year = new Date().getFullYear();
  
  const severityConfig = {
    critical: { emoji: '🚨', bg: '#7f1d1d', border: '#ef4444', text: '#fca5a5' },
    warning: { emoji: '⚠️', bg: '#78350f', border: '#f59e0b', text: '#fbbf24' },
    info: { emoji: '✅', bg: '#064e3b', border: '#10b981', text: '#6ee7b7' }
  };
  
  const alertsHtml = alerts.map(alert => {
    const config = severityConfig[alert.severity];
    return `
      <div style="
        background: ${config.bg}; 
        border-left: 3px solid ${config.border}; 
        border-radius: 10px; 
        padding: 14px 16px; 
        margin-bottom: 12px;
      ">
        <div style="font-size: 15px; font-weight: 600; color: #f9fafb; margin-bottom: 5px;">
          ${config.emoji} ${alert.title}
        </div>
        <div style="font-size: 13px; color: ${config.text}; line-height: 1.6;">
          ${alert.message}
        </div>
      </div>
    `;
  }).join('');
  
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Daily Aervo Alert</title>
</head>
<body style="margin:0; padding:0; background:#020617; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;">
  <table width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px; background:#020617;">
    <tr>
      <td align="center">
        <table width="600" cellspacing="0" cellpadding="0" style="
          max-width:600px;
          background:#020617;
          border-radius:24px;
          border:1px solid #111827;
          box-shadow:0 30px 80px rgba(15,23,42,0.75);
          overflow:hidden;
        ">
          <!-- Logo Header -->
          <tr>
            <td align="center" style="padding:26px 32px 6px; background:#020617;">
              <img src="${wordmarkUrl}" alt="Aervo" width="220"
                style="display:block; margin:0 auto; max-width:220px; height:auto;" />
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:10px 32px 18px; background:#020617;" align="left">
              <h1 style="margin:0 0 10px 0;font-size:28px;line-height:1.3;color:#f9fafb;font-weight:650;">
                Good morning, ${companyName} 👋
              </h1>
              <p style="margin:0;font-size:14px;line-height:1.7;color:#cbd5f5;">
                Here's what's happening with <strong style="color:#e5e7eb;">${storeName}</strong> today
              </p>
            </td>
          </tr>

          ${alerts.length > 0 ? `
          <!-- Alerts Section -->
          <tr>
            <td style="padding:8px 32px 18px 32px;">
              <p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#e5e7eb;border-bottom:1px solid #1f2937;padding-bottom:8px;">
                🔔 Today's Alerts
              </p>
              ${alertsHtml}
            </td>
          </tr>
          ` : ''}

          <!-- Today's Performance -->
          <tr>
            <td style="padding:8px 32px 18px 32px;">
              <p style="margin:0 0 14px;font-size:14px;font-weight:600;color:#e5e7eb;border-bottom:1px solid #1f2937;padding-bottom:8px;">
                📊 Today's Performance
              </p>
              
              <!-- Stats Grid -->
              <table width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="50%" valign="top" style="padding-right:6px;">
                    <div style="border-radius:12px;background:#050816;border:1px solid #111827;padding:14px;">
                      <div style="font-size:12px;color:#9ca3af;margin-bottom:6px;">Revenue</div>
                      <div style="font-size:24px;font-weight:700;color:#10b981;">$${dailyData.revenue.toFixed(2)}</div>
                    </div>
                  </td>
                  <td width="50%" valign="top" style="padding-left:6px;">
                    <div style="border-radius:12px;background:#050816;border:1px solid #111827;padding:14px;">
                      <div style="font-size:12px;color:#9ca3af;margin-bottom:6px;">Orders</div>
                      <div style="font-size:24px;font-weight:700;color:#3b82f6;">${dailyData.ordersCount}</div>
                    </div>
                  </td>
                </tr>
                <tr><td colspan="2" style="height:8px;"></td></tr>
                <tr>
                  <td width="50%" valign="top" style="padding-right:6px;">
                    <div style="border-radius:12px;background:#050816;border:1px solid #111827;padding:14px;">
                      <div style="font-size:12px;color:#9ca3af;margin-bottom:6px;">Avg Order Value</div>
                      <div style="font-size:20px;font-weight:600;color:#e5e7eb;">$${dailyData.avgOrderValue.toFixed(2)}</div>
                    </div>
                  </td>
                  <td width="50%" valign="top" style="padding-left:6px;">
                    <div style="border-radius:12px;background:#050816;border:1px solid #111827;padding:14px;">
                      <div style="font-size:12px;color:#9ca3af;margin-bottom:6px;">New Customers</div>
                      <div style="font-size:20px;font-weight:600;color:#e5e7eb;">${dailyData.newCustomers}</div>
                    </div>
                  </td>
                </tr>
              </table>
              
              ${dailyData.topProductName ? `
              <!-- Top Product -->
              <div style="margin-top:12px;border-radius:12px;background:#78350f;border:1px solid #92400e;padding:14px;">
                <div style="font-size:12px;color:#fbbf24;margin-bottom:5px;">🏆 Top Product Today</div>
                <div style="font-size:15px;font-weight:600;color:#fef3c7;">${dailyData.topProductName}</div>
                <div style="font-size:13px;color:#fcd34d;margin-top:4px;">$${dailyData.topProductRevenue.toFixed(2)} in revenue</div>
              </div>
              ` : ''}
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="padding:4px 32px 26px 32px;" align="left">
              <a href="${appUrl}/dashboard.html" style="
                display:inline-block;
                padding:12px 24px;
                border-radius:999px;
                background:linear-gradient(135deg,#4f46e5,#6366f1);
                color:#f9fafb;
                text-decoration:none;
                font-size:14px;
                font-weight:600;
                box-shadow:0 14px 32px rgba(79,70,229,0.5);
              ">Open your Aervo dashboard →</a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:14px 32px 20px 32px;border-top:1px solid #111827;font-size:11px;color:#6b7280;">
              You're receiving this because you enabled daily alerts in Aervo for ${companyName}.
              <br /><br />© ${year} Aervo. All rights reserved.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

  const text = `Daily Aervo Alert - ${companyName}

${alerts.length > 0 ? `
TODAY'S ALERTS:
${alerts.map(a => `${a.title}\n${a.message}`).join('\n\n')}
` : ''}

TODAY'S PERFORMANCE:
Revenue: $${dailyData.revenue.toFixed(2)}
Orders: ${dailyData.ordersCount}
Avg Order Value: $${dailyData.avgOrderValue.toFixed(2)}
New Customers: ${dailyData.newCustomers}
${dailyData.topProductName ? `\nTop Product: ${dailyData.topProductName} ($${dailyData.topProductRevenue.toFixed(2)})` : ''}

View dashboard: ${appUrl}/dashboard.html

© ${year} Aervo`;

  return safeSend({
    to: toEmail,
    subject: `${alerts.length > 0 ? `🔔 ${alerts.length} Alert${alerts.length > 1 ? 's' : ''}` : '📊 Daily Digest'} - ${storeName}`,
    html,
    text
  });
}

module.exports = {
  initSendgrid,
  sendWelcomeEmail,
  sendVerifyEmail,
  sendPasswordResetEmail,
  sendAlertEmail,
};