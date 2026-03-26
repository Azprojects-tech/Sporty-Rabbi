import { initDatabase } from './schema.js';

async function migrate() {
  try {
    await initDatabase();
    console.log('✓ Migration complete');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
