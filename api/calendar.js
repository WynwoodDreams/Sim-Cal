import {createRequire as createNodeRequire} from 'node:module';const require=createNodeRequire(import.meta.url);

// server/handler.ts
import { createHash, timingSafeEqual, createHmac } from "node:crypto";

// server/storage.mjs
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, put, del, head, BlobNotFoundError, BlobPreconditionFailedError } from "@vercel/blob";
import { AsyncLocalStorage } from "node:async_hooks";

// server/seed.json
var seed_default = { posts: [], media: [], activity: [] };

// server/schema.mjs
var schema = "CREATE TABLE `activity` (\n	`id` text PRIMARY KEY NOT NULL,\n	`post` text NOT NULL,\n	`author` text NOT NULL,\n	`kind` text NOT NULL,\n	`body` text NOT NULL,\n	`created` text NOT NULL,\n	FOREIGN KEY (`post`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE INDEX `activity_by_post` ON `activity` (`post`,`created`);--> statement-breakpoint\nCREATE TABLE `media` (\n	`id` text PRIMARY KEY NOT NULL,\n	`post` text NOT NULL,\n	`name` text NOT NULL,\n	`mime` text NOT NULL,\n	`bytes` integer NOT NULL,\n	FOREIGN KEY (`post`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE INDEX `media_by_post` ON `media` (`post`);--> statement-breakpoint\nCREATE TABLE `posts` (\n	`id` text PRIMARY KEY NOT NULL,\n	`title` text NOT NULL,\n	`caption` text DEFAULT '' NOT NULL,\n	`platform` text NOT NULL,\n	`day` text NOT NULL,\n	`time` text NOT NULL,\n	`status` text NOT NULL,\n	`topic` text,\n	`revision` integer DEFAULT 1 NOT NULL,\n	`mutation` text NOT NULL,\n	`created` text NOT NULL,\n	`updated` text NOT NULL\n);\n--> statement-breakpoint\nCREATE INDEX `posts_by_day` ON `posts` (`day`,`time`);--> statement-breakpoint\nCREATE INDEX `posts_by_status` ON `posts` (`status`,`day`);--> statement-breakpoint\nCREATE UNIQUE INDEX `one_post_per_topic` ON `posts` (`topic`);";

