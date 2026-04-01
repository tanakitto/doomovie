const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ─── Schema ──────────────────────────────────────────────────────────────────
// Run once on Railway to create tables
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cinemas (
    id          TEXT PRIMARY KEY,       -- e.g. "major-1", "sf-LPO", "house-samyan"
    source      TEXT NOT NULL,          -- "major" | "sf" | "house"
    source_id   TEXT NOT NULL,          -- original ID from source
    name_th     TEXT,
    name_en     TEXT NOT NULL,
    lat         DOUBLE PRECISION,
    lng         DOUBLE PRECISION,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS movies (
    id          TEXT PRIMARY KEY,       -- e.g. "major-1234", "sf-uuid", "tmdb-12345"
    source      TEXT NOT NULL,
    source_id   TEXT NOT NULL,
    title_en    TEXT NOT NULL,
    title_th    TEXT,
    poster_url  TEXT,
    backdrop_url TEXT,
    synopsis    TEXT,
    runtime     INTEGER,               -- minutes
    rating      TEXT,                  -- "G", "13+", "18+" etc
    genre       TEXT,
    director    TEXT,
    trailer_url TEXT,
    tmdb_id     INTEGER,               -- matched TMDB ID if found
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS showtimes (
    id          TEXT PRIMARY KEY,       -- source session UUID or constructed key
    cinema_id   TEXT REFERENCES cinemas(id),
    movie_id    TEXT REFERENCES movies(id),
    show_time   TIMESTAMPTZ NOT NULL,
    screen_name TEXT,
    screen_type TEXT,                  -- "IMAX" | "4DX" | "STANDARD" | "ZIGMA" etc
    audio       TEXT,                  -- "TH" | "EN" | "JP" etc
    subtitles   TEXT[],               -- ["TH", "EN"]
    is_sold_out BOOLEAN DEFAULT FALSE,
    booking_url TEXT,                  -- deeplink to official booking page
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_showtimes_cinema   ON showtimes(cinema_id);
  CREATE INDEX IF NOT EXISTS idx_showtimes_movie    ON showtimes(movie_id);
  CREATE INDEX IF NOT EXISTS idx_showtimes_showtime ON showtimes(show_time);
`;

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
    console.log('✅ Database schema ready');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
