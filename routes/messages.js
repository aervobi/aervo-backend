// Team messaging: direct messages and group chats between people on the same team.
//
//  - Everything is scoped by the caller's team_members row (routes/team.js). The
//    client never sends a team id; a conversation is only visible to someone who
//    is in it AND still on the team it belongs to. Leaving the team hides its
//    conversations at once, and joining again brings them back.
//  - Anyone on the team can start a direct message with a teammate (one DM per
//    pair, dm_key = "low:high" user ids). Owners and supervisors create group
//    chats; the group's creator, the owner and supervisors rename it and add or
//    remove people. Anyone can leave a group.
//  - Reading always works. Sending needs the team owner's plan to include team
//    seats (Pro/Business), the same rule that governs invites.
//  - Unread = messages from other people with an id above your last_read_id.
//  - Live updates are Server-Sent Events (GET /api/messages/stream). The hub is in
//    memory, so it reaches tabs connected to THIS server process; if the API ever
//    runs on more than one instance, swap the hub for Postgres LISTEN/NOTIFY.
//    Pages also poll as a fallback (and the Shopify iframe, which can't send the
//    session cookie on an EventSource, only polls).
const express = require("express");
const PLANS = require("../config/plans");
const { membershipOf } = require("./team");

const MAX_BODY = 4000;
const MAX_GROUP_NAME = 60;
const MAX_GROUP_SIZE = 50; // the largest team (Business seats)
const PAGE_SIZE = 50;
const SENDS_PER_MINUTE = 30;
const STREAM_MAX_MS = 10 * 60 * 1000; // streams end after this; the browser reconnects (and re-authenticates)
const STREAM_HEARTBEAT_MS = 25 * 1000; // keeps proxies from closing an idle stream
const STREAMS_PER_USER = 6;

const sendLog = new Map(); // userId -> [timestamps]
const streams = new Map(); // userId -> Set<res>

const seatLimit = (plan) => (PLANS[plan] || PLANS.free).teamSeats || 0;
const cleanName = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
const dmKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function underSendLimit(userId) {
  const minuteAgo = Date.now() - 60 * 1000;
  const recent = (sendLog.get(userId) || []).filter((t) => t > minuteAgo);
  if (recent.length >= SENDS_PER_MINUTE) {
    sendLog.set(userId, recent);
    return false;
  }
  recent.push(Date.now());
  sendLog.set(userId, recent);
  return true;
}

// ── live hub ──────────────────────────────────────────────────────────────────
function publish(userIds, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) {
    const set = streams.get(Number(id));
    if (!set) continue;
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        /* closed; cleaned up by its 'close' handler */
      }
    }
  }
}

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

async function ensureMessageTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_conversations (
      id              SERIAL PRIMARY KEY,
      team_id         INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
      name            TEXT,
      dm_key          TEXT,
      created_by      INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_message_at TIMESTAMPTZ
    )`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS team_conversations_dm
      ON team_conversations (team_id, dm_key) WHERE dm_key IS NOT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_conversation_members (
      conversation_id INTEGER NOT NULL REFERENCES team_conversations(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_id    BIGINT NOT NULL DEFAULT 0,
      joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (conversation_id, user_id)
    )`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS team_conversation_members_user ON team_conversation_members (user_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_messages (
      id              BIGSERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES team_conversations(id) ON DELETE CASCADE,
      user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body            TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ
    )`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS team_messages_conversation ON team_messages (conversation_id, id DESC)`);
}

// The conversation if the caller is in it and on its team, else null
async function conversationFor(db, conversationId, userId) {
  const r = await db.query(
    `SELECT c.*, cm.last_read_id, tm.role AS my_role
       FROM team_conversations c
       JOIN team_conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
       JOIN team_members tm ON tm.user_id = $2 AND tm.team_id = c.team_id
      WHERE c.id = $1`,
    [conversationId, userId]
  );
  return r.rows[0] || null;
}