// server/storage.mjs
var scope = new AsyncLocalStorage();
var privateRead = { access: "private", useCache: false };
var privateWrite = { access: "private", addRandomSuffix: false };
var stateKey = "calendar/state.sqlite";
async function withDatabase(handle) {
  const dir = mkdtempSync(join(tmpdir(), "sim-calendar-"));
  const path = join(dir, "calendar.sqlite");
  let db;
  try {
    let prepare = function(sql, args = []) {
      const stmt = db.prepare(sql);
      return {
        bind(...values) {
          return prepare(sql, values);
        },
        first() {
          return stmt.get(...args);
        },
        all() {
          return { results: stmt.all(...args) };
        },
        execute() {
          if (stmt.columns().length) return { results: stmt.all(...args), meta: { changes: 0 } };
          return { results: [], meta: { changes: stmt.run(...args).changes } };
        },
        async run() {
          const outcome = this.execute();
          await flush();
          return outcome;
        }
      };
    };
    let metadata;
    try {
      metadata = await head(stateKey);
    } catch (error) {
      if (!(error instanceof BlobNotFoundError)) throw error;
    }
    const state = metadata ? await get(stateKey, privateRead) : null;
    if (metadata && !state) throw new Error("Calendar state changed during read.");
    if (state) {
      const bytes = Buffer.from(await new Response(state.stream).arrayBuffer());
      if ((await head(stateKey)).etag !== metadata.etag) throw new Error("Calendar state changed during read.");
      writeFileSync(path, bytes);
    }
    db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    if (!state) {
      db.exec(schema);
      for (const table of ["posts", "media", "activity"]) {
        for (const row of seed_default[table]) {
          const cols = Object.keys(row);
          db.prepare("INSERT INTO " + table + " (" + cols.join(",") + ") VALUES (" + cols.map(() => "?").join(",") + ")").run(...Object.values(row));
        }
      }
    }
    let etag = metadata?.etag;
    async function flush() {
      try {
        const saved = await put(stateKey, readFileSync(path), { ...privateWrite, allowOverwrite: !!etag, ...etag ? { ifMatch: etag } : {} });
        etag = saved.etag;
      } catch (error) {
        console.error("Calendar storage write", error.name, error.message);
        if (error instanceof BlobPreconditionFailedError || /already exists/i.test(error.message)) {
          throw new Error("Another reviewer saved a change. Reload the calendar and try again.");
        }
        throw error;
      }
    }
    const database2 = { prepare, async batch(statements) {
      db.exec("BEGIN");
      let result;
      try {
        result = statements.map((stmt) => stmt.execute());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      if (result.some((r) => r.meta.changes)) await flush();
      return result;
    } };
    return await scope.run(database2, handle);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
var database = () => scope.getStore();
var bucket = () => ({
  async put(id, stream, options) {
    await put("media/" + id, stream, { ...privateWrite, contentType: options.httpMetadata.contentType });
  },
  async delete(ids) {
    if (ids.length) await del(ids.map((id) => "media/" + id));
  },
  async get(id, { range }) {
    const headers = range.get("range") ? { Range: range.get("range") } : {};
    const result = await get("media/" + id, { ...privateRead, headers });
    if (!result) return null;
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.headers.get("content-range") || "");
    return { body: result.stream, size: match ? Number(match[3]) : result.blob.size, range: match ? { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 } : void 0 };
  }
});

// server/roadmap.ts
async function viewRoadmap() {
  const file = await get("calendar/publishing-roadmap.png", privateRead);
  if (!file) return Response.json({ error: "Roadmap unavailable." }, { status: 404 });
  return new Response(file.stream, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

// src/lib/calendar.ts
var platforms = [
  "LinkedIn",
  "Facebook",
  "Instagram",
  "X",
  "YouTube"
];
var formats = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf"
};
var maxFile = 25 * 1024 * 1024;
var maxTotal = 32 * 1024 * 1024;
var maxFiles = 6;
function fileType(name, supplied) {
  const ext = name.toLowerCase().split(".").pop() || "";
  return formats[ext] && (!supplied || supplied === "application/octet-stream" || supplied === formats[ext] || ext === "m4v" && supplied === "video/x-m4v") ? formats[ext] : null;
}
function fileIssue(file) {
  if (!fileType(file.name, file.type))
    return "Choose a JPG, PNG, WebP, GIF, AVIF, MP4, MOV, WebM, or PDF file.";
  if (!file.size) return file.name + " is empty.";
  if (file.size > maxFile) return file.name + " exceeds 25 MB.";
  return "";
}
function dateOf(key) {
  return /* @__PURE__ */ new Date(key + "T12:00:00Z");
}
function dayKey(d) {
  return d.toISOString().slice(0, 10);
}
function validDay(key) {
  return typeof key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(key) && key >= "2000-01-01" && key <= "2100-12-31" && !Number.isNaN(dateOf(key).valueOf()) && dayKey(dateOf(key)) === key;
}
function validTime(t) {
  return typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}
var ideas = Object.entries({
  "01": "New Year greeting",
  "04": "Tech trends",
  "05": "Chapter news",
  "06": "By the Numbers",
  "07": "Member welcome",
  "08": "Member spotlight",
  "11": "Cybersecurity brief",
  "12": "Board update",
  "13": "Talent Brief",
  "14": "Chapter photos",
  "15": "Partner spotlight",
  "18": "MLK Day",
  "19": "Member news",
  "20": "AI in practice",
  "21": "Chapter update",
  "22": "Community story",
  "25": "By the Numbers",
  "26": "Member thank-you",
  "27": "Talent Brief",
  "28": "February preview",
  "29": "January recap"
}).map(([n, title]) => {
  const day = "2027-01-" + n;
  return { day, title, optional: [2, 4].includes(dateOf(day).getUTCDay()) };
}).sort((a, b) => a.day.localeCompare(b.day));

// server/calendar.ts
var Problem = class extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
  status;
};
function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
var uuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
  v
);
function stringField(v, limit, label, required = false) {
  if (typeof v !== "string" || v.length > limit || required && !v.trim())
    throw new Problem(
      "Enter a valid " + label + " (up to " + limit + " characters)."
    );
  return v.trim();
}
var counts = "(SELECT COUNT(*) FROM media m WHERE m.post=p.id) AS mediaCount, (SELECT COUNT(*) FROM activity a WHERE a.post=p.id AND a.kind IN ('comment','changes')) AS commentCount";
var fields = "p.id, p.title, p.platform, p.day, p.time, p.status, p.topic, p.revision, p.updated";
async function detail(id) {
  const db = database();
  const [p, m, a] = await db.batch([
    db.prepare(
      "SELECT " + fields + ",p.caption," + counts + " FROM posts p WHERE p.id=?"
    ).bind(id),
    db.prepare(
      "SELECT id,name,mime,bytes FROM media WHERE post=? ORDER BY rowid"
    ).bind(id),
    db.prepare(
      "SELECT id,author,kind,body,created FROM activity WHERE post=? ORDER BY created,rowid"
    ).bind(id)
  ]);
  if (!p.results.length)
    throw new Problem("This post could not be found.", 404);
  return { post: p.results[0], media: m.results, activity: a.results };
}
async function getCurrent(id) {
  const p = await database().prepare("SELECT id,status,revision,mutation FROM posts WHERE id=?").bind(id).first();
  if (!p) throw new Problem("This post could not be found.", 404);
  return p;
}
var conflict = () => new Problem(
  "Someone updated this post. Reopen it to see the latest version.",
  409
);
function checkRequest(req) {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin && new URL(origin).host !== req.headers.get("x-forwarded-host") && new URL(origin).host !== req.headers.get("host"))
    throw new Problem("Open the calendar and try again.", 403);
}
async function cleanup(ids) {
  if (!ids.length) return;
  try {
    await bucket().delete(ids);
  } catch (error) {
    console.error("Could not remove unused media", String(error));
  }
}
async function savePost(req, author, editId) {
  if (Number(req.headers.get("content-length") || 0) > maxTotal + 1024 * 1024)
    throw new Problem("Keep each post under 32 MB of new media.", 413);
  let fd;
  try {
    fd = await req.formData();
  } catch {
    throw new Problem(
      "The upload could not be read. Try selecting the files again."
    );
  }
  let data;
  try {
    data = JSON.parse(String(fd.get("post")));
  } catch {
    throw new Problem("The post details are missing.");
  }
  if (!data || !uuid(data.id) || !uuid(data.op) || editId && editId !== data.id)
    throw new Problem("Invalid post reference.");
  const db = database(), id = data.id;
  const prior = await db.prepare("SELECT id,revision,mutation FROM posts WHERE id=?").bind(id).first();
  if (prior && (!editId || prior.mutation === data.op))
    return json(await detail(id));
  if (editId && !prior) throw new Problem("This post could not be found.", 404);
  if (editId && data.revision !== prior?.revision) throw conflict();
  const title = stringField(data.title, 160, "post title", true), caption = stringField(data.caption || "", 12e3, "caption");
  if (!validDay(data.day) || !validTime(data.time))
    throw new Problem("Choose a valid date and Eastern time.");
  if (!platforms.includes(data.platform))
    throw new Problem("Choose a supported platform.");
  if (!["draft", "review"].includes(data.status))
    throw new Problem("Choose draft or submit for review.");
  const topic = data.topic || null;
  if (topic && !ideas.some((i) => i.day === topic))
    throw new Problem("Unknown January topic.");
  const files = fd.getAll("media").filter((f) => typeof f !== "string");
  const existing = editId ? (await db.prepare("SELECT id,name,mime,bytes FROM media WHERE post=?").bind(id).all()).results : [];
  if (!Array.isArray(data.keep) || !data.keep.every((m) => existing.some((x) => x.id === m)))
    throw new Problem("An attachment has changed. Reopen this post.", 409);
  const kept = new Set(data.keep);
  if (files.length + kept.size > maxFiles)
    throw new Problem("Choose up to six attachments for each post.");
  if (files.reduce((s, f) => s + f.size, 0) > maxTotal)
    throw new Problem("Keep each upload under 32 MB.", 413);
  for (const f of files) {
    const issue = fileIssue(f);
    if (issue) throw new Problem(issue);
  }
  const removed = existing.filter((m) => !kept.has(m.id)).map((m) => m.id);
  const added = [];
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const action = data.status === "review" ? "Submitted for review" : editId ? "Saved a revised draft" : "Created a draft";
  try {
    for (const f of files) {
      const asset = {
        id: crypto.randomUUID(),
        name: f.name.slice(0, 240),
        mime: fileType(f.name, f.type),
        bytes: f.size
      };
      await bucket().put(asset.id, f.stream(), {
        httpMetadata: { contentType: asset.mime }
      });
      added.push(asset);
    }
    const q = editId ? db.prepare(
      "UPDATE posts SET title=?,caption=?,platform=?,day=?,time=?,status=?,revision=revision+1,mutation=?,updated=? WHERE id=? AND revision=?"
    ).bind(
      title,
      caption,
      data.platform,
      data.day,
      data.time,
      data.status,
      data.op,
      now,
      id,
      data.revision
    ) : db.prepare(
      "INSERT INTO posts(id,title,caption,platform,day,time,status,topic,revision,mutation,created,updated) VALUES(?,?,?,?,?,?,?,?,1,?,?,?)"
    ).bind(
      id,
      title,
      caption,
      data.platform,
      data.day,
      data.time,
      data.status,
      topic,
      data.op,
      now,
      now
    );
    const statements = [q];
    const guard = " WHERE EXISTS (SELECT 1 FROM posts WHERE id=? AND mutation=?)";
    for (const m of added)
      statements.push(
        db.prepare(
          "INSERT INTO media(id,post,name,mime,bytes) SELECT ?,?,?,?,?" + guard
        ).bind(m.id, id, m.name, m.mime, m.bytes, id, data.op)
      );
    for (const m of removed)
      statements.push(
        db.prepare(
          "DELETE FROM media WHERE id=? AND post=? AND EXISTS (SELECT 1 FROM posts WHERE id=? AND mutation=?)"
        ).bind(m, id, id, data.op)
      );
    statements.push(
      db.prepare(
        "INSERT INTO activity(id,post,author,kind,body,created) SELECT ?,?,?,'event',?,?" + guard
      ).bind(data.op, id, author, action, now, id, data.op)
    );
    const outcome = await db.batch(statements);
    if (!outcome[0].meta.changes) throw conflict();
  } catch (error) {
    if (added.length) {
      const retained = await db.prepare("SELECT id FROM media WHERE post=?").bind(id).all();
      await cleanup(
        added.filter((m) => !retained.results.some((r) => r.id === m.id)).map((m) => m.id)
      );
    }
    const winner = await db.prepare("SELECT mutation FROM posts WHERE id=?").bind(id).first();
    if (winner && (!editId || winner.mutation === data.op))
      return json(await detail(id));
    if (String(error).includes("posts.topic"))
      throw new Problem(
        "Someone already turned this topic into a post. Refresh the calendar.",
        409
      );
    throw error;
  }
  await cleanup(removed);
  return json(await detail(id), editId ? 200 : 201);
}
async function review(req, id, author) {
  const data = await req.json();
  if (!uuid(data.op)) throw new Problem("Invalid review reference.");
  const p = await getCurrent(id);
  if (p.mutation === data.op) return json(await detail(id));
  if (p.revision !== data.revision) throw conflict();
  const steps = {
    draft: ["review"],
    review: ["approved", "changes"],
    changes: ["review"],
    approved: ["draft"]
  };
  if (!steps[p.status].includes(data.status))
    throw new Problem(
      "This review decision is unavailable for the current status.",
      409
    );
  const needNote = data.status === "changes";
  const note = needNote ? stringField(data.note, 4e3, "reason for the requested changes", true) : {
    approved: "Approved the post",
    review: "Submitted for review",
    draft: "Reopened as a draft"
  }[data.status];
  const db = database(), now = (/* @__PURE__ */ new Date()).toISOString();
  const [outcome] = await db.batch([
    db.prepare(
      "UPDATE posts SET status=?,revision=revision+1,updated=?,mutation=? WHERE id=? AND revision=?"
    ).bind(data.status, now, data.op, id, data.revision),
    db.prepare(
      "INSERT INTO activity(id,post,author,kind,body,created) SELECT ?,?,?,?,?,? FROM posts WHERE id=? AND mutation=?"
    ).bind(
      data.op,
      id,
      author,
      needNote ? "changes" : "event",
      note,
      now,
      id,
      data.op
    )
  ]);
  if (!outcome.meta.changes) throw conflict();
  return json(await detail(id));
}
async function comment(req, id, author) {
  const data = await req.json();
  if (!uuid(data.op)) throw new Problem("Invalid comment reference.");
  const body = stringField(data.body, 4e3, "comment", true);
  await getCurrent(id);
  await database().prepare(
    "INSERT INTO activity(id,post,author,kind,body,created) VALUES(?,?,?,'comment',?,?) ON CONFLICT(id) DO NOTHING"
  ).bind(data.op, id, author, body, (/* @__PURE__ */ new Date()).toISOString()).run();
  return json(await detail(id), 201);
}
async function remove(req, id) {
  const { revision } = await req.json();
  const p = await getCurrent(id);
  if (p.revision !== revision) throw conflict();
  const db = database();
  const media = (await db.prepare("SELECT id FROM media WHERE post=?").bind(id).all()).results;
  if (!(await db.prepare("DELETE FROM posts WHERE id=? AND revision=?").bind(id, revision).run()).meta.changes)
    throw conflict();
  await cleanup(media.map((m) => m.id));
  return json({ deleted: id });
}
async function readAsset(req, id) {
  const file = await database().prepare("SELECT * FROM media WHERE id=?").bind(id).first();
  if (!file) throw new Problem("Attachment not found.", 404);
  const object = await bucket().get(id, { range: req.headers });
  if (!object) throw new Problem("Attachment unavailable.", 404);
  const download = new URL(req.url).searchParams.has("download") || file.mime === "application/pdf";
  const headers = new Headers({
    "Content-Type": file.mime,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Accept-Ranges": "bytes",
    "Content-Disposition": (download ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(file.name)
  });
  if (object.range && "offset" in object.range && "length" in object.range && typeof object.range.offset === "number" && typeof object.range.length === "number" && req.headers.has("range")) {
    const { offset, length } = object.range;
    headers.set(
      "Content-Range",
      "bytes " + offset + "-" + (offset + length - 1) + "/" + object.size
    );
    headers.set("Content-Length", String(length));
    return new Response(object.body, {
      status: 206,
      headers
    });
  }
  headers.set("Content-Length", String(file.bytes));
  return new Response(object.body, { headers });
}
async function dispatch(req, ctx, who) {
  try {
    const parts = (await ctx.params).path || [];
    const [entity, id, operation] = parts;
    if (req.method !== "GET") checkRequest(req);
    if (req.method === "GET" && !parts.length) {
      const result = await database().prepare(
        "SELECT " + fields + ",'' AS caption," + counts + " FROM posts p ORDER BY p.day,p.time,p.created"
      ).all();
      return json({ posts: result.results, user: who });
    }
    if (entity === "posts" && parts.length === 1 && req.method === "POST")
      return await savePost(req, who);
    if (!uuid(id)) throw new Problem("Invalid post or attachment.", 404);
    if (entity === "media" && parts.length === 2 && req.method === "GET")
      return await readAsset(req, id);
    if (entity === "posts" && parts.length === 2) {
      if (req.method === "GET") return json(await detail(id));
      if (req.method === "PUT") return await savePost(req, who, id);
      if (req.method === "DELETE") return await remove(req, id);
    }
    if (entity === "posts" && parts.length === 3 && req.method === "POST") {
      if (operation === "review") return await review(req, id, who);
      if (operation === "comments") return await comment(req, id, who);
    }
    throw new Problem("Calendar action not found.", 404);
  } catch (error) {
    if (error instanceof Problem)
      return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError)
      return json({ error: "Invalid request." }, 400);
    console.error("Calendar request failed", String(error));
    return json(
      {
        error: "The calendar could not complete your request. Please try again."
      },
      500
    );
  }
}

