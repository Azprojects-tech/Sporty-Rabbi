import express from 'express';
import { getStoredMatches, getMatchDetails, syncMatchToDatabase, fetchLiveMatches } from '../services/matchService.js';

const router = express.Router();

// GET /api/matches/live - Get all live matches
router.get('/live', async (req, res) => {
  try {
    const matches = await getStoredMatches({ status: 'LIVE' });
    res.json({
      success: true,
      count: matches.length,
      data: matches,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/matches/upcoming - Get upcoming matches
router.get('/upcoming', async (req, res) => {
  try {
    const matches = await getStoredMatches({ status: 'NOT_STARTED' });
    res.json({
      success: true,
      count: matches.length,
      data: matches,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/matches/finished - Get finished matches
router.get('/finished', async (req, res) => {
  try {
    const matches = await getStoredMatches({ status: 'FINISHED' });
    res.json({
      success: true,
      count: matches.length,
      data: matches,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/matches/:id - Get match details with analysis
router.get('/:id', async (req, res) => {
  try {
    const match = await getMatchDetails(req.params.id);

    if (!match) {
      return res.status(404).json({ success: false, error: 'Match not found' });
    }

    res.json({
      success: true,
      data: match,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/matches/sync - Sync live matches (internal)
router.post('/sync', async (req, res) => {
  try {
    const liveMatches = await fetchLiveMatches();
    let synced = 0;

    for (const match of liveMatches) {
      await syncMatchToDatabase(match);
      synced++;
    }

    res.json({
      success: true,
      synced,
      message: `Synced ${synced} matches from API-Football`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
