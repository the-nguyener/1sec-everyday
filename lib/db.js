const initSqlJs = require('sql.js');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');

// ─── Cloudflare R2 Configuration ────────────────────────────────
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET     = process.env.R2_BUCKET || '1sec-everyday';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const R2_ENDPOINT   = process.env.R2_ENDPOINT;

const DB_KEY = 'database/journal.db';

const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
});

// ─── R2 Helpers ─────────────────────────────────────────────────
async function uploadToR2(key, buffer, contentType) {
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return `${R2_PUBLIC_URL}/${key}`;
}

async function deleteFromR2(key) {
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (e) {
    console.warn('R2 delete failed:', e.message);
  }
}

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

// ─── Database (sql.js) — reloaded per invocation with light caching ─
let SQL = null;   // the sql.js WASM module (cached across warm invocations)
let db  = null;   // the current database instance

async function getDb() {
  // Initialize the sql.js WASM module once (cached while function stays warm)
  if (!SQL) {
    SQL = await initSqlJs();
  }

  // Load the database from R2 fresh each time to stay in sync across functions
  const dbBuffer = await downloadFromR2(DB_KEY);
  if (dbBuffer) {
    db = new SQL.Database(dbBuffer);
  } else {
    db = new SQL.Database();
  }

  // Ensure schema exists
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

  // Migrations for older databases
  try {
    const cols = queryAll("PRAGMA table_info(clips)");
    if (!cols.some(c => c.name === 'file_key')) {
      db.run("ALTER TABLE clips ADD COLUMN file_key TEXT DEFAULT ''");
    }
    if (!cols.some(c => c.name === 'media_type')) {
      db.run("ALTER TABLE clips ADD COLUMN media_type TEXT DEFAULT 'video'");
    }
  } catch (e) {
    console.warn('Migration check failed:', e.message);
  }

  return db;
}

// Save the current database back to R2
async function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  await uploadToR2(DB_KEY, buffer, 'application/octet-stream');
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
}

// ─── Password check helper ──────────────────────────────────────
function checkAuth(req) {
  const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme';
  const auth = req.headers.authorization || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const [, password] = decoded.split(':');
    return password === APP_PASSWORD;
  }
  return false;
}

function requireAuth(req, res) {
  if (!checkAuth(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="1 Second Everyday"');
    res.status(401).send('Authentication required');
    return false;
  }
  return true;
}

// ─── Helper to pick file extension from mime ────────────────────
function extFromMime(mime, origExt) {
  mime = (mime || '').toLowerCase();
  if (mime.includes('mp4'))            return '.mp4';
  if (mime.includes('quicktime'))      return '.mov';
  if (mime.includes('3gpp'))           return '.3gp';
  if (mime.includes('matroska'))       return '.mkv';
  if (mime.includes('webm'))           return '.webm';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('png'))            return '.png';
  if (mime.includes('gif'))            return '.gif';
  if (mime.includes('webp'))           return '.webp';
  if (mime.includes('heic'))           return '.heic';
  if (mime.includes('heif'))           return '.heif';
  if (origExt && origExt !== '.')      return origExt;
  return '.webm';
}

function isImageType(mime, ext) {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp'];
  return (mime || '').toLowerCase().startsWith('image/') || imageExts.includes(ext);
}

// ─── Exports ────────────────────────────────────────────────────
module.exports = {
  getDb,
  saveDb,
  queryAll,
  queryOne,
  run,
  uploadToR2,
  deleteFromR2,
  downloadFromR2,
  requireAuth,
  extFromMime,
  isImageType,
};