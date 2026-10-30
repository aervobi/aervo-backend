// Team work: announcements, shift checklists, tasks and staff activity scores.
//
//  - Everything is scoped by the caller's team_members row (routes/team.js),
//    never by a client-sent team id. "Managers" are the owner and supervisors.
//  - Announcements: managers post; everyone else marks them read ("Got it").
//    Managers see who has and hasn't read each one.
//  - Checklists: managers build recurring lists (every day, or chosen weekdays)
//    for everyone or one role. Any person the list is for can tick an item for a
//    given day; one tick counts for the whole team (it's a shared list).
//    The day is the person's local date, sent by the page (YYYY-MM-DD) and only
//    accepted within a day of the server's date, so nobody fills in last week.
//  - Tasks: one-off jobs with an optional assignee and due date. Managers create
//    them; the assignee (or anyone, when unassigned) marks them done.
//  - Performance: activity only (checklist items ticked, tasks done and on time,
//    announcements read). Sales per person isn't tracked: the platforms don't
//    say who made a sale (decided with the user, 2026-10-30).
//  - Changes are pushed to the team over the messages stream as a "team" event,
//    so open pages can refresh.
const express = require("express");
const { membershipOf } = require("./team");
const { publish } = require("./messages");

const MAX_ANNOUNCEMENT = 2000;
const MAX_TITLE = 120;
const MAX_ITEM = 200;
const MAX_ITEMS = 40;
const MAX_NOTES = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isManager = (role) => role === "owner" || role === "supervisor";
const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

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

// The person's local day. Accepts today ± 1 day (time zones) and falls back to the server's date.
function dayFrom(v) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (typeof v !== "string" || !DATE_RE.test(v)) return iso(today);
  const t = Date.parse(v + "T12:00:00Z");
  if (Number.isNaN(t) || Math.abs(t - today.getTime()) > 36 * 3600 * 1000) {
    throw new HttpError(400, "That date can't be changed here.");
  }
  return v;
}

// 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD date
const weekdayOf = (day) => new Date(day + "T12:00:00Z").getUTCDay();

