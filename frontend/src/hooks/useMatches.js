import { useState, useEffect } from 'react';
import apiService from '../services/api';

export function useLiveMatches() {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchMatches = async () => {
      try {
        setLoading(true);
        const response = await apiService.getLiveMatches();
        setMatches(response.data.data || []);
        setError(null);
      } catch (err) {
        setError(err.message);
        setMatches([]);
      } finally {
        setLoading(false);
      }
    };

    fetchMatches();
    const interval = setInterval(fetchMatches, 15000); // Refresh every 15 seconds
    return () => clearInterval(interval);
  }, []);

  return { matches, loading, error };
}

export function useBetStats() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await apiService.getBetStats();
        setStats(response.data);
      } catch (err) {
        console.error('Error fetching bet stats:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  return { stats, loading };
}

export function useMatchAnalysis(matchId) {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!matchId) return;

    const fetchAnalysis = async () => {
      try {
        const response = await apiService.getPreMatchAnalysis(matchId);
        setAnalysis(response.data.data);
      } catch (err) {
        console.error('Error fetching analysis:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchAnalysis();
  }, [matchId]);

  return { analysis, loading };
}