// server/handler.ts
var uuid2 = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
var chunkSize = 2 * 1024 * 1024;
var json2 = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
function equal(a, b) {
  if (!a || !b) return false;
  const hash = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}
function session(key) {
  return key && createHmac("sha256", key).update("sim-cal-session-v1").digest("hex");
}
async function api(req) {
  const url = new URL(req.url);
  const path = (url.searchParams.get("route") ?? url.pathname.replace(/^\/api\/calendar\/?/, "")).split("/").filter(Boolean);
  const view = process.env.SIM_VIEW_KEY || "", edit = process.env.SIM_EDIT_KEY || "";
  if (req.method !== "GET" && req.headers.get("origin") && req.headers.get("origin") !== url.origin) return json2({ error: "Open the calendar to make changes." }, 403);
  const cookie = (req.headers.get("cookie") || "").match(/(?:^|;\s*)sim_session=([a-f0-9]+)/)?.[1] || "";
  // Open editing while testing: everyone can add, comment, approve and reject.
  // Set SIM_REQUIRE_EDIT_CODE=1 in Vercel to require the editor access code again.
  const writer = process.env.SIM_REQUIRE_EDIT_CODE !== "1" || equal(cookie, session(edit));
  if (path[0] === "access" && req.method === "POST") {
    const { code } = await req.json();
    const key = typeof code === "string" && (equal(code, view) ? view : equal(code, edit) ? edit : "");
    if (!key) return json2({ error: "That access code is incorrect." }, 401);
    const res = json2({ role: key === edit ? "editor" : "viewer" });
    res.headers.set("Set-Cookie", "sim_session=" + session(key) + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800");
    return res;
  }
  const openViewing = process.env.SIM_VIEW_WITHOUT_CODE === "1";
  if (!writer && !openViewing && !equal(cookie, session(view))) {
    return json2({ error: "Sign in to view the calendar." }, 401);
  }
  if (path[0] === "roadmap" && req.method === "GET") return viewRoadmap();
  if (path[0] === "access") return json2({ role: writer ? "editor" : "viewer" });
  if (req.method !== "GET" && !writer) return json2({ error: "An editor access code is required to change posts." }, 403);
  if (path[0] === "chunk" && req.method === "PUT") {
    const [, id, n] = path;
    if (!uuid2.test(id) || !/^([0-9]|1[0-2])$/.test(n)) return json2({ error: "Invalid upload." }, 400);
    const data = await req.arrayBuffer();
    if (!data.byteLength || data.byteLength > chunkSize) return json2({ error: "Invalid chunk size." }, 413);
    await put("staging/" + id + "/" + n, data, { ...privateWrite, ttlDays: 1 });
    return json2({ ok: true });
  }
  const staged = [];
  if (path[0] === "posts" && path.length <= 2 && /^(PUT|POST)$/.test(req.method) && req.headers.get("content-type")?.includes("application/json")) {
    const { post, uploads } = await req.json();
    if (!Array.isArray(uploads) || uploads.length > maxFiles) return json2({ error: "Invalid attachments." }, 400);
    const form = new FormData();
    form.append("post", JSON.stringify(post));
    let total = 0;
    for (const spec of uploads) {
      if (typeof spec.name !== "string" || !uuid2.test(spec.id) || !Number.isSafeInteger(spec.size) || spec.size <= 0 || spec.size > maxFile || fileIssue(spec) || (total += spec.size) > maxTotal) return json2({ error: "Invalid attachment." }, 400);
      const chunks = [];
      for (let n = 0; n < Math.ceil(spec.size / chunkSize); n++) {
        const key = "staging/" + spec.id + "/" + n;
        const item = await get(key, privateRead);
        if (!item) return json2({ error: "Upload incomplete. Select the file and retry." }, 409);
        const chunk = await new Response(item.stream).blob();
        if (chunk.size !== Math.min(chunkSize, spec.size - n * chunkSize)) return json2({ error: "Upload size changed." }, 409);
        staged.push(key);
        chunks.push(chunk);
      }
      form.append("media", new File(chunks, spec.name, { type: spec.type }));
    }
    req = new Request(req.url, { method: req.method, body: form });
  }
  const result = await withDatabase(() => dispatch(req, { params: Promise.resolve({ path }) }, writer ? "SIM editor" : "SIM viewer"));
  if (result.ok && staged.length) await del(staged).catch(() => {
  });
  return result;
}
var handler_default = { async fetch(req) {
  try {
    return await api(req);
  } catch (e) {
    console.error("Calendar request", e instanceof Error ? e.name : "failed");
    return json2({ error: "Could not complete the request. Refresh and try again." }, 503);
  }
} };
export {
  handler_default as default
};
