const { getDb, queryAll, requireAuth } = require('../lib/db');

module.exports = async (req, res) => {
  // Password check
  if (!requireAuth(req, res)) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    await getDb();

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

    res.status(200).json(rows);
  } catch (err) {
    console.error('clips error:', err);
    res.status(500).json({ error: err.message });
  }
};