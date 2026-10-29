// Teams: the people who share a Pro or Business account (the base for team messaging).
//
//  - A team belongs to one owner (the paying account). Everyone on it, the owner
//    included, has a row in team_members with a role:
//      owner       one per team; renames/deletes the team, invites anyone, changes roles
//      supervisor  invites and removes members
//      member      can see the team and leave it
//  - A person is on at most one team (team_members.user_id is unique).
//  - Seats come from the OWNER's plan (config/plans.js teamSeats). Members plus
//    pending invites count, so you can't send more invites than you have seats.
//    A downgraded owner keeps their team but can't invite anyone new.
//  - Company accounts: an account made on the join page (users.managed_by_team)
//    belongs to the business. Its owner can't leave the team or delete the
//    account; the owner or a supervisor removes them, and removing them deletes
//    the account (it has nothing of its own). People who already had an Aervo
//    account when they joined keep it: they can leave, and removal only takes
//    them off the team.
//  - Invites are emailed links (/team/join#t=TOKEN; the token sits in the hash so
//    it never reaches a server log or Referer). Only a SHA-256 of the token is
//    stored. A link works once, for 7 days, and only for the invited email address:
//    either an existing account signed in with that email, or a new account made
//    on the join page (holding the link proves the inbox, so that account starts
//    verified and skips merchant onboarding).
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const PLANS = require("../config/plans");
const { planFor, effectivePlan } = require("../utils/planAccess");
const { startSession, revokeSessions } = require("../middleware/auth");

const ROLES = ["owner", "supervisor", "member"];
const INVITE_DAYS = 7;
const MAX_SENDS_PER_DAY = 30; // invite emails per team per 24h (stops the invite form being a spam relay)
const FRONTEND = () => process.env.FRONTEND_BASE_URL || "https://aervoapp.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sends = new Map(); // teamId -> [timestamps] (in memory is fine: it only rate-limits)

const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");
const joinUrl = (token) => `${FRONTEND()}/team/join#t=${token}`;
const seatLimit = (plan) => (PLANS[plan] || PLANS.free).teamSeats || 0;
const cleanName = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

// What each role may do. Used by the routes and sent to the page so it only
// shows buttons that will work.
function permissionsFor(role) {
  return {
    rename: role === "owner",
    deleteTeam: role === "owner",
    changeRoles: role === "owner",
    inviteRoles: role === "owner" ? ["supervisor", "member"] : role === "supervisor" ? ["member"] : [],
    removeRoles: role === "owner" ? ["supervisor", "member"] : role === "supervisor" ? ["member"] : [],
    viewInvites: role === "owner" || role === "supervisor",
  };
}

function underSendLimit(teamId) {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = (sends.get(teamId) || []).filter((t) => t > dayAgo);
  sends.set(teamId, recent);
  return recent.length < MAX_SENDS_PER_DAY;
}
const noteSend = (teamId) => sends.set(teamId, [...(sends.get(teamId) || []), Date.now()]);

