import express from 'express';
import { query, getAll, getOne } from '../config/database.js';

const router = express.Router();

// POST /api/bets - Log a bet
router.post('/', async (req, res) => {
  try {
    const { match_id, bet_type, selection, odds, stake, notes } = req.body;

    const result = await query(
      `INSERT INTO bets (match_id, bet_type, selection, odds, stake, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *;`,
      [match_id, bet_type, selection, odds, stake, notes],
    );

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/bets/history - Get bet history
router.get('/history', async (req, res) => {
  try {
    const bets = await getAll(
      `SELECT b.*, m.home_team_name, m.away_team_name, m.home_goals, m.away_goals
       FROM bets b
       LEFT JOIN matches m ON b.match_id = m.id
       ORDER BY b.placed_at DESC LIMIT 100;`,
      [],
    );

    res.json({
      success: true,
      data: bets,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/bets/stats - Get bet performance stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await getOne(
      `SELECT 
        COUNT(*) as total_bets,
        SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as losses,
        SUM(stake) as total_staked,
        SUM(CASE WHEN status = 'won' THEN return_amount ELSE 0 END) as total_returns,
        ROUND(SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100, 2) as win_rate
       FROM bets
       WHERE status IS NOT NULL;`,
      [],
    );

    const byType = await getAll(
      `SELECT 
        bet_type,
        COUNT(*) as count,
        SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as wins,
        ROUND(SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100, 2) as win_rate
       FROM bets
       WHERE status IS NOT NULL
       GROUP BY bet_type
       ORDER BY count DESC;`,
      [],
    );

    res.json({
      success: true,
      overall_stats: stats,
      by_type: byType,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/bets/:id - Update bet result
router.patch('/:id', async (req, res) => {
  try {
    const { status, result, return_amount } = req.body;

    const updated = await query(
      `UPDATE bets SET status = $1, result = $2, return_amount = $3, resolved_at = NOW()
       WHERE id = $4
       RETURNING *;`,
      [status, result, return_amount, req.params.id],
    );

    res.json({
      success: true,
      data: updated.rows[0],
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