// People in a conversation. `active` = still on the conversation's team.
async function participantsOf(db, conversationIds) {
  if (!conversationIds.length) return new Map();
  const r = await db.query(
    `SELECT cm.conversation_id, u.id, COALESCE(NULLIF(u.name, ''), u.company_name, u.email) AS name,
            u.avatar_url, tm.role, (tm.user_id IS NOT NULL) AS active
       FROM team_conversation_members cm
       JOIN team_conversations c ON c.id = cm.conversation_id
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN team_members tm ON tm.user_id = cm.user_id AND tm.team_id = c.team_id
      WHERE cm.conversation_id = ANY($1::int[])
      ORDER BY lower(COALESCE(NULLIF(u.name, ''), u.email))`,
    [conversationIds]
  );
  const out = new Map();
  for (const row of r.rows) {
    if (!out.has(row.conversation_id)) out.set(row.conversation_id, []);
    out.get(row.conversation_id).push({
      userId: row.id,
      name: row.name,
      avatarUrl: row.avatar_url,
      role: row.role || null,
      active: row.active,
    });
  }
  return out;
}

// User ids that should get live events for a conversation (in it + on its team)
async function audienceOf(db, conversationId) {
  const r = await db.query(
    `SELECT cm.user_id
       FROM team_conversation_members cm
       JOIN team_conversations c ON c.id = cm.conversation_id
       JOIN team_members tm ON tm.user_id = cm.user_id AND tm.team_id = c.team_id
      WHERE cm.conversation_id = $1`,
    [conversationId]
  );
  return r.rows.map((x) => x.user_id);
}

function messageOut(row) {
  const deleted = !!row.deleted_at;
  return {
    id: Number(row.id),
    conversationId: row.conversation_id,
    userId: row.user_id,
    authorName: row.author_name || null,
    body: deleted ? "" : row.body,
    deleted,
    createdAt: row.created_at,
  };
}

const canManageGroup = (conv, userId) =>
  conv.kind === "group" && (conv.created_by === userId || conv.my_role === "owner" || conv.my_role === "supervisor");

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

// Total unread across the caller's conversations on their current team
async function unreadTotal(db, userId) {
  const r = await db.query(
    `SELECT COUNT(*) AS n
       FROM team_conversation_members cm
       JOIN team_conversations c ON c.id = cm.conversation_id
       JOIN team_members tm ON tm.user_id = cm.user_id AND tm.team_id = c.team_id
       JOIN team_messages m ON m.conversation_id = c.id
      WHERE cm.user_id = $1 AND m.id > cm.last_read_id
        AND m.deleted_at IS NULL AND (m.user_id IS NULL OR m.user_id <> $1)`,
    [userId]
  );
  return Number(r.rows[0].n);
}

