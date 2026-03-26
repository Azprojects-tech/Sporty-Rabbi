import { getAll, query } from '../config/database.js';

export async function initDatabase() {
  console.log('🔄 Initializing database schema...');

  // Create leagues table
  await query(`
    CREATE TABLE IF NOT EXISTS leagues (
      id SERIAL PRIMARY KEY,
      api_id INT UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      country VARCHAR(50),
      logo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Create teams table
  await query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      api_id INT UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      logo_url TEXT,
      country VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Create matches table
  await query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      api_id INT UNIQUE NOT NULL,
      league_id INT REFERENCES leagues(id),
      home_team_id INT REFERENCES teams(id),
      away_team_id INT REFERENCES teams(id),
      home_team_name VARCHAR(100),
      away_team_name VARCHAR(100),
      status VARCHAR(20),
      kickoff_time TIMESTAMP,
      home_goals INT,
      away_goals INT,
      home_possession FLOAT,
      away_possession FLOAT,
      home_shots INT,
      away_shots INT,
      home_shots_on_target INT,
      away_shots_on_target INT,
      home_xg FLOAT,
      away_xg FLOAT,
      updated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Create odds table
  await query(`
    CREATE TABLE IF NOT EXISTS odds (
      id SERIAL PRIMARY KEY,
      match_id INT REFERENCES matches(id),
      home_win FLOAT,
      draw FLOAT,
      away_win FLOAT,
      over_2_5 FLOAT,
      under_2_5 FLOAT,
      both_teams_score FLOAT,
      over_0_5 FLOAT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Create bets table (user-logged bets)
  await query(`
    CREATE TABLE IF NOT EXISTS bets (
      id SERIAL PRIMARY KEY,
      match_id INT REFERENCES matches(id),
      bet_type VARCHAR(50),
      selection VARCHAR(200),
      odds FLOAT,
      stake FLOAT,
      status VARCHAR(20) DEFAULT 'pending',
      result VARCHAR(20),
      return_amount FLOAT,
      placed_at TIMESTAMP DEFAULT NOW(),
      resolved_at TIMESTAMP,
      notes TEXT
    );
  `);

  // Create alerts table
  await query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      match_id INT REFERENCES matches(id),
      alert_type VARCHAR(50),
      title VARCHAR(200),
      description TEXT,
      confidence_score FLOAT,
      recommended_bet VARCHAR(200),
      trigger_data JSONB,
      sent_at TIMESTAMP DEFAULT NOW(),
      whatsapp_sent BOOLEAN DEFAULT FALSE,
      seen BOOLEAN DEFAULT FALSE
    );
  `);

  console.log('✓ Database schema initialized successfully');
}
