import express from 'express';
import { analyzePreMatch, detectInPlayOpportunities, scoreBetSelection } from '../services/analyticsService.js';
import { getOne } from '../config/database.js';

const router = express.Router();

// GET /api/analytics/match/:id - Get pre-match analysis
router.get('/match/:id', async (req, res) => {
  try {
    const analysis = await analyzePreMatch(req.params.id);

    if (!analysis) {
      return res.status(404).json({ success: false, error: 'Match not found' });
    }

    res.json({
      success: true,
      data: analysis,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/analytics/in-play/:id - Get in-play opportunities
router.get('/in-play/:id', async (req, res) => {
  try {
    const opportunities = await detectInPlayOpportunities(req.params.id);

    res.json({
      success: true,
      opportunities,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/analytics/score - Score a bet selection
router.post('/score', async (req, res) => {
  try {
    const { bet_type, home_team, away_team, match_id } = req.body;

    const match = await getOne('SELECT * FROM matches WHERE id = $1', [match_id]);

    if (!match) {
      return res.status(404).json({ success: false, error: 'Match not found' });
    }

    const score = scoreBetSelection(bet_type, home_team, away_team, {
      home_possession: match.home_possession,
      away_possession: match.away_possession,
      home_shots_on_target: match.home_shots_on_target,
      away_shots_on_target: match.away_shots_on_target,
      home_xg: match.home_xg,
      away_xg: match.away_xg,
    });

    res.json({
      success: true,
      bet_type,
      confidence_score: score,
      recommendation: score > 70 ? 'strong' : score > 60 ? 'moderate' : 'weak',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
