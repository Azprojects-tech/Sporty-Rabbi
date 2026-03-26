import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { testConnection } from './config/database.js';
import { initDatabase } from './db/schema.js';
import { initScheduledJobs } from './jobs/scheduler.js';
import matchRoutes from './routes/matches.js';
import analyticsRoutes from './routes/analytics.js';
import betRoutes from './routes/bets.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
}));
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/matches', matchRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/bets', betRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// Initialize server
async function startServer() {
  try {
    // Test database connection
    console.log('🔌 Testing database connection...');
    const connected = await testConnection();

    if (!connected) {
      throw new Error('Database connection failed');
    }

    // Initialize database schema
    console.log('📦 Initializing database...');
    await initDatabase();

    // Start scheduled jobs (live data sync)
    initScheduledJobs();

    // Start Express server
    app.listen(PORT, () => {
      console.log(`\n✨ SportyRabbi Backend running on port ${PORT}`);
      console.log(`📊 Dashboard: http://localhost:5173`);
      console.log(`🔗 API: http://localhost:${PORT}/api`);
      console.log(`💓 Health check: GET http://localhost:${PORT}/api/health\n`);
    });
  } catch (error) {
    console.error('\n❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();
