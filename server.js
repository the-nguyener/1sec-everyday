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
      media_type  TEXT    DEFAULT 'video',
      created_at  TEXT    DEFAULT (datetime('now'))
    );
  `);

  // Migration: add media_type column if upgrading an existing database
  try {
    const cols = queryAll("PRAGMA table_info(clips)");
    const hasMediaType = cols.some(c => c.name === 'media_type');
    if (!hasMediaType) {
      db.run("ALTER TABLE clips ADD COLUMN media_type TEXT DEFAULT 'video'");
      console.log('🔧 Migrated database: added media_type column');
    }
  } catch (e) {
    console.warn('Migration check failed:', e.message);
  }

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
    const mime = (file.mimetype || '').toLowerCase();
    const originalExt = path.extname(file.originalname || '').toLowerCase();

    let ext = '.webm'; // safe default for video blobs
    // Video types
    if (mime.includes('mp4'))            ext = '.mp4';
    else if (mime.includes('quicktime')) ext = '.mov';
    else if (mime.includes('3gpp'))      ext = '.3gp';
    else if (mime.includes('matroska'))  ext = '.mkv';
    else if (mime.includes('webm'))      ext = '.webm';
    // Image types
    else if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg';
    else if (mime.includes('png'))       ext = '.png';
    else if (mime.includes('gif'))       ext = '.gif';
    else if (mime.includes('webp'))      ext = '.webp';
    else if (mime.includes('heic'))      ext = '.heic';
    else if (mime.includes('heif'))      ext = '.heif';
    // Fall back to the original extension if we have one
    else if (originalExt && originalExt !== '.') ext = originalExt;

    cb(null, `clip_${date}_${Date.now()}${ext}`);
  },
});

const ALLOWED_MIME_TYPES = new Set([
  'video/webm',
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/mkv',
  'video/ogg',
  'video/3gpp',
  'video/3gpp2',
  'video/x-msvideo',
  'video/mpeg',
  'video/avi',
]);

const ALLOWED_EXTENSIONS = new Set([
  // Video
  '.webm', '.mp4', '.mov', '.mkv', '.ogg', '.3gp', '.avi', '.mpeg', '.mpg',
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp',
]);

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase().trim();
    const ext  = path.extname(file.originalname || '').toLowerCase();

    // Trust the extension first (Samsung/Android report wrong MIME types)
    if (ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);

    // Accept genuine video/* or image/* mime types
    if (mime.startsWith('video/')) return cb(null, true);
    if (mime.startsWith('image/')) return cb(null, true);

    // No extension + generic mime — accept (raw blob)
    if (!ext && (!mime || mime === 'application/octet-stream' || mime === 'text/plain')) {
      return cb(null, true);
    }

    console.warn(`Rejected file: mime="${mime}", ext="${ext}", name="${file.originalname}"`);
    cb(new Error(`Unsupported file type: ${mime || 'unknown'}`));
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

    if (!clip_date) return res.status(400).json({ error: 'clip_date is required' });
    if (!req.file)  return res.status(400).json({ error: 'file is required' });

    const filePath = `/uploads/${req.file.filename}`;

    // Determine media type from mime OR file extension
        const mime = (req.file.mimetype || '').toLowerCase();
    const savedExt = path.extname(req.file.filename).toLowerCase();
    const origExt = path.extname(req.file.originalname || '').toLowerCase();
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp'];
    const isImage =
      mime.startsWith('image/') ||
      imageExts.includes(savedExt) ||
      imageExts.includes(origExt);
    const mediaType = isImage ? 'image' : 'video';
    console.log(`Saved ${mediaType}: mime="${mime}", savedExt="${savedExt}", origExt="${origExt}"`);

    const existing = queryOne('SELECT * FROM clips WHERE clip_date = ?', [clip_date]);

    if (existing) {
      const oldFullPath = path.join(UPLOADS_DIR, path.basename(existing.file_path));
      if (fs.existsSync(oldFullPath)) {
        try { fs.unlinkSync(oldFullPath); } catch (_) {}
      }
      run(
        `UPDATE clips
            SET file_path = ?, caption = ?, mime_type = ?, media_type = ?,
                created_at = datetime('now')
          WHERE clip_date = ?`,
        [filePath, caption || '', req.file.mimetype, mediaType, clip_date]
      );
    } else {
      run(
        `INSERT INTO clips (clip_date, file_path, caption, mime_type, media_type)
         VALUES (?, ?, ?, ?, ?)`,
        [clip_date, filePath, caption || '', req.file.mimetype, mediaType]
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