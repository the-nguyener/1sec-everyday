const formidable = require('formidable');
const fs = require('fs');
const path = require('path');
const {
  getDb, saveDb, queryOne, run,
  uploadToR2, deleteFromR2, requireAuth,
  extFromMime, isImageType,
} = require('../lib/db');

// Tell Vercel NOT to parse the body — formidable needs the raw stream
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = async (req, res) => {
  // Password check
  if (!requireAuth(req, res)) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Parse the multipart form
    const { fields, file } = await parseForm(req);

    const clip_date = Array.isArray(fields.clip_date) ? fields.clip_date[0] : fields.clip_date;
    const caption   = Array.isArray(fields.caption)   ? fields.caption[0]   : (fields.caption || '');

    if (!clip_date) {
      res.status(400).json({ error: 'clip_date is required' });
      return;
    }
    if (!file) {
      res.status(400).json({ error: 'file is required' });
      return;
    }

    // Read the uploaded file into a buffer
    const buffer = fs.readFileSync(file.filepath);
    const mime   = (file.mimetype || '').toLowerCase();
    const origExt = path.extname(file.originalFilename || '').toLowerCase();
    const ext    = extFromMime(mime, origExt);

    // Clean up the temp file
    try { fs.unlinkSync(file.filepath); } catch (_) {}

    // Build the R2 key
    const cleanDate = clip_date.replace(/[^0-9-]/g, '');
    const key = `clips/clip_${cleanDate}_${Date.now()}${ext}`;

    // Determine media type
    const mediaType = isImageType(mime, ext) ? 'image' : 'video';

    // Load the database
    await getDb();

    // Upload the file to R2
    const publicUrl = await uploadToR2(key, buffer, mime || 'application/octet-stream');

    // If a clip already exists for this date, delete its old R2 file
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
        [publicUrl, key, caption, mime, mediaType, clip_date]
      );
    } else {
      run(
        `INSERT INTO clips (clip_date, file_path, file_key, caption, mime_type, media_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [clip_date, publicUrl, key, caption, mime, mediaType]
      );
    }

    // Save the database back to R2
    await saveDb();

    const row = queryOne('SELECT * FROM clips WHERE clip_date = ?', [clip_date]);
    res.status(200).json({ success: true, clip: row });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Helper: parse multipart form with formidable ───────────────
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: 100 * 1024 * 1024, // 100MB
      keepExtensions: true,
    });

    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);

      // formidable v3 returns files as arrays
      let file = files.video;
      if (Array.isArray(file)) file = file[0];

      resolve({ fields, file });
    });
  });
}