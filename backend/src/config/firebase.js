import { createRequire } from 'module';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

let db = null;
let firebaseInitialized = false;

export function initFirebase() {
  if (firebaseInitialized) return db;

  try {
    const admin = require('firebase-admin');

    let credential;

    // 1. Try env var (Railway/production) — JSON string of the service account
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      credential = admin.credential.cert(serviceAccount);
      console.log('🔑 Firebase: using service account from env var');
    } else {
      // 2. Try local file (development)
      const serviceAccountPath = resolve(__dirname, '../../firebase-service-account.json');
      if (!existsSync(serviceAccountPath)) {
        console.warn('⚠️  firebase-service-account.json not found — running without Firestore persistence');
        return null;
      }
      const serviceAccount = require(serviceAccountPath);
      credential = admin.credential.cert(serviceAccount);
    }

    if (!admin.apps.length) {
      admin.initializeApp({ credential });
    }

    db = admin.firestore();
    firebaseInitialized = true;
    console.log('✅ Firestore connected (agent-47-5ff15)');
    return db;
  } catch (err) {
    console.error('❌ Firebase init failed:', err.message);
    return null;
  }
}

export function getDb() {
  return db;
}
