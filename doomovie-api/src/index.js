require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { initDb }     = require('./db');
const routes         = require('./routes');
const { startCron }  = require('./scrapers/run');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Request logger (dev-friendly) ───────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${req.path}`);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', routes);

// Root — quick status check
app.get('/', (_req, res) => {
  res.json({
    name:    'doomovie.today API',
    version: '1.0.0',
    docs:    'https://github.com/yourusername/doomovie-api',
    endpoints: [
      'GET /api/health',
      'GET /api/cinemas',
      'GET /api/cinemas?lat=13.75&lng=100.52',
      'GET /api/movies/now-playing',
      'GET /api/movies/:id',
      'GET /api/showtimes?cinema=major-1&date=2026-04-02',
      'GET /api/showtimes?movie=sf-uuid&date=2026-04-02',
    ],
  });
});

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await initDb();         // Create tables if they don't exist
  startCron();            // Start scraper cron + run immediately

  app.listen(PORT, () => {
    console.log(`\n🎬 doomovie API running on port ${PORT}`);
    console.log(`   http://localhost:${PORT}\n`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
