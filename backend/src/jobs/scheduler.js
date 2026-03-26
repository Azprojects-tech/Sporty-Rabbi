import schedule from 'node-schedule';
import { fetchLiveMatches, syncMatchToDatabase } from '../services/matchService.js';

export function initScheduledJobs() {
  console.log('⏰ Initializing scheduled jobs...');

  // Poll live matches every 30 seconds
  schedule.scheduleJob('*/30 * * * * *', async () => {
    try {
      const liveMatches = await fetchLiveMatches();
      let synced = 0;

      for (const match of liveMatches) {
        await syncMatchToDatabase(match);
        synced++;
      }

      if (synced > 0) {
        console.log(`[Live Sync] Updated ${synced} live matches`);
      }
    } catch (error) {
      console.error('Error in live match sync job:', error.message);
    }
  });

  // Poll upcoming matches every 5 minutes
  schedule.scheduleJob('0 */5 * * * *', async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      console.log(`[Upcoming Sync] Checking matches for ${today}`);
      // In production, fetch upcoming matches by date
    } catch (error) {
      console.error('Error in upcoming match sync job:', error.message);
    }
  });

  console.log('✓ Scheduled jobs initialized');
}