module.exports = function messageRoutes(pool, authenticateToken) {
  const router = express.Router();
  const ready = ensureMessageTables(pool).catch((err) => {
    console.error("Message tables could not be created:", err.message);
  });
  router.use("/api/messages", (req, res, next) => ready.then(() => next()));

  // Shapes one conversation (or many) for the client
  async function conversationsFor(userId, onlyId) {
    const r = await pool.query(
      `SELECT c.id, c.kind, c.name, c.created_by, c.created_at, c.last_message_at, cm.last_read_id,
              lm.id AS lm_id, lm.user_id AS lm_user_id, lm.body AS lm_body, lm.created_at AS lm_created_at,
              lm.deleted_at AS lm_deleted_at,
              COALESCE(NULLIF(lu.name, ''), lu.company_name, lu.email) AS lm_author,
              (SELECT COUNT(*) FROM team_messages um
                WHERE um.conversation_id = c.id AND um.id > cm.last_read_id
                  AND um.deleted_at IS NULL AND (um.user_id IS NULL OR um.user_id <> $1)) AS unread
         FROM team_conversation_members cm
         JOIN team_conversations c ON c.id = cm.conversation_id
         JOIN team_members tm ON tm.user_id = cm.user_id AND tm.team_id = c.team_id
         LEFT JOIN LATERAL (
           SELECT * FROM team_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1
         ) lm ON TRUE
         LEFT JOIN users lu ON lu.id = lm.user_id
        WHERE cm.user_id = $1
          ${
            onlyId
              ? "AND c.id = $2"
              : // in the list, an empty DM only shows for the person who opened it
                "AND (c.kind = 'group' OR c.last_message_at IS NOT NULL OR c.created_by = $1)"
          }
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
        LIMIT 200`,
      onlyId ? [userId, onlyId] : [userId]
    );
    const people = await participantsOf(
      pool,
      r.rows.map((x) => x.id)
    );
    return r.rows.map((row) => {
      const participants = people.get(row.id) || [];
      const others = participants.filter((p) => p.userId !== userId);
      return {
        id: row.id,
        kind: row.kind,
        name: row.kind === "group" ? row.name : (others[0] && others[0].name) || "Direct message",
        createdBy: row.created_by,
        createdAt: row.created_at,
        lastMessageAt: row.last_message_at,
        lastReadId: Number(row.last_read_id),
        unread: Number(row.unread),
        participants,
        lastMessage: row.lm_id
          ? messageOut({
              id: row.lm_id,
              conversation_id: row.id,
              user_id: row.lm_user_id,
              author_name: row.lm_author,
              body: row.lm_body,
              deleted_at: row.lm_deleted_at,
              created_at: row.lm_created_at,
            })
          : null,
      };
    });
  }

  // Can this team send messages right now?
  async function assertCanSend(m) {
    if (seatLimit(m.owner_plan) <= 0) {
      throw new HttpError(403, "Team messaging is part of the Pro and Business plans. Ask the team owner to upgrade.", {
        code: "PLAN_LIMIT",
        requiredPlan: "pro",
      });
    }
  }

  // ── GET /api/messages/conversations ──
  router.get("/api/messages/conversations", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const m = await membershipOf(pool, userId);
      if (!m) return res.json({ success: true, team: null, conversations: [] });
      return res.json({
        success: true,
        team: { id: m.team_id, name: m.name, role: m.role, canSend: seatLimit(m.owner_plan) > 0 },
        me: { userId, role: m.role },
        permissions: { createGroup: m.role === "owner" || m.role === "supervisor" },
        conversations: await conversationsFor(userId),
      });
    } catch (err) {
      return fail(res, err, "List conversations");
    }
  });

  // ── GET /api/messages/unread ── badge count for the nav
  router.get("/api/messages/unread", authenticateToken, async (req, res) => {
    try {
      return res.json({ success: true, unread: await unreadTotal(pool, req.user.userId) });
    } catch (err) {
      return fail(res, err, "Unread count");
    }
  });

  // ── POST /api/messages/conversations ──
  //   { kind: "dm", userId }                     open (or reuse) a DM with a teammate
  //   { kind: "group", name, userIds: [..] }     owner/supervisor creates a group
  router.post("/api/messages/conversations", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const kind = req.body?.kind === "group" ? "group" : "dm";

      const out = await withTransaction(pool, async (client) => {
        const m = await membershipOf(client, userId);
        if (!m) throw new HttpError(404, "Join or create a team to send messages.");
        await assertCanSend(m);

        if (kind === "dm") {
          const otherId = toId(req.body?.userId);
          if (!otherId || otherId === userId) throw new HttpError(400, "Pick a teammate to message.");
          const other = await client.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`, [
            m.team_id,
            otherId,
          ]);
          if (!other.rows.length) throw new HttpError(404, "That person isn't on your team.");
          const key = dmKey(userId, otherId);
          const found = await client.query(`SELECT id FROM team_conversations WHERE team_id = $1 AND dm_key = $2`, [
            m.team_id,
            key,
          ]);
          if (found.rows[0]) return { id: found.rows[0].id, created: false, audience: [userId] };
          const c = await client.query(
            `INSERT INTO team_conversations (team_id, kind, dm_key, created_by) VALUES ($1, 'dm', $2, $3) RETURNING id`,
            [m.team_id, key, userId]
          );
          await client.query(
            `INSERT INTO team_conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
            [c.rows[0].id, userId, otherId]
          );
          // The other person only hears about a DM once it has a message in it
          return { id: c.rows[0].id, created: true, audience: [userId] };
        }

        if (m.role !== "owner" && m.role !== "supervisor") {
          throw new HttpError(403, "Only the team owner and supervisors can create group chats.");
        }
        const name = cleanName(req.body?.name);
        if (!name || name.length > MAX_GROUP_NAME) throw new HttpError(400, `Group name must be 1 to ${MAX_GROUP_NAME} characters.`);
        const ids = [...new Set((Array.isArray(req.body?.userIds) ? req.body.userIds : []).map(toId).filter(Boolean))].filter(
          (id) => id !== userId
        );
        if (!ids.length) throw new HttpError(400, "Add at least one teammate to the group.");
        if (ids.length + 1 > MAX_GROUP_SIZE) throw new HttpError(400, `A group can have up to ${MAX_GROUP_SIZE} people.`);
        const onTeam = await client.query(`SELECT user_id FROM team_members WHERE team_id = $1 AND user_id = ANY($2::int[])`, [
          m.team_id,
          ids,
        ]);
        if (onTeam.rows.length !== ids.length) throw new HttpError(400, "Everyone in a group has to be on your team.");
        const c = await client.query(
          `INSERT INTO team_conversations (team_id, kind, name, created_by) VALUES ($1, 'group', $2, $3) RETURNING id`,
          [m.team_id, name, userId]
        );
        const all = [userId, ...ids];
        await client.query(
          `INSERT INTO team_conversation_members (conversation_id, user_id) SELECT $1, unnest($2::int[])`,
          [c.rows[0].id, all]
        );
        return { id: c.rows[0].id, created: true, audience: all };
      });

      const [conversation] = await conversationsFor(userId, out.id);
      if (out.created) publish(out.audience, "conversation", { conversationId: out.id, change: "added" });
      return res.json({ success: true, created: out.created, conversation });
    } catch (err) {
      if (err && err.code === "23505") {
        // Two people opened the same DM at the same moment: hand back the one that won
        return fail(res, new HttpError(409, "That conversation already exists. Refresh and try again."));
      }
      return fail(res, err, "Create conversation");
    }
  });

  // ── PATCH /api/messages/conversations/:id { name?, addUserIds?, removeUserIds? } ── manage a group
  router.patch("/api/messages/conversations/:id", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const id = toId(req.params.id);
      if (!id) throw new HttpError(400, "Invalid conversation.");

      const result = await withTransaction(pool, async (client) => {
        const conv = await conversationFor(client, id, userId);
        if (!conv) throw new HttpError(404, "Conversation not found.");
        if (!canManageGroup(conv, userId)) throw new HttpError(403, "You can't change this conversation.");
        const before = await audienceOf(client, id);

        if (req.body?.name !== undefined) {
          const name = cleanName(req.body.name);
          if (!name || name.length > MAX_GROUP_NAME) throw new HttpError(400, `Group name must be 1 to ${MAX_GROUP_NAME} characters.`);
          await client.query(`UPDATE team_conversations SET name = $2 WHERE id = $1`, [id, name]);
        }

        const add = [...new Set((req.body?.addUserIds || []).map(toId).filter(Boolean))];
        if (add.length) {
          const onTeam = await client.query(
            `SELECT user_id FROM team_members WHERE team_id = $1 AND user_id = ANY($2::int[])`,
            [conv.team_id, add]
          );
          if (onTeam.rows.length !== add.length) throw new HttpError(400, "Everyone in a group has to be on your team.");
          await client.query(
            `INSERT INTO team_conversation_members (conversation_id, user_id, last_read_id)
             SELECT $1, u, COALESCE((SELECT MAX(id) FROM team_messages WHERE conversation_id = $1), 0)
               FROM unnest($2::int[]) AS u
             ON CONFLICT DO NOTHING`,
            [id, add]
          );
        }

        const remove = [...new Set((req.body?.removeUserIds || []).map(toId).filter(Boolean))].filter((x) => x !== userId);
        if (remove.length) {
          await client.query(`DELETE FROM team_conversation_members WHERE conversation_id = $1 AND user_id = ANY($2::int[])`, [
            id,
            remove,
          ]);
        }

        const size = await client.query(`SELECT COUNT(*) AS n FROM team_conversation_members WHERE conversation_id = $1`, [id]);
        if (Number(size.rows[0].n) > MAX_GROUP_SIZE) throw new HttpError(400, `A group can have up to ${MAX_GROUP_SIZE} people.`);
        return { before, removed: remove };
      });

      const after = await audienceOf(pool, id);
      publish([...result.before, ...after], "conversation", { conversationId: id, change: "updated" });
      publish(result.removed, "conversation", { conversationId: id, change: "removed" });
      const [conversation] = await conversationsFor(userId, id);
      return res.json({ success: true, conversation });
    } catch (err) {
      return fail(res, err, "Update conversation");
    }
  });

  // ── POST /api/messages/conversations/:id/leave ── leave a group
  router.post("/api/messages/conversations/:id/leave", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const id = toId(req.params.id);
      if (!id) throw new HttpError(400, "Invalid conversation.");
      const conv = await conversationFor(pool, id, userId);
      if (!conv) throw new HttpError(404, "Conversation not found.");
      if (conv.kind !== "group") throw new HttpError(400, "You can only leave group chats.");
      await pool.query(`DELETE FROM team_conversation_members WHERE conversation_id = $1 AND user_id = $2`, [id, userId]);
      // An empty group has no one left to see it
      await pool.query(
        `DELETE FROM team_conversations c WHERE c.id = $1
           AND NOT EXISTS (SELECT 1 FROM team_conversation_members WHERE conversation_id = c.id)`,
        [id]
      );
      publish([userId], "conversation", { conversationId: id, change: "removed" });
      publish(await audienceOf(pool, id), "conversation", { conversationId: id, change: "updated" });
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Leave conversation");
    }
  });

  // ── DELETE /api/messages/conversations/:id ── delete a group for everyone (creator or owner)
  router.delete("/api/messages/conversations/:id", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const id = toId(req.params.id);
      if (!id) throw new HttpError(400, "Invalid conversation.");
      const conv = await conversationFor(pool, id, userId);
      if (!conv) throw new HttpError(404, "Conversation not found.");
      if (conv.kind !== "group" || (conv.created_by !== userId && conv.my_role !== "owner")) {
        throw new HttpError(403, "Only the group's creator or the team owner can delete it.");
      }
      const audience = await audienceOf(pool, id);
      await pool.query(`DELETE FROM team_conversations WHERE id = $1 AND team_id = $2`, [id, conv.team_id]);
      publish(audience, "conversation", { conversationId: id, change: "removed" });
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Delete conversation");
    }
  });

  // ── GET /api/messages/conversations/:id/messages?before=ID ── newest page first, returned oldest→newest
  router.get("/api/messages/conversations/:id/messages", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const id = toId(req.params.id);
      if (!id) throw new HttpError(400, "Invalid conversation.");
      const conv = await conversationFor(pool, id, userId);
      if (!conv) throw new HttpError(404, "Conversation not found.");
      const before = toId(req.query.before);
      const after = toId(req.query.after);
      const r = await pool.query(
        `SELECT m.*, COALESCE(NULLIF(u.name, ''), u.company_name, u.email) AS author_name
           FROM team_messages m LEFT JOIN users u ON u.id = m.user_id
          WHERE m.conversation_id = $1
            ${before ? "AND m.id < $3" : after ? "AND m.id > $3" : ""}
          ORDER BY m.id ${after ? "ASC" : "DESC"}
          LIMIT $2`,
        before || after ? [id, PAGE_SIZE + 1, before || after] : [id, PAGE_SIZE + 1]
      );
      const more = r.rows.length > PAGE_SIZE;
      const rows = r.rows.slice(0, PAGE_SIZE);
      if (!after) rows.reverse();
      return res.json({ success: true, messages: rows.map(messageOut), hasMore: more });
    } catch (err) {
      return fail(res, err, "List messages");
    }
  });

  // ── POST /api/messages/conversations/:id/messages { body, clientId? } ──
  router.post("/api/messages/conversations/:id/messages", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const id = toId(req.params.id);
      if (!id) throw new HttpError(400, "Invalid conversation.");
      const body = String(req.body?.body == null ? "" : req.body.body).replace(/\r\n/g, "\n").trim();
      if (!body) throw new HttpError(400, "Type a message first.");
      if (body.length > MAX_BODY) throw new HttpError(400, `Messages can be up to ${MAX_BODY} characters.`);
      const clientId = typeof req.body?.clientId === "string" ? req.body.clientId.slice(0, 64) : null;

      const m = await membershipOf(pool, userId);
      if (!m) throw new HttpError(404, "Conversation not found.");
      const conv = await conversationFor(pool, id, userId);
      if (!conv) throw new HttpError(404, "Conversation not found.");
      await assertCanSend(m);
      const audience = await audienceOf(pool, id);
      if (conv.kind === "dm" && audience.length < 2) {
        throw new HttpError(403, "This person is no longer on your team, so they can't get new messages.");
      }
      if (!underSendLimit(userId)) throw new HttpError(429, "You're sending messages very fast. Wait a moment and try again.");

      const r = await pool.query(
        `WITH ins AS (
           INSERT INTO team_messages (conversation_id, user_id, body) VALUES ($1, $2, $3) RETURNING *
         ), touch AS (
           UPDATE team_conversations SET last_message_at = (SELECT created_at FROM ins) WHERE id = $1
         ), seen AS (
           UPDATE team_conversation_members SET last_read_id = (SELECT id FROM ins)
            WHERE conversation_id = $1 AND user_id = $2
         )
         SELECT ins.*, COALESCE(NULLIF(u.name, ''), u.company_name, u.email) AS author_name
           FROM ins LEFT JOIN users u ON u.id = ins.user_id`,
        [id, userId, body]
      );
      const message = messageOut(r.rows[0]);
      publish(audience, "message", { conversationId: id, message, clientId });
      return res.json({ success: true, message, clientId });
    } catch (err) {
      return fail(res, err, "Send message");
    }
  });

  // ── DELETE /api/messages/:messageId ── remove one of your own messages (shown as "message deleted")
  router.delete("/api/messages/:messageId", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const messageId = toId(req.params.messageId);
      if (!messageId) throw new HttpError(400, "Invalid message.");
      const r = await pool.query(`SELECT conversation_id, user_id FROM team_messages WHERE id = $1 AND deleted_at IS NULL`, [
        messageId,
      ]);
      const row = r.rows[0];
      if (!row || !(await conversationFor(pool, row.conversation_id, userId))) throw new HttpError(404, "Message not found.");
      if (row.user_id !== userId) throw new HttpError(403, "You can only delete your own messages.");
      await pool.query(`UPDATE team_messages SET deleted_at = NOW(), body = '' WHERE id = $1`, [messageId]);
      publish(await audienceOf(pool, row.conversation_id), "message_deleted", {
        conversationId: row.conversation_id,
        messageId,
      });
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Delete message");
    }
  });

  // ── POST /api/messages/conversations/:id/read { messageId } ── mark read up to a message
  router.post("/api/messages/conversations/:id/read", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const id = toId(req.params.id);
      const messageId = toId(req.body?.messageId);
      if (!id || !messageId) throw new HttpError(400, "Invalid conversation.");
      const conv = await conversationFor(pool, id, userId);
      if (!conv) throw new HttpError(404, "Conversation not found.");
      // Never move backwards, and never past the newest message in this conversation
      const r = await pool.query(
        `UPDATE team_conversation_members
            SET last_read_id = GREATEST(last_read_id,
                  LEAST($3, COALESCE((SELECT MAX(id) FROM team_messages WHERE conversation_id = $1), 0)))
          WHERE conversation_id = $1 AND user_id = $2
          RETURNING last_read_id`,
        [id, userId, messageId]
      );
      const lastReadId = Number(r.rows[0]?.last_read_id || 0);
      publish([userId], "read", { conversationId: id, lastReadId }); // the caller's other tabs
      return res.json({ success: true, lastReadId, unread: await unreadTotal(pool, userId) });
    } catch (err) {
      return fail(res, err, "Mark read");
    }
  });

  // ── GET /api/messages/stream ── Server-Sent Events for the caller
  router.get("/api/messages/stream", authenticateToken, (req, res) => {
    const userId = Number(req.user.userId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 5000\nevent: ready\ndata: {}\n\n`);

    let set = streams.get(userId);
    if (!set) streams.set(userId, (set = new Set()));
    if (set.size >= STREAMS_PER_USER) {
      const oldest = set.values().next().value;
      set.delete(oldest);
      try {
        oldest.end();
      } catch {}
    }
    set.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {}
    }, STREAM_HEARTBEAT_MS);
    // End periodically so the reconnect re-checks the session (logout, idle timeout)
    const lifetime = setTimeout(() => {
      try {
        res.end();
      } catch {}
    }, STREAM_MAX_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      const s = streams.get(userId);
      if (s) {
        s.delete(res);
        if (!s.size) streams.delete(userId);
      }
    });
  });

  return router;
};

module.exports.ensureMessageTables = ensureMessageTables;
module.exports.publish = publish;
module.exports.__test = { sendLog, streams };