async function ensureTeamWorkTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_announcements (
      id         SERIAL PRIMARY KEY,
      team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS team_announcements_team ON team_announcements (team_id, id DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_announcement_reads (
      announcement_id INTEGER NOT NULL REFERENCES team_announcements(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (announcement_id, user_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_checklists (
      id            SERIAL PRIMARY KEY,
      team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      days          INTEGER[] NOT NULL DEFAULT '{}', -- weekdays 0-6; empty = every day
      assignee_role TEXT CHECK (assignee_role IN ('supervisor', 'member')), -- null = everyone
      created_by    INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at   TIMESTAMPTZ
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_checklist_items (
      id           SERIAL PRIMARY KEY,
      checklist_id INTEGER NOT NULL REFERENCES team_checklists(id) ON DELETE CASCADE,
      text         TEXT NOT NULL,
      position     INTEGER NOT NULL DEFAULT 0,
      removed_at   TIMESTAMPTZ
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_checklist_checks (
      item_id    INTEGER NOT NULL REFERENCES team_checklist_items(id) ON DELETE CASCADE,
      run_date   DATE NOT NULL,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (item_id, run_date)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_tasks (
      id          SERIAL PRIMARY KEY,
      team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      notes       TEXT,
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      due_date    DATE,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      done_at     TIMESTAMPTZ,
      done_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS team_tasks_team ON team_tasks (team_id, done_at)`);
}

const nameSql = (alias) => `COALESCE(NULLIF(${alias}.name, ''), ${alias}.company_name, ${alias}.email)`;

module.exports = function teamWorkRoutes(pool, authenticateToken) {
  const router = express.Router();
  const ready = ensureTeamWorkTables(pool).catch((err) => {
    console.error("Team work tables could not be created:", err.message);
  });
  router.use("/api/team/work", (req, res, next) => ready.then(() => next()));

  async function member(req) {
    const m = await membershipOf(pool, req.user.userId);
    if (!m) throw new HttpError(404, "You're not on a team.");
    return m;
  }
  function requireManager(m) {
    if (!isManager(m.role)) throw new HttpError(403, "Only the team owner and supervisors can do that.");
  }
  async function teamUserIds(teamId) {
    const r = await pool.query(`SELECT user_id FROM team_members WHERE team_id = $1`, [teamId]);
    return r.rows.map((x) => x.user_id);
  }
  async function notify(teamId, kind) {
    try {
      publish(await teamUserIds(teamId), "team", { kind });
    } catch {
      /* live updates are best-effort */
    }
  }

  // ── announcements ──────────────────────────────────────────────────────────

  // GET /api/team/work/announcements — newest first (30). Managers also get read receipts.
  router.get("/api/team/work/announcements", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      const me = req.user.userId;
      const r = await pool.query(
        `SELECT a.id, a.body, a.created_at, a.author_id, ${nameSql("u")} AS author_name,
                EXISTS (SELECT 1 FROM team_announcement_reads x WHERE x.announcement_id = a.id AND x.user_id = $2) AS read_by_me
           FROM team_announcements a LEFT JOIN users u ON u.id = a.author_id
          WHERE a.team_id = $1
          ORDER BY a.id DESC LIMIT 30`,
        [m.team_id, me]
      );
      let receipts = new Map();
      if (isManager(m.role) && r.rows.length) {
        // Everyone on the team now, except the author, counts as an expected reader
        const rr = await pool.query(
          `SELECT a.id AS announcement_id, tm.user_id, ${nameSql("u")} AS name, x.read_at
             FROM team_announcements a
             JOIN team_members tm ON tm.team_id = a.team_id AND tm.user_id IS DISTINCT FROM a.author_id
             JOIN users u ON u.id = tm.user_id
             LEFT JOIN team_announcement_reads x ON x.announcement_id = a.id AND x.user_id = tm.user_id
            WHERE a.id = ANY($1::int[])
            ORDER BY lower(${nameSql("u")})`,
          [r.rows.map((x) => x.id)]
        );
        for (const row of rr.rows) {
          if (!receipts.has(row.announcement_id)) receipts.set(row.announcement_id, []);
          receipts.get(row.announcement_id).push({ userId: row.user_id, name: row.name, readAt: row.read_at });
        }
      }
      return res.json({
        success: true,
        canPost: isManager(m.role),
        announcements: r.rows.map((a) => ({
          id: a.id,
          body: a.body,
          createdAt: a.created_at,
          author: { userId: a.author_id, name: a.author_name || "Former teammate" },
          mine: a.author_id === me,
          read: a.read_by_me || a.author_id === me,
          canDelete: a.author_id === me || m.role === "owner",
          ...(receipts.size ? { readers: receipts.get(a.id) || [] } : {}),
        })),
      });
    } catch (err) {
      return fail(res, err, "List announcements");
    }
  });

  // POST /api/team/work/announcements { body } — managers
  router.post("/api/team/work/announcements", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      requireManager(m);
      const body = String(req.body?.body == null ? "" : req.body.body).replace(/\r\n/g, "\n").trim();
      if (!body) throw new HttpError(400, "Write the announcement first.");
      if (body.length > MAX_ANNOUNCEMENT) throw new HttpError(400, `Announcements can be up to ${MAX_ANNOUNCEMENT} characters.`);
      const r = await pool.query(
        `INSERT INTO team_announcements (team_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
        [m.team_id, req.user.userId, body]
      );
      notify(m.team_id, "announcements");
      return res.json({ success: true, id: r.rows[0].id });
    } catch (err) {
      return fail(res, err, "Post announcement");
    }
  });

  // POST /api/team/work/announcements/:id/read — "Got it"
  router.post("/api/team/work/announcements/:id/read", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      const id = toId(req.params.id);
      const r = await pool.query(`SELECT 1 FROM team_announcements WHERE id = $1 AND team_id = $2`, [id, m.team_id]);
      if (!r.rows.length) throw new HttpError(404, "Announcement not found.");
      await pool.query(
        `INSERT INTO team_announcement_reads (announcement_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, req.user.userId]
      );
      notify(m.team_id, "announcements"); // managers' read receipts
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Read announcement");
    }
  });

  // DELETE /api/team/work/announcements/:id — the author or the owner
  router.delete("/api/team/work/announcements/:id", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      const id = toId(req.params.id);
      const r = await pool.query(`SELECT author_id FROM team_announcements WHERE id = $1 AND team_id = $2`, [id, m.team_id]);
      if (!r.rows.length) throw new HttpError(404, "Announcement not found.");
      if (r.rows[0].author_id !== req.user.userId && m.role !== "owner") {
        throw new HttpError(403, "Only the person who posted it or the owner can delete it.");
      }
      await pool.query(`DELETE FROM team_announcements WHERE id = $1 AND team_id = $2`, [id, m.team_id]);
      notify(m.team_id, "announcements");
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Delete announcement");
    }
  });

  // ── checklists ─────────────────────────────────────────────────────────────

  function parseChecklist(body) {
    const title = clean(body?.title);
    if (!title || title.length > MAX_TITLE) throw new HttpError(400, `Give the checklist a name (up to ${MAX_TITLE} characters).`);
    const days = [...new Set((Array.isArray(body?.days) ? body.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    const role = body?.assigneeRole === "supervisor" || body?.assigneeRole === "member" ? body.assigneeRole : null;
    const items = (Array.isArray(body?.items) ? body.items : [])
      .map((it) => (typeof it === "string" ? { text: it } : it || {}))
      .map((it) => ({ id: toId(it.id), text: clean(it.text) }))
      .filter((it) => it.text);
    if (!items.length) throw new HttpError(400, "Add at least one item to the checklist.");
    if (items.length > MAX_ITEMS) throw new HttpError(400, `A checklist can have up to ${MAX_ITEMS} items.`);
    if (items.some((it) => it.text.length > MAX_ITEM)) throw new HttpError(400, `Each item can be up to ${MAX_ITEM} characters.`);
    return { title, days: days.length === 7 ? [] : days, role, items };
  }

  async function checklistsWithItems(teamId, ids) {
    if (!ids.length) return new Map();
    const r = await pool.query(
      `SELECT id, checklist_id, text FROM team_checklist_items
        WHERE checklist_id = ANY($1::int[]) AND removed_at IS NULL ORDER BY position, id`,
      [ids]
    );
    const out = new Map();
    for (const row of r.rows) {
      if (!out.has(row.checklist_id)) out.set(row.checklist_id, []);
      out.get(row.checklist_id).push({ id: row.id, text: row.text });
    }
    return out;
  }

  // GET /api/team/work/checklists/today?date=YYYY-MM-DD — what the caller should do today
  router.get("/api/team/work/checklists/today", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      const day = dayFrom(req.query.date);
      const wd = weekdayOf(day);
      const lists = await pool.query(
        `SELECT id, title, assignee_role FROM team_checklists
          WHERE team_id = $1 AND archived_at IS NULL
            AND (cardinality(days) = 0 OR $2 = ANY(days))
            AND (assignee_role IS NULL OR assignee_role = $3 OR $4)
          ORDER BY id`,
        [m.team_id, wd, m.role, isManager(m.role)]
      );
      const ids = lists.rows.map((x) => x.id);
      const items = await checklistsWithItems(m.team_id, ids);
      const checks = ids.length
        ? (
            await pool.query(
              `SELECT c.item_id, c.checked_at, c.user_id, ${nameSql("u")} AS name
                 FROM team_checklist_checks c
                 JOIN team_checklist_items i ON i.id = c.item_id
                 LEFT JOIN users u ON u.id = c.user_id
                WHERE i.checklist_id = ANY($1::int[]) AND c.run_date = $2`,
              [ids, day]
            )
          ).rows
        : [];
      const checkOf = new Map(checks.map((c) => [c.item_id, c]));
      return res.json({
        success: true,
        date: day,
        checklists: lists.rows.map((l) => ({
          id: l.id,
          title: l.title,
          assigneeRole: l.assignee_role,
          items: (items.get(l.id) || []).map((it) => {
            const c = checkOf.get(it.id);
            return {
              id: it.id,
              text: it.text,
              done: !!c,
              doneBy: c ? { userId: c.user_id, name: c.name || "Former teammate" } : null,
              doneAt: c ? c.checked_at : null,
            };
          }),
        })),
      });
    } catch (err) {
      return fail(res, err, "Today's checklists");
    }
  });

  // POST /api/team/work/checklists/items/:itemId/check { date, done } — tick / untick
  router.post("/api/team/work/checklists/items/:itemId/check", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      const itemId = toId(req.params.itemId);
      const day = dayFrom(req.body?.date);
      const r = await pool.query(
        `SELECT l.id, l.days, l.assignee_role FROM team_checklist_items i
           JOIN team_checklists l ON l.id = i.checklist_id
          WHERE i.id = $1 AND i.removed_at IS NULL AND l.team_id = $2 AND l.archived_at IS NULL`,
        [itemId, m.team_id]
      );
      const l = r.rows[0];
      if (!l) throw new HttpError(404, "Checklist item not found.");
      if (l.assignee_role && l.assignee_role !== m.role && !isManager(m.role)) {
        throw new HttpError(403, "This checklist is for another role.");
      }
      if (l.days.length && !l.days.includes(weekdayOf(day))) throw new HttpError(400, "This checklist isn't scheduled for that day.");
      if (req.body?.done === false) {
        await pool.query(`DELETE FROM team_checklist_checks WHERE item_id = $1 AND run_date = $2`, [itemId, day]);
      } else {
        await pool.query(
          `INSERT INTO team_checklist_checks (item_id, run_date, user_id) VALUES ($1, $2, $3)
           ON CONFLICT (item_id, run_date) DO NOTHING`,
          [itemId, day, req.user.userId]
        );
      }
      notify(m.team_id, "checklists");
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Check item");
    }
  });

  // GET /api/team/work/checklists — managers: every list with its schedule, items and last-7-days completion
  router.get("/api/team/work/checklists", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      requireManager(m);
      const lists = await pool.query(
        `SELECT id, title, days, assignee_role, created_at FROM team_checklists
          WHERE team_id = $1 AND archived_at IS NULL ORDER BY id`,
        [m.team_id]
      );
      const ids = lists.rows.map((x) => x.id);
      const items = await checklistsWithItems(m.team_id, ids);
      // Completion over the last 7 scheduled days (today included)
      const stats = ids.length
        ? (
            await pool.query(
              `WITH days AS (
                 SELECT d::date AS day FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, interval '1 day') d
               ), due AS (
                 SELECT l.id AS checklist_id, days.day, i.id AS item_id
                   FROM team_checklists l
                   JOIN days ON (cardinality(l.days) = 0 OR EXTRACT(DOW FROM days.day)::int = ANY(l.days))
                              AND days.day >= l.created_at::date
                   JOIN team_checklist_items i ON i.checklist_id = l.id AND i.removed_at IS NULL
                  WHERE l.id = ANY($1::int[])
               )
               SELECT due.checklist_id, COUNT(*) AS due, COUNT(c.item_id) AS done
                 FROM due LEFT JOIN team_checklist_checks c ON c.item_id = due.item_id AND c.run_date = due.day
                GROUP BY due.checklist_id`,
              [ids]
            )
          ).rows
        : [];
      const statOf = new Map(stats.map((s) => [s.checklist_id, s]));
      return res.json({
        success: true,
        checklists: lists.rows.map((l) => {
          const s = statOf.get(l.id);
          return {
            id: l.id,
            title: l.title,
            days: l.days,
            assigneeRole: l.assignee_role,
            items: items.get(l.id) || [],
            week: s ? { due: Number(s.due), done: Number(s.done) } : { due: 0, done: 0 },
          };
        }),
      });
    } catch (err) {
      return fail(res, err, "List checklists");
    }
  });

  // POST /api/team/work/checklists { title, days, assigneeRole, items } — managers
  router.post("/api/team/work/checklists", authenticateToken, async (req, res) => {
    let client = null;
    try {
      const m = await member(req);
      requireManager(m);
      const c = parseChecklist(req.body);
      client = await pool.connect(); // only once the request is valid
      await client.query("BEGIN");
      const r = await client.query(
        `INSERT INTO team_checklists (team_id, title, days, assignee_role, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [m.team_id, c.title, c.days, c.role, req.user.userId]
      );
      for (let i = 0; i < c.items.length; i++) {
        await client.query(`INSERT INTO team_checklist_items (checklist_id, text, position) VALUES ($1, $2, $3)`, [
          r.rows[0].id,
          c.items[i].text,
          i,
        ]);
      }
      await client.query("COMMIT");
      notify(m.team_id, "checklists");
      return res.json({ success: true, id: r.rows[0].id });
    } catch (err) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      return fail(res, err, "Create checklist");
    } finally {
      if (client) client.release();
    }
  });

  // PUT /api/team/work/checklists/:id { title, days, assigneeRole, items:[{id?, text}] } — managers.
  // Items keep their id (and history) when edited; removed ones are hidden, not deleted.
  router.put("/api/team/work/checklists/:id", authenticateToken, async (req, res) => {
    let client = null;
    try {
      const m = await member(req);
      requireManager(m);
      const id = toId(req.params.id);
      const c = parseChecklist(req.body);
      client = await pool.connect(); // only once the request is valid
      await client.query("BEGIN");
      const found = await client.query(
        `SELECT 1 FROM team_checklists WHERE id = $1 AND team_id = $2 AND archived_at IS NULL FOR UPDATE`,
        [id, m.team_id]
      );
      if (!found.rows.length) throw new HttpError(404, "Checklist not found.");
      await client.query(`UPDATE team_checklists SET title = $2, days = $3, assignee_role = $4 WHERE id = $1`, [
        id,
        c.title,
        c.days,
        c.role,
      ]);
      const existing = (await client.query(`SELECT id FROM team_checklist_items WHERE checklist_id = $1 AND removed_at IS NULL`, [id])).rows.map(
        (x) => x.id
      );
      const kept = [];
      for (let i = 0; i < c.items.length; i++) {
        const it = c.items[i];
        if (it.id && existing.includes(it.id)) {
          await client.query(`UPDATE team_checklist_items SET text = $2, position = $3 WHERE id = $1`, [it.id, it.text, i]);
          kept.push(it.id);
        } else {
          await client.query(`INSERT INTO team_checklist_items (checklist_id, text, position) VALUES ($1, $2, $3)`, [id, it.text, i]);
        }
      }
      const gone = existing.filter((x) => !kept.includes(x));
      if (gone.length) {
        await client.query(`UPDATE team_checklist_items SET removed_at = NOW() WHERE id = ANY($1::int[])`, [gone]);
      }
      await client.query("COMMIT");
      notify(m.team_id, "checklists");
      return res.json({ success: true });
    } catch (err) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      return fail(res, err, "Update checklist");
    } finally {
      if (client) client.release();
    }
  });

  // DELETE /api/team/work/checklists/:id — managers (archived; history stays for scores)
  router.delete("/api/team/work/checklists/:id", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      requireManager(m);
      const r = await pool.query(
        `UPDATE team_checklists SET archived_at = NOW() WHERE id = $1 AND team_id = $2 AND archived_at IS NULL RETURNING id`,
        [toId(req.params.id), m.team_id]
      );
      if (!r.rows.length) throw new HttpError(404, "Checklist not found.");
      notify(m.team_id, "checklists");
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Delete checklist");
    }
  });

  // ── tasks ──────────────────────────────────────────────────────────────────

  function taskOut(t, me, m) {
    return {
      id: t.id,
      title: t.title,
      notes: t.notes || "",
      dueDate: t.due_text || null, // read as text: a DATE parsed into JS can shift a day by time zone
      assignee: t.assignee_id ? { userId: t.assignee_id, name: t.assignee_name || "Former teammate" } : null,
      createdBy: t.created_by_name || null,
      createdAt: t.created_at,
      done: !!t.done_at,
      doneAt: t.done_at,
      doneBy: t.done_at ? t.done_by_name || "Former teammate" : null,
      canComplete: !t.assignee_id || t.assignee_id === me || isManager(m.role),
      canEdit: isManager(m.role),
    };
  }

  // GET /api/team/work/tasks?scope=mine|all — open tasks plus ones finished in the last 7 days
  router.get("/api/team/work/tasks", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      const me = req.user.userId;
      const all = req.query.scope === "all" && isManager(m.role);
      const r = await pool.query(
        `SELECT t.*, t.due_date::text AS due_text, ${nameSql("a")} AS assignee_name, ${nameSql("c")} AS created_by_name, ${nameSql("d")} AS done_by_name
           FROM team_tasks t
           LEFT JOIN users a ON a.id = t.assignee_id
           LEFT JOIN users c ON c.id = t.created_by
           LEFT JOIN users d ON d.id = t.done_by
          WHERE t.team_id = $1
            AND (t.done_at IS NULL OR t.done_at > NOW() - interval '7 days')
            ${all ? "" : "AND (t.assignee_id = $2 OR t.assignee_id IS NULL)"}
          ORDER BY (t.done_at IS NOT NULL), t.due_date NULLS LAST, t.id
          LIMIT 200`,
        all ? [m.team_id] : [m.team_id, me]
      );
      return res.json({ success: true, tasks: r.rows.map((t) => taskOut(t, me, m)) });
    } catch (err) {
      return fail(res, err, "List tasks");
    }
  });

  async function parseTask(m, body, partial) {
    const out = {};
    if (!partial || body.title !== undefined) {
      out.title = clean(body.title);
      if (!out.title || out.title.length > MAX_TITLE) throw new HttpError(400, `Give the task a name (up to ${MAX_TITLE} characters).`);
    }
    if (!partial || body.notes !== undefined) {
      out.notes = String(body.notes == null ? "" : body.notes).trim().slice(0, MAX_NOTES) || null;
    }
    if (!partial || body.assigneeId !== undefined) {
      out.assignee = body.assigneeId == null || body.assigneeId === "" ? null : toId(body.assigneeId);
      if (out.assignee) {
        const r = await pool.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`, [m.team_id, out.assignee]);
        if (!r.rows.length) throw new HttpError(400, "That person isn't on your team.");
      }
    }
    if (!partial || body.dueDate !== undefined) {
      out.due = body.dueDate ? String(body.dueDate) : null;
      if (out.due && !DATE_RE.test(out.due)) throw new HttpError(400, "Pick a valid due date.");
    }
    return out;
  }

  // POST /api/team/work/tasks { title, notes, assigneeId, dueDate } — managers
  router.post("/api/team/work/tasks", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      requireManager(m);
      const t = await parseTask(m, req.body || {}, false);
      const r = await pool.query(
        `INSERT INTO team_tasks (team_id, title, notes, assignee_id, due_date, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [m.team_id, t.title, t.notes, t.assignee, t.due, req.user.userId]
      );
      notify(m.team_id, "tasks");
      return res.json({ success: true, id: r.rows[0].id });
    } catch (err) {
      return fail(res, err, "Create task");
    }
  });

  // PATCH /api/team/work/tasks/:id { done } (who it's for, or managers) / { title, notes, assigneeId, dueDate } (managers)
  router.patch("/api/team/work/tasks/:id", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      const me = req.user.userId;
      const id = toId(req.params.id);
      const r = await pool.query(`SELECT * FROM team_tasks WHERE id = $1 AND team_id = $2`, [id, m.team_id]);
      const task = r.rows[0];
      if (!task) throw new HttpError(404, "Task not found.");
      const body = req.body || {};
      const editing = ["title", "notes", "assigneeId", "dueDate"].some((k) => body[k] !== undefined);
      if (editing) {
        requireManager(m);
        const t = await parseTask(m, body, true);
        await pool.query(
          `UPDATE team_tasks SET
             title = COALESCE($2, title),
             notes = CASE WHEN $3 THEN $4 ELSE notes END,
             assignee_id = CASE WHEN $5 THEN $6::int ELSE assignee_id END,
             due_date = CASE WHEN $7 THEN $8::date ELSE due_date END
           WHERE id = $1`,
          [id, t.title ?? null, t.notes !== undefined, t.notes ?? null, t.assignee !== undefined, t.assignee ?? null, t.due !== undefined, t.due ?? null]
        );
      }
      if (body.done !== undefined) {
        if (task.assignee_id && task.assignee_id !== me && !isManager(m.role)) {
          throw new HttpError(403, "This task is assigned to someone else.");
        }
        if (body.done) {
          await pool.query(`UPDATE team_tasks SET done_at = COALESCE(done_at, NOW()), done_by = COALESCE(done_by, $2) WHERE id = $1`, [id, me]);
        } else {
          await pool.query(`UPDATE team_tasks SET done_at = NULL, done_by = NULL WHERE id = $1`, [id]);
        }
      }
      notify(m.team_id, "tasks");
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Update task");
    }
  });

  // DELETE /api/team/work/tasks/:id — managers
  router.delete("/api/team/work/tasks/:id", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      requireManager(m);
      const r = await pool.query(`DELETE FROM team_tasks WHERE id = $1 AND team_id = $2 RETURNING id`, [toId(req.params.id), m.team_id]);
      if (!r.rows.length) throw new HttpError(404, "Task not found.");
      notify(m.team_id, "tasks");
      return res.json({ success: true });
    } catch (err) {
      return fail(res, err, "Delete task");
    }
  });

  // ── performance ────────────────────────────────────────────────────────────

  // GET /api/team/work/performance?days=7|30 — managers. Activity per person (owner excluded).
  router.get("/api/team/work/performance", authenticateToken, async (req, res) => {
    try {
      const m = await member(req);
      requireManager(m);
      const days = Number(req.query.days) === 30 ? 30 : 7;
      const r = await pool.query(
        `WITH people AS (
           SELECT tm.user_id, tm.role, tm.joined_at, ${nameSql("u")} AS name, u.avatar_url, u.last_login
             FROM team_members tm JOIN users u ON u.id = tm.user_id
            WHERE tm.team_id = $1 AND tm.role <> 'owner'
         )
         SELECT p.*,
           (SELECT COUNT(*) FROM team_checklist_checks c
              JOIN team_checklist_items i ON i.id = c.item_id
              JOIN team_checklists l ON l.id = i.checklist_id
             WHERE l.team_id = $1 AND c.user_id = p.user_id
               AND c.run_date > CURRENT_DATE - $2::int) AS items_checked,
           (SELECT COUNT(*) FROM team_tasks t
             WHERE t.team_id = $1 AND t.done_by = p.user_id AND t.done_at > NOW() - ($2 || ' days')::interval) AS tasks_done,
           (SELECT COUNT(*) FROM team_tasks t
             WHERE t.team_id = $1 AND t.done_by = p.user_id AND t.done_at > NOW() - ($2 || ' days')::interval
               AND (t.due_date IS NULL OR t.done_at::date <= t.due_date)) AS tasks_on_time,
           (SELECT COUNT(*) FROM team_tasks t
             WHERE t.team_id = $1 AND t.assignee_id = p.user_id AND t.done_at IS NULL
               AND t.due_date < CURRENT_DATE) AS tasks_overdue,
           (SELECT COUNT(*) FROM team_announcements a
             WHERE a.team_id = $1 AND a.created_at > NOW() - ($2 || ' days')::interval
               AND a.author_id IS DISTINCT FROM p.user_id AND a.created_at >= p.joined_at) AS ann_total,
           (SELECT COUNT(*) FROM team_announcements a
              JOIN team_announcement_reads x ON x.announcement_id = a.id AND x.user_id = p.user_id
             WHERE a.team_id = $1 AND a.created_at > NOW() - ($2 || ' days')::interval) AS ann_read
         FROM people p
         ORDER BY lower(p.name)`,
        [m.team_id, days]
      );
      const people = r.rows.map((p) => {
        const tasksDone = Number(p.tasks_done);
        const onTime = Number(p.tasks_on_time);
        const overdue = Number(p.tasks_overdue);
        const annTotal = Number(p.ann_total);
        const annRead = Math.min(Number(p.ann_read), annTotal);
        // Simple 0-100 score from what applies to this person (null when nothing does yet)
        const parts = [];
        if (tasksDone + overdue > 0) parts.push(onTime / (tasksDone + overdue));
        if (annTotal > 0) parts.push(annRead / annTotal);
        return {
          userId: p.user_id,
          name: p.name,
          avatarUrl: p.avatar_url,
          role: p.role,
          lastActive: p.last_login,
          itemsChecked: Number(p.items_checked),
          tasksDone,
          tasksOnTime: onTime,
          tasksOverdue: overdue,
          announcements: { read: annRead, total: annTotal },
          score: parts.length ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100) : null,
        };
      });
      return res.json({ success: true, days, people });
    } catch (err) {
      return fail(res, err, "Team performance");
    }
  });

  return router;
};

module.exports.ensureTeamWorkTables = ensureTeamWorkTables;
