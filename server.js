'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const initSqlJs = require('sql.js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR   = process.env.DATA_DIR || __dirname;   // override on Render
const UPLOADS_DIR = path.join(DATA_DIR,   'uploads');
const PUBLIC_DIR  = path.join(__dirname,  'public');    // always next to server.js
const DB_PATH     = path.join(DATA_DIR,   'journal.db');

// ─── Ensure directories exist ─────────────────────────────────────────────────
[UPLOADS_DIR, PUBLIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Created: ${dir}`);
  }
});

// ─── sql.js bootstrap (async) ─────────────────────────────────────────────────
let db;   // will be the sql.js Database instance

async function initDatabase(SQL) {
  if (fs.existsSync(DB_PATH)) {
    // Load existing database from disk
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('🗄️  Loaded existing database from disk');
  } else {
    // Create a brand-new in-memory database
    db = new SQL.Database();
    console.log('🗄️  Created new database');
  }

  // Create table if it doesn't exist yet
  db.run(`
    CREATE TABLE IF NOT EXISTS clips (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clip_date   TEXT    NOT NULL UNIQUE,
      file_path   TEXT    NOT NULL,
      caption     TEXT    DEFAULT '',
      mime_type   TEXT    DEFAULT 'video/webm',
      created_at  TEXT    DEFAULT (datetime('now'))
    );
  `);

  // Persist immediately so the file exists on disk
  saveDatabase();
}

/** Write the in-memory database to disk after every mutation */
function saveDatabase() {
  try {
    const data = db.export();                 // Uint8Array
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    console.error('❌ Failed to save database:', err.message);
  }
}

// ─── Helper: run a SELECT and return rows as plain objects ────────────────────
function queryAll(sql, params = []) {
  const stmt   = db.prepare(sql);
  stmt.bind(params);
  const rows   = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDatabase();   // persist every mutation
}

// ─── Multer config ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const date = (req.body.clip_date || 'clip').replace(/[^0-9-]/g, '');
    const ext  = file.mimetype.includes('mp4') ? '.mp4' : '.webm';
    cb(null, `clip_${date}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },   // 50 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  },
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── API Routes ───────────────────────────────────────────────────────────────

/**
 * GET /api/clips
 * Query params:
 *   ?month=YYYY-MM        → clips for that month
 *   ?start=YYYY-MM-DD&end=YYYY-MM-DD  → clips in range
 *   (none)                → all clips
 */
app.get('/api/clips', (req, res) => {
  try {
    const { month, start, end } = req.query;
    let rows;

    if (month) {
      rows = queryAll(
        'SELECT * FROM clips WHERE clip_date LIKE ? ORDER BY clip_date ASC',
        [`${month}%`]
      );
    } else if (start && end) {
      rows = queryAll(
        'SELECT * FROM clips WHERE clip_date BETWEEN ? AND ? ORDER BY clip_date ASC',
        [start, end]
      );
    } else {
      rows = queryAll('SELECT * FROM clips ORDER BY clip_date ASC');
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/clips/:date   → single clip by YYYY-MM-DD
 */
app.get('/api/clips/:date', (req, res) => {
  try {
    const row = queryOne('SELECT * FROM clips WHERE clip_date = ?', [req.params.date]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/clips   (multipart/form-data)
 * Fields: clip_date (YYYY-MM-DD), caption (optional)
 * File:   video  (any video/* mimetype)
 */
app.post('/api/clips', upload.single('video'), (req, res) => {
  try {
    const { clip_date, caption } = req.body;

    if (!clip_date) {
      return res.status(400).json({ error: 'clip_date is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'video file is required' });
    }

    const filePath = `/uploads/${req.file.filename}`;

    // Check for an existing clip on this date
    const existing = queryOne('SELECT * FROM clips WHERE clip_date = ?', [clip_date]);

    if (existing) {
      // Delete old file
      const oldFilename = path.basename(existing.file_path);
      const oldFullPath = path.join(UPLOADS_DIR, oldFilename);
      if (fs.existsSync(oldFullPath)) {
        try { fs.unlinkSync(oldFullPath); } catch (_) { /* ignore */ }
      }
      // Update record
      run(
        `UPDATE clips
            SET file_path  = ?,
                caption    = ?,
                mime_type  = ?,
                created_at = datetime('now')
          WHERE clip_date  = ?`,
        [filePath, caption || '', req.file.mimetype, clip_date]
      );
    } else {
      // Insert new record
      run(
        `INSERT INTO clips (clip_date, file_path, caption, mime_type)
         VALUES (?, ?, ?, ?)`,
        [clip_date, filePath, caption || '', req.file.mimetype]
      );
    }

    const row = queryOne('SELECT * FROM clips WHERE clip_date = ?', [clip_date]);
    res.json({ success: true, clip: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/clips/:date   → update caption only
 * Body: { caption: "string" }
 */
app.patch('/api/clips/:date', (req, res) => {
  try {
    const existing = queryOne('SELECT id FROM clips WHERE clip_date = ?', [req.params.date]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    run('UPDATE clips SET caption = ? WHERE clip_date = ?', [
      req.body.caption || '',
      req.params.date,
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/clips/:date
 */
app.delete('/api/clips/:date', (req, res) => {
  try {
    const existing = queryOne('SELECT * FROM clips WHERE clip_date = ?', [req.params.date]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    // Delete the video file
    const oldFilename = path.basename(existing.file_path);
    const oldFullPath = path.join(UPLOADS_DIR, oldFilename);
    if (fs.existsSync(oldFullPath)) {
      try { fs.unlinkSync(oldFullPath); } catch (_) { /* ignore */ }
    }

    run('DELETE FROM clips WHERE clip_date = ?', [req.params.date]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Catch-all → serve the SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
initSqlJs().then(SQL => {
  initDatabase(SQL).then(() => {
    app.listen(PORT, () => {
      console.log(`🎬 1 Second Everyday → http://localhost:${PORT}`);
    });
  });
}).catch(err => {
  console.error('Fatal: could not init sql.js', err);
  process.exit(1);
});