async function ensureTeamTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id            SERIAL PRIMARY KEY,
      owner_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('owner', 'supervisor', 'member')),
      invited_by INTEGER,
      joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, user_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_invites (
      id           SERIAL PRIMARY KEY,
      team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      email        TEXT NOT NULL,
      role         TEXT NOT NULL CHECK (role IN ('supervisor', 'member')),
      token_hash   TEXT NOT NULL UNIQUE,
      invited_by   INTEGER,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ NOT NULL,
      accepted_at  TIMESTAMPTZ,
      accepted_by  INTEGER,
      revoked_at   TIMESTAMPTZ
    )`);
  // Accounts the business created through an invite (see the header)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS managed_by_team INTEGER`);
  // Accounts made on the join page before the column existed: they were created
  // with role 'Team member' and have no store of their own
  await pool.query(`
    UPDATE users u SET managed_by_team = tm.team_id
      FROM team_members tm
     WHERE tm.user_id = u.id AND tm.role <> 'owner' AND u.managed_by_team IS NULL
       AND u.role = 'Team member' AND u.platform IS NULL`);
  // one open invite per address per team
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS team_invites_open_email
      ON team_invites (team_id, lower(email))
      WHERE accepted_at IS NULL AND revoked_at IS NULL`);
}

// The caller's membership (or null), joined with the team and the owner's plan.
async function membershipOf(db, userId, { lock = false } = {}) {
  const r = await db.query(
    `SELECT tm.team_id, tm.role, t.name, t.owner_user_id, t.created_at, to_jsonb(o) AS owner_row
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN users o ON o.id = t.owner_user_id
      WHERE tm.user_id = $1
      ${lock ? "FOR UPDATE OF t" : ""}`,
    [userId]
  );
  const m = r.rows[0];
  if (!m) return null;
  m.owner_plan = effectivePlan(m.owner_row).plan; // an owner on trial counts as Pro
  m.store = storeOf(m.owner_row, m.name);
  delete m.owner_row;
  return m;
}

// The business the team works for, from the owner's account (shown to staff so
// they can see whose store they're connected to)
function storeOf(owner, teamName) {
  const o = owner || {};
  const logo = typeof o.company_logo_url === "string" && /^https:\/\//.test(o.company_logo_url) ? o.company_logo_url : null;
  return {
    name: o.company_name || teamName,
    logoUrl: logo,
    location: o.location || null,
    businessType: o.business_type || null,
    ownerName: o.name || o.company_name || null,
  };
}

// Members plus open (not expired) invites
async function seatsUsed(db, teamId) {
  const r = await db.query(
    `SELECT (SELECT COUNT(*) FROM team_members WHERE team_id = $1)
          + (SELECT COUNT(*) FROM team_invites
              WHERE team_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()) AS used`,
    [teamId]
  );
  return Number(r.rows[0].used);
}

// For /api/user/me: { id, name, role, store, managed } or null. Never throws.
async function teamSummaryFor(pool, userId) {
  try {
    const m = await membershipOf(pool, userId);
    if (!m) return null;
    // managed = a company account: it can't leave the team or delete itself
    return { id: m.team_id, name: m.name, role: m.role, store: m.store, managed: await isManaged(pool, userId) };
  } catch {
    return null;
  }
}

// When the caller joined and who invited them (for the staff home page)
async function joinInfo(db, teamId, userId) {
  const r = await db.query(
    `SELECT tm.joined_at, COALESCE(NULLIF(u.name, ''), u.company_name) AS invited_by_name
       FROM team_members tm LEFT JOIN users u ON u.id = tm.invited_by
      WHERE tm.team_id = $1 AND tm.user_id = $2`,
    [teamId, userId]
  );
  const row = r.rows[0] || {};
  return { joinedAt: row.joined_at || null, invitedBy: row.invited_by_name || null };
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Deletes an account the business created (no stores of its own). Runs outside
// a transaction because the optional tables may not exist.
async function deleteManagedAccount(db, userId, teamId) {
  const r = await db.query(`SELECT 1 FROM users WHERE id = $1 AND managed_by_team = $2`, [userId, teamId]);
  if (!r.rows.length) return false;
  await db.query("DELETE FROM connected_stores WHERE user_id = $1", [userId]).catch(() => {});
  await db.query("DELETE FROM alert_preferences WHERE user_id = $1", [userId]).catch(() => {});
  await db.query("DELETE FROM alerts_log WHERE user_id = $1", [userId]).catch(() => {});
  await db.query("DELETE FROM users WHERE id = $1 AND managed_by_team = $2", [userId, teamId]);
  return true;
}

const isManaged = async (db, userId) =>
  !!(await db.query(`SELECT managed_by_team FROM users WHERE id = $1`, [userId])).rows[0]?.managed_by_team;

// Thrown inside handlers to send a specific status + message
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function fail(res, err, label) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ success: false, message: err.message, ...(err.extra || {}) });
  }
  console.error(`${label} error:`, err);
  return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
}

// Looks up an invite by its raw token and says whether it can still be used
async function findInvite(db, token, { lock = false } = {}) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const r = await db.query(
    `SELECT i.*, t.name AS team_name, t.owner_user_id,
            COALESCE(NULLIF(u.name, ''), u.company_name, 'A teammate') AS inviter_name
       FROM team_invites i
       JOIN teams t ON t.id = i.team_id
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1
      ${lock ? "FOR UPDATE OF i" : ""}`,
    [hashToken(token)]
  );
  const inv = r.rows[0];
  if (!inv) return null;
  inv.status = inv.accepted_at
    ? "used"
    : inv.revoked_at
    ? "revoked"
    : new Date(inv.expires_at) <= new Date()
    ? "expired"
    : "pending";
  return inv;
}

const STATUS_MESSAGES = {
  used: "This invite has already been used.",
  revoked: "This invite was cancelled. Ask your team for a new one.",
  expired: "This invite has expired. Ask your team to send a new one.",
};

// Adds `userId` to the invite's team (inside a transaction, invite row locked)
async function joinFromInvite(client, inv, userId) {
  const existing = await membershipOf(client, userId);
  if (existing) {
    throw new HttpError(
      409,
      existing.team_id === inv.team_id
        ? "You're already on this team."
        : "You're already on another team. Leave it in Settings → Team before joining a new one."
    );
  }
  await client.query(
    `INSERT INTO team_members (team_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)`,
    [inv.team_id, userId, inv.role, inv.invited_by]
  );
  await client.query(`UPDATE team_invites SET accepted_at = NOW(), accepted_by = $2 WHERE id = $1`, [inv.id, userId]);
}

module.exports = function teamRoutes(pool, authenticateToken, { authLimiter } = {}) {
  const router = express.Router();
  const ready = ensureTeamTables(pool).catch((err) => {
    console.error("Team tables could not be created:", err.message);
  });
  router.use("/api/team", (req, res, next) => ready.then(() => next()));

  const limit = authLimiter || ((req, res, next) => next());

  // ── GET /api/team ── the caller's team, its people and (for managers) pending invites
  router.get("/api/team", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const m = await membershipOf(pool, userId);
      if (!m) {
        const u = await pool.query("SELECT company_name FROM users WHERE id = $1", [userId]);
        const { plan } = await planFor(pool, userId);
        return res.json({
          success: true,
          team: null,
          plan,
          canCreate: seatLimit(plan) > 0,
          suggestedName: u.rows[0]?.company_name || "",
        });
      }

      const perms = permissionsFor(m.role);
      const members = (
        await pool.query(
          `SELECT u.id, COALESCE(NULLIF(u.name, ''), u.company_name, u.email) AS name, u.email, u.avatar_url,
                  tm.role, tm.joined_at, u.last_login, (u.managed_by_team = tm.team_id) AS managed
             FROM team_members tm JOIN users u ON u.id = tm.user_id
            WHERE tm.team_id = $1
            ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, lower(COALESCE(NULLIF(u.name, ''), u.email))`,
          [m.team_id]
        )
      ).rows.map((r) => ({
        userId: r.id,
        name: r.name,
        email: r.email,
        avatarUrl: r.avatar_url,
        role: r.role,
        joinedAt: r.joined_at,
        isYou: r.id === userId,
        managed: !!r.managed, // a company account (removing it deletes it)
        // Last sign-in is only for the people who manage the team
        ...(perms.viewInvites ? { lastActive: r.last_login || null } : {}),
      }));

      let invites = [];
      if (perms.viewInvites) {
        invites = (
          await pool.query(
            `SELECT id, email, role, created_at, last_sent_at, expires_at
               FROM team_invites
              WHERE team_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
              ORDER BY created_at DESC`,
            [m.team_id]
          )
        ).rows.map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          sentAt: r.last_sent_at,
          expiresAt: r.expires_at,
          expired: new Date(r.expires_at) <= new Date(),
        }));
      }

      return res.json({
        success: true,
        team: {
          id: m.team_id,
          name: m.name,
          store: m.store,
          createdAt: m.created_at,
          plan: m.owner_plan,
          seats: { used: await seatsUsed(pool, m.team_id), limit: seatLimit(m.owner_plan) },
        },
        me: { userId, role: m.role, managed: await isManaged(pool, userId), ...(await joinInfo(pool, m.team_id, userId)) },
        permissions: perms,
        members,
        invites,
      });
    } catch (err) {
      return fail(res, err, "Get team");
    }
  });

  // ── POST /api/team { name } ── create a team (Pro/Business; caller becomes owner)
  router.post("/api/team", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const name = cleanName(req.body?.name);
      if (!name || name.length > 60) throw new HttpError(400, "Team name must be 1 to 60 characters.");

      const team = await withTransaction(pool, async (client) => {
        const { plan } = await planFor(client, userId);
        if (seatLimit(plan) <= 0) {
          throw new HttpError(403, "Teams are available on the Pro and Business plans.", {
            code: "PLAN_LIMIT",
            requiredPlan: "pro",
            currentPlan: plan,
          });
        }
        if (await membershipOf(client, userId)) throw new HttpError(409, "You're already on a team.");
        const t = await client.query(`INSERT INTO teams (owner_user_id, name) VALUES ($1, $2) RETURNING id, name`, [
          userId,
          name,
        ]);
        await client.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`, [
          t.rows[0].id,
          userId,
        ]);
        return t.rows[0];
      });
      return res.json({ success: true, team });
    } catch (err) {
      if (err && err.code === "23505") return fail(res, new HttpError(409, "You're already on a team."));
      return fail(res, err, "Create team");
    }
  });

  // ── PATCH /api/team { name } ── rename (owner)
  router.patch("/api/team", authenticateToken, async (req, res) => {
    try {
      const m = await membershipOf(pool, req.user.userId);
      if (!m) throw new HttpError(404, "You're not on a team.");
      if (!permissionsFor(m.role).rename) throw new HttpError(403, "Only the team owner can rename the team.");
      const name = cleanName(req.body?.name);
      if (!name || name.length > 60) throw new HttpError(400, "Team name must be 1 to 60 characters.");
      await pool.query("UPDATE teams SET name = $2 WHERE id = $1", [m.team_id, name]);
      return res.json({ success: true, team: { id: m.team_id, name } });
    } catch (err) {
      return fail(res, err, "Rename team");
    }
  });

  // ── DELETE /api/team ── delete the team for everyone (owner)
  router.delete("/api/team", authenticateToken, async (req, res) => {
    try {
      const m = await membershipOf(pool, req.user.userId);
      if (!m) throw new HttpError(404, "You're not on a team.");
      if (!permissionsFor(m.role).deleteTeam) throw new HttpError(403, "Only the team owner can delete the team.");
      // Company accounts only exist for this team, so they go with it
      const managed = await pool.query(`SELECT id FROM users WHERE managed_by_team = $1 AND id <> $2`, [m.team_id, req.user.userId]);
      await pool.query("DELETE FROM teams WHERE id = $1 AND owner_user_id = $2", [m.team_id, req.user.userId]);
      for (const row of managed.rows) await deleteManagedAccount(pool, row.id, m.team_id);
      sends.delete(m.team_id);
      return res.json({ success: true, accountsDeleted: managed.rows.length });
    } catch (err) {
      return fail(res, err, "Delete team");
    }
  });

  // ── POST /api/team/invites { email, role } ── invite someone (owner, supervisor)
  router.post("/api/team/invites", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const email = String(req.body?.email || "").trim().toLowerCase();
      const role = String(req.body?.role || "member");
      if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "Enter a valid email address.");
      if (!["supervisor", "member"].includes(role)) throw new HttpError(400, "Role must be supervisor or member.");

      const token = newToken();
      const created = await withTransaction(pool, async (client) => {
        const m = await membershipOf(client, userId, { lock: true }); // lock the team: seat check + insert are atomic
        if (!m) throw new HttpError(404, "Create a team first.");
        if (!permissionsFor(m.role).inviteRoles.includes(role)) {
          throw new HttpError(403, role === "supervisor" ? "Only the owner can invite supervisors." : "You can't invite people to this team.");
        }
        const limit = seatLimit(m.owner_plan);
        if (limit <= 0) {
          throw new HttpError(403, "The team owner's plan doesn't include team seats. Upgrade to Pro or Business to invite people.", {
            code: "PLAN_LIMIT",
            requiredPlan: "pro",
          });
        }
        const already = await client.query(
          `SELECT 1 FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $1 AND lower(u.email) = $2`,
          [m.team_id, email]
        );
        if (already.rows.length) throw new HttpError(409, "That person is already on your team.");

        // An expired invite to the same address is closed so a fresh one can be sent
        await client.query(
          `UPDATE team_invites SET revoked_at = NOW()
            WHERE team_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= NOW()`,
          [m.team_id, email]
        );
        const open = await client.query(
          `SELECT 1 FROM team_invites WHERE team_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [m.team_id, email]
        );
        if (open.rows.length) throw new HttpError(409, "That email already has a pending invite. Use Resend instead.");

        if ((await seatsUsed(client, m.team_id)) >= limit) {
          throw new HttpError(403, `Your plan includes ${limit} team seats and they're all in use (pending invites count). Remove someone or cancel an invite first.`, {
            code: "SEAT_LIMIT",
          });
        }
        if (!underSendLimit(m.team_id)) throw new HttpError(429, "Too many invites sent today. Try again tomorrow.");

        const r = await client.query(
          `INSERT INTO team_invites (team_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' days')::interval)
           RETURNING id, email, role, last_sent_at, expires_at`,
          [m.team_id, email, role, hashToken(token), userId, String(INVITE_DAYS)]
        );
        const inviter = await client.query(
          `SELECT COALESCE(NULLIF(name, ''), company_name, email) AS name FROM users WHERE id = $1`,
          [userId]
        );
        return { invite: r.rows[0], teamId: m.team_id, teamName: m.name, inviterName: inviter.rows[0]?.name };
      });

      noteSend(created.teamId);
      const emailSent = await sendInvite({ email, role, token, teamName: created.teamName, inviterName: created.inviterName });
      const i = created.invite;
      return res.json({
        success: true,
        emailSent,
        joinUrl: joinUrl(token), // shown once so the inviter can share it another way if email fails
        invite: { id: i.id, email: i.email, role: i.role, sentAt: i.last_sent_at, expiresAt: i.expires_at, expired: false },
      });
    } catch (err) {
      if (err && err.code === "23505") return fail(res, new HttpError(409, "That email already has a pending invite."));
      return fail(res, err, "Create invite");
    }
  });

  // ── POST /api/team/invites/:id/resend ── new link + fresh 7 days (old link stops working)
  router.post("/api/team/invites/:id/resend", authenticateToken, async (req, res) => {
    try {
      const inviteId = Number(req.params.id);
      if (!Number.isInteger(inviteId)) throw new HttpError(400, "Invalid invite.");
      const token = newToken();
      const out = await withTransaction(pool, async (client) => {
        const m = await membershipOf(client, req.user.userId, { lock: true });
        if (!m) throw new HttpError(404, "You're not on a team.");
        const r = await client.query(
          `SELECT id, email, role, last_sent_at, expires_at FROM team_invites
            WHERE id = $1 AND team_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`,
          [inviteId, m.team_id]
        );
        const inv = r.rows[0];
        if (!inv) throw new HttpError(404, "Invite not found.");
        if (!permissionsFor(m.role).inviteRoles.includes(inv.role)) throw new HttpError(403, "You can't resend this invite.");
        if (seatLimit(m.owner_plan) <= 0) throw new HttpError(403, "The team owner's plan doesn't include team seats.", { code: "PLAN_LIMIT" });
        if (Date.now() - new Date(inv.last_sent_at).getTime() < 60 * 1000) {
          throw new HttpError(429, "That invite was just sent. Wait a minute before resending.");
        }
        // An expired invite stops holding a seat, so resending it has to fit
        if (new Date(inv.expires_at) <= new Date() && (await seatsUsed(client, m.team_id)) >= seatLimit(m.owner_plan)) {
          throw new HttpError(403, "All your team seats are in use. Remove someone or cancel an invite first.", { code: "SEAT_LIMIT" });
        }
        if (!underSendLimit(m.team_id)) throw new HttpError(429, "Too many invites sent today. Try again tomorrow.");
        const u = await client.query(
          `UPDATE team_invites SET token_hash = $2, last_sent_at = NOW(), expires_at = NOW() + ($3 || ' days')::interval
            WHERE id = $1 RETURNING id, email, role, last_sent_at, expires_at`,
          [inv.id, hashToken(token), String(INVITE_DAYS)]
        );
        const inviter = await client.query(
          `SELECT COALESCE(NULLIF(name, ''), company_name, email) AS name FROM users WHERE id = $1`,
          [req.user.userId]
        );
        return { invite: u.rows[0], teamId: m.team_id, teamName: m.name, inviterName: inviter.rows[0]?.name };
      });
      noteSend(out.teamId);
      const i = out.invite;
      const emailSent = await sendInvite({ email: i.email, role: i.role, token, teamName: out.teamName, inviterName: out.inviterName });
      return res.json({
        success: true,
        emailSent,
        joinUrl: joinUrl(token),
        invite: { id: i.id, email: i.email, role: i.role, sentAt: i.last_sent_at, expiresAt: i.expires_at, expired: false },
      });
    } catch (err) {
      return fail(res, err, "Resend invite");
    }
  });

  // ── DELETE /api/team/invites/:id ── cancel a pending invite
  router.delete("/api/team/invites/:id", authenticateToken, async (req, res) => {
    try {
      const inviteId = Number(req.params.id);
      if (!Number.isInteger(inviteId)) throw new HttpError(400, "Invalid invite.");
      const m = await membershipOf(pool, req.user.userId);
      if (!m) throw new HttpError(404, "You're not on a team.");
      const r = await pool.query(
        `SELECT role FROM team_invites WHERE id = $1 AND team_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [inviteId, m.team_id]
      );
      if (!r.rows[0]) throw new HttpError(404, "Invite not found.");
      if (!permissionsFor(m.role).inviteRoles.includes(r.rows[0].role)) throw new HttpError(403, "You can't cancel this invite.");
      await pool.query(`UPDATE team_invites SET revoked_at = NOW() WHERE id = $1 AND team_id = $2`, [inviteId, m.team_id]);
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Cancel invite");
    }
  });

  // ── PATCH /api/team/members/:userId { role } ── owner switches supervisor <-> member
  router.patch("/api/team/members/:userId", authenticateToken, async (req, res) => {
    try {
      const targetId = Number(req.params.userId);
      const role = String(req.body?.role || "");
      if (!Number.isInteger(targetId)) throw new HttpError(400, "Invalid member.");
      if (!["supervisor", "member"].includes(role)) throw new HttpError(400, "Role must be supervisor or member.");
      const m = await membershipOf(pool, req.user.userId);
      if (!m) throw new HttpError(404, "You're not on a team.");
      if (!permissionsFor(m.role).changeRoles) throw new HttpError(403, "Only the team owner can change roles.");
      const r = await pool.query(
        `UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2 AND role <> 'owner' RETURNING user_id`,
        [m.team_id, targetId, role]
      );
      if (!r.rows[0]) throw new HttpError(404, "Member not found.");
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Change role");
    }
  });

  // ── DELETE /api/team/members/:userId ── remove someone, or leave (your own id)
  router.delete("/api/team/members/:userId", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const targetId = Number(req.params.userId);
      if (!Number.isInteger(targetId)) throw new HttpError(400, "Invalid member.");
      const m = await membershipOf(pool, userId);
      if (!m) throw new HttpError(404, "You're not on a team.");

      if (targetId === userId) {
        if (m.role === "owner") throw new HttpError(400, "The owner can't leave the team. Delete the team instead.");
        if (await isManaged(pool, userId)) {
          throw new HttpError(403, `Your account is managed by ${m.store.name}. Ask the owner or a supervisor to remove you.`, {
            code: "MANAGED_ACCOUNT",
          });
        }
      } else {
        const t = await pool.query(`SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`, [m.team_id, targetId]);
        if (!t.rows[0]) throw new HttpError(404, "Member not found.");
        if (!permissionsFor(m.role).removeRoles.includes(t.rows[0].role)) {
          throw new HttpError(403, "You can't remove this person.");
        }
      }
      await pool.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2 AND role <> 'owner'`, [m.team_id, targetId]);
      const accountDeleted = targetId !== userId && (await deleteManagedAccount(pool, targetId, m.team_id));
      return res.json({ success: true, accountDeleted });
    } catch (err) {
      return fail(res, err, "Remove member");
    }
  });

  // The member `targetId` if the caller may manage them (same rule as removing)
  async function manageable(callerId, targetId) {
    const m = await membershipOf(pool, callerId);
    if (!m) throw new HttpError(404, "You're not on a team.");
    if (targetId === callerId) throw new HttpError(400, "Use your own Settings for your account.");
    const t = await pool.query(
      `SELECT tm.role, u.email, u.company_name, (u.managed_by_team = tm.team_id) AS managed
         FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = $1 AND tm.user_id = $2`,
      [m.team_id, targetId]
    );
    const target = t.rows[0];
    if (!target) throw new HttpError(404, "Member not found.");
    if (!permissionsFor(m.role).removeRoles.includes(target.role)) throw new HttpError(403, "You can't manage this person.");
    return { m, target };
  }

  // ── POST /api/team/members/:userId/reset-password ── email a company account a reset link
  router.post("/api/team/members/:userId/reset-password", authenticateToken, async (req, res) => {
    try {
      const targetId = Number(req.params.userId);
      if (!Number.isInteger(targetId)) throw new HttpError(400, "Invalid member.");
      const { m, target } = await manageable(req.user.userId, targetId);
      if (!target.managed) {
        throw new HttpError(403, "This person uses their own Aervo account. They can reset their password from the sign-in page.");
      }
      if (!underSendLimit(m.team_id)) throw new HttpError(429, "Too many emails sent today. Try again tomorrow.");
      const token = crypto.randomBytes(32).toString("hex");
      // Same format as /api/forgot-password: only a hash is stored, 1 hour
      await pool.query(
        `UPDATE users SET reset_token = $1, reset_token_expires = NOW() + interval '1 hour' WHERE id = $2`,
        [crypto.createHash("sha256").update(token).digest("hex"), targetId]
      );
      noteSend(m.team_id);
      let emailSent = true;
      try {
        const { sendPasswordResetEmail } = require("../utils/email");
        await sendPasswordResetEmail({ toEmail: target.email, companyName: m.store.name, token });
      } catch (err) {
        console.error("Team password reset email failed:", err.message);
        emailSent = false;
      }
      return res.json({ success: true, emailSent });
    } catch (err) {
      return fail(res, err, "Team password reset");
    }
  });

  // ── POST /api/team/members/:userId/sign-out ── end a company account's sessions on every device
  router.post("/api/team/members/:userId/sign-out", authenticateToken, async (req, res) => {
    try {
      const targetId = Number(req.params.userId);
      if (!Number.isInteger(targetId)) throw new HttpError(400, "Invalid member.");
      const { target } = await manageable(req.user.userId, targetId);
      if (!target.managed) throw new HttpError(403, "This person uses their own Aervo account, so only they can sign it out.");
      await revokeSessions(pool, targetId);
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Team sign-out");
    }
  });

  // ── POST /api/team/invites/lookup { token } ── what the join page shows (no sign-in needed)
  router.post("/api/team/invites/lookup", limit, async (req, res) => {
    try {
      await ready;
      const inv = await findInvite(pool, req.body?.token);
      if (!inv) throw new HttpError(404, "This invite link isn't valid. Check you copied the whole link.");
      const acct = await pool.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [inv.email]);
      return res.json({
        success: true,
        invite: {
          teamName: inv.team_name,
          inviterName: inv.inviter_name,
          role: inv.role,
          email: inv.email,
          status: inv.status,
          hasAccount: acct.rows.length > 0,
        },
      });
    } catch (err) {
      return fail(res, err, "Invite lookup");
    }
  });

  // ── POST /api/team/invites/accept { token } ── signed-in person joins
  router.post("/api/team/invites/accept", authenticateToken, async (req, res) => {
    try {
      await ready;
      const userId = req.user.userId;
      const team = await withTransaction(pool, async (client) => {
        const inv = await findInvite(client, req.body?.token, { lock: true });
        if (!inv) throw new HttpError(404, "This invite link isn't valid.");
        if (inv.status !== "pending") throw new HttpError(410, STATUS_MESSAGES[inv.status]);
        const me = await client.query("SELECT email FROM users WHERE id = $1", [userId]);
        if (String(me.rows[0]?.email || "").toLowerCase() !== inv.email.toLowerCase()) {
          throw new HttpError(403, `This invite is for ${inv.email}. Sign in with that email to accept it.`, { code: "WRONG_ACCOUNT" });
        }
        await joinFromInvite(client, inv, userId);
        return { id: inv.team_id, name: inv.team_name, role: inv.role };
      });
      return res.json({ success: true, team });
    } catch (err) {
      return fail(res, err, "Accept invite");
    }
  });

  // ── POST /api/team/invites/signup { token, name, password } ── new account straight onto the team
  router.post("/api/team/invites/signup", limit, async (req, res) => {
    try {
      await ready;
      const name = cleanName(req.body?.name);
      const password = req.body?.password;
      if (!name || name.length > 80) throw new HttpError(400, "Enter your name.");
      if (typeof password !== "string" || password.length < 8 || password.length > 128) {
        throw new HttpError(400, "Password must be between 8 and 128 characters.");
      }
      const hash = await bcrypt.hash(password, Number(process.env.BCRYPT_SALT_ROUNDS) || 10);

      const out = await withTransaction(pool, async (client) => {
        const inv = await findInvite(client, req.body?.token, { lock: true });
        if (!inv) throw new HttpError(404, "This invite link isn't valid.");
        if (inv.status !== "pending") throw new HttpError(410, STATUS_MESSAGES[inv.status]);
        const exists = await client.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [inv.email]);
        if (exists.rows.length) {
          throw new HttpError(409, "An Aervo account already uses this email. Sign in to accept the invite.", { code: "HAS_ACCOUNT" });
        }
        // The link was emailed to this address, so the account starts verified.
        // It belongs to a team, not a store, so it skips merchant onboarding.
        const u = await client.query(
          `INSERT INTO users (email, password_hash, company_name, name, role, email_verified, onboarded, managed_by_team)
           VALUES ($1, $2, $3, $4, 'Team member', TRUE, TRUE, $5)
           RETURNING id, email, company_name, role, token_version`,
          [inv.email.toLowerCase(), hash, inv.team_name, name, inv.team_id]
        );
        await joinFromInvite(client, inv, u.rows[0].id);
        return { user: u.rows[0], team: { id: inv.team_id, name: inv.team_name, role: inv.role } };
      });

      startSession(res, out.user);
      return res.json({
        success: true,
        user: { id: out.user.id, email: out.user.email, companyName: out.user.company_name, role: out.user.role },
        team: out.team,
      });
    } catch (err) {
      if (err && err.code === "23505") return fail(res, new HttpError(409, "An Aervo account already uses this email. Sign in to accept the invite."));
      return fail(res, err, "Invite signup");
    }
  });

  return router;

  async function sendInvite({ email, role, token, teamName, inviterName }) {
    try {
      const { sendTeamInviteEmail } = require("../utils/email");
      await sendTeamInviteEmail({ toEmail: email, teamName, inviterName, role, joinUrl: joinUrl(token), expiresDays: INVITE_DAYS });
      return true;
    } catch (err) {
      console.error("Team invite email failed:", err.message);
      return false;
    }
  }
};

module.exports.ensureTeamTables = ensureTeamTables;
module.exports.teamSummaryFor = teamSummaryFor;
module.exports.membershipOf = membershipOf;
module.exports.permissionsFor = permissionsFor;
module.exports.__test = { sends, hashToken };
