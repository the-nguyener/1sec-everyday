require('dotenv').config();

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const initSqlJs = require('sql.js');

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Paths ──────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

// ─── Cloudflare R2 Configuration ────────────────────────────────
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET     = process.env.R2_BUCKET || '1sec-everyday';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;   // https://pub-xxxx.r2.dev
const R2_ENDPOINT   = process.env.R2_ENDPOINT;     // https://<acct>.r2.cloudflarestorage.com

const DB_KEY = 'database/journal.db';

const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
});

// Upload a buffer to R2, returns the public URL
async function uploadToR2(key, buffer, contentType) {
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return `${R2_PUBLIC_URL}/${key}`;
}

// Delete an object from R2 by key
async function deleteFromR2(key) {
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (e) {
    console.warn('R2 delete failed:', e.message);
  }
}

// Download an object from R2 as a Buffer
async function downloadFromR2(key) {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (e) {
    return null;
  }
}

// ─── sql.js bootstrap ───────────────────────────────────────────
let db;

async function initDatabase(SQL) {
  const dbBuffer = await downloadFromR2(DB_KEY);

  if (dbBuffer) {
    db = new SQL.Database(dbBuffer);
    console.log('🗄️  Loaded existing database from R2');
  } else {
    db = new SQL.Database();
    console.log('🗄️  Created new database (none found in R2)');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS clips (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clip_date   TEXT    NOT NULL UNIQUE,
      file_path   TEXT    NOT NULL,
      file_key    TEXT    DEFAULT '',
      caption     TEXT    DEFAULT '',
      mime_type   TEXT    DEFAULT 'video/webm',
      media_type  TEXT    DEFAULT 'video',
      created_at  TEXT    DEFAULT (datetime('now'))
    );
  `);

  // Migration: add columns if upgrading an existing database
  try {
    const cols = queryAll("PRAGMA table_info(clips)");
    if (!cols.some(c => c.name === 'file_key')) {
      db.run("ALTER TABLE clips ADD COLUMN file_key TEXT DEFAULT ''");
      console.log('🔧 Migrated: added file_key column');
    }
    if (!cols.some(c => c.name === 'media_type')) {
      db.run("ALTER TABLE clips ADD COLUMN media_type TEXT DEFAULT 'video'");
      console.log('🔧 Migrated: added media_type column');
    }
  } catch (e) {
    console.warn('Migration check failed:', e.message);
  }

  await saveDatabaseToR2();
}

// Export the in-memory database and upload it to R2
async function saveDatabaseToR2() {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    await uploadToR2(DB_KEY, buffer, 'application/octet-stream');
  } catch (err) {
    console.error('❌ Failed to save database to R2:', err.message);
  }
}

// ─── Query helpers ──────────────────────────────────────────────
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
  // Persistence to R2 is handled explicitly by each route via saveDatabaseToR2()
}

// ─── Multer (memory storage → R2) ───────────────────────────────
const storage = multer.memoryStorage();

const ALLOWED_EXTENSIONS = new Set([
  '.webm', '.mp4', '.mov', '.mkv', '.ogg', '.3gp', '.avi', '.mpeg', '.mpg',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp',
]);

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase().trim();
    const ext  = path.extname(file.originalname || '').toLowerCase();

    if (ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
    if (mime.startsWith('video/'))   return cb(null, true);
    if (mime.startsWith('image/'))   return cb(null, true);
    if (!ext && (!mime || mime === 'application/octet-stream' || mime === 'text/plain')) {
      return cb(null, true);
    }

    console.warn(`Rejected file: mime="${mime}", ext="${ext}", name="${file.originalname}"`);
    cb(new Error(`Unsupported file type: ${mime || 'unknown'}`));
  },
});

// ─── Middleware ─────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// Password protection (HTTP Basic Auth)
const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme';
app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const [, password] = decoded.split(':');
    if (password === APP_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="1 Second Everyday"');
  res.status(401).send('Authentication required');
});

app.use(express.static(PUBLIC_DIR));

// ─── API Routes ─────────────────────────────────────────────────

app.get('/api/clips', (req, res) => {
  try {
    const { month, start, end } = req.query;
    let rows;
    if (month) {
      rows = queryAll('SELECT * FROM clips WHERE clip_date LIKE ? ORDER BY clip_date ASC', [`${month}%`]);
    } else if (start && end) {
      rows = queryAll('SELECT * FROM clips WHERE clip_date BETWEEN ? AND ? ORDER BY clip_date ASC', [start, end]);
    } else {
      rows = queryAll('SELECT * FROM clips ORDER BY clip_date ASC');
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clips/:date', (req, res) => {
  try {
    const row = queryOne('SELECT * FROM clips WHERE clip_date = ?', [req.params.date]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clips', upload.single('video'), async (req, res) => {
  try {
    const { clip_date, caption } = req.body;
    if (!clip_date) return res.status(400).json({ error: 'clip_date is required' });
    if (!req.file)  return res.status(400).json({ error: 'file is required' });

    const mime = (req.file.mimetype || '').toLowerCase();
    const origExt = path.extname(req.file.originalname || '').toLowerCase();

    let ext = '.webm';
    if (mime.includes('mp4'))            ext = '.mp4';
    else if (mime.includes('quicktime')) ext = '.mov';
    else if (mime.includes('3gpp'))      ext = '.3gp';
    else if (mime.includes('matroska'))  ext = '.mkv';
    else if (mime.includes('webm'))      ext = '.webm';
    else if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg';
    else if (mime.includes('png'))       ext = '.png';
    else if (mime.includes('gif'))       ext = '.gif';
    else if (mime.includes('webp'))      ext = '.webp';
    else if (mime.includes('heic'))      ext = '.heic';
    else if (mime.includes('heif'))      ext = '.heif';
    else if (origExt && origExt !== '.') ext = origExt;

    const cleanDate = clip_date.replace(/[^0-9-]/g, '');
    const key = `clips/clip_${cleanDate}_${Date.now()}${ext}`;

    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp'];
    const isImage = mime.startsWith('image/') || imageExts.includes(ext) || imageExts.includes(origExt);
    const mediaType = isImage ? 'image' : 'video';

    const publicUrl = await uploadToR2(key, req.file.buffer, req.file.mimetype);

    const existing = queryOne('SELECT * FROM clips WHERE clip_date = ?', [clip_date]);
    if (existing && existing.file_key) {
      await deleteFromR2(existing.file_key);
    }

    if (existing) {
            run(
        `UPDATE clips
            SET file_path = ?, file_key = ?, caption = ?, mime_type = ?, media_type = ?,
                created_at = datetime('now')
          WHERE clip_date = ?`,
        [publicUrl, key, caption || '', req.file.mimetype, mediaType, clip_date]
      );
    } else {
      run(
        `INSERT INTO clips (clip_date, file_path, file_key, caption, mime_type, media_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [clip_date, publicUrl, key, caption || '', req.file.mimetype, mediaType]
      );
    }

    await saveDatabaseToR2();

    const row = queryOne('SELECT * FROM clips WHERE clip_date = ?', [clip_date]);
    res.json({ success: true, clip: row });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/clips/:date', async (req, res) => {
  try {
    const existing = queryOne('SELECT id FROM clips WHERE clip_date = ?', [req.params.date]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    run('UPDATE clips SET caption = ? WHERE clip_date = ?', [
      req.body.caption || '',
      req.params.date,
    ]);
    await saveDatabaseToR2();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clips/:date', async (req, res) => {
  try {
    const existing = queryOne('SELECT * FROM clips WHERE clip_date = ?', [req.params.date]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    if (existing.file_key) {
      await deleteFromR2(existing.file_key);
    }

    run('DELETE FROM clips WHERE clip_date = ?', [req.params.date]);
    await saveDatabaseToR2();

    res.json({ success: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Catch-all → serve the SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ─── Start ──────────────────────────────────────────────────────
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