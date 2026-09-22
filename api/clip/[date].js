const {
  getDb, saveDb, queryOne, run,
  deleteFromR2, requireAuth,
} = require('../../lib/db');

module.exports = async (req, res) => {
  // Password check
  if (!requireAuth(req, res)) return;

  const date = req.query.date;
  if (!date) {
    res.status(400).json({ error: 'date is required' });
    return;
  }

  try {
    await getDb();

    // ── GET: fetch a single clip ──────────────────────────────
    if (req.method === 'GET') {
      const row = queryOne('SELECT * FROM clips WHERE clip_date = ?', [date]);
      if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.status(200).json(row);
      return;
    }

    // ── PATCH: update caption ─────────────────────────────────
    if (req.method === 'PATCH') {
      const existing = queryOne('SELECT id FROM clips WHERE clip_date = ?', [date]);
      if (!existing) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const caption = (req.body && req.body.caption) || '';
      run('UPDATE clips SET caption = ? WHERE clip_date = ?', [caption, date]);
      await saveDb();
      res.status(200).json({ success: true });
      return;
    }

    // ── DELETE: remove clip + its R2 file ─────────────────────
    if (req.method === 'DELETE') {
      const existing = queryOne('SELECT * FROM clips WHERE clip_date = ?', [date]);
      if (!existing) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (existing.file_key) {
        await deleteFromR2(existing.file_key);
      }
      run('DELETE FROM clips WHERE clip_date = ?', [date]);
      await saveDb();
      res.status(200).json({ success: true });
      return;
    }

    // ── Any other method ──────────────────────────────────────
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('clip[date] error:', err);
    res.status(500).json({ error: err.message });
  }
};