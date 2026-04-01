// API routes
// GET /api/cinemas
// GET /api/cinemas?lat=13.75&lng=100.52       — sorted by distance
// GET /api/movies/now-playing
// GET /api/showtimes?cinema=major-1&date=2026-04-02
// GET /api/showtimes?movie=sf-uuid&date=2026-04-02

const express = require('express');
const router  = express.Router();
const { pool } = require('../db');

// ─── Helper: Haversine distance in km ────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2
    + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── GET /api/cinemas ─────────────────────────────────────────────────────────
// Optional: ?lat=&lng= to sort by distance
router.get('/cinemas', async (req, res) => {
  try {
    const { lat, lng, source } = req.query;
    let query = 'SELECT * FROM cinemas WHERE lat IS NOT NULL';
    const params = [];

    if (source) {
      params.push(source);
      query += ` AND source = $${params.length}`;
    }

    query += ' ORDER BY name_en';
    const { rows } = await pool.query(query, params);

    // If GPS provided, sort by distance and add distance field
    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      rows.forEach(c => {
        c.distance_km = Math.round(haversine(userLat, userLng, c.lat, c.lng) * 10) / 10;
      });
      rows.sort((a, b) => a.distance_km - b.distance_km);
    }

    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/movies/now-playing ──────────────────────────────────────────────
router.get('/movies/now-playing', async (req, res) => {
  try {
    // Movies that have at least one future showtime
    const { rows } = await pool.query(`
      SELECT DISTINCT m.*
      FROM movies m
      INNER JOIN showtimes s ON s.movie_id = m.id
      WHERE s.show_time > NOW()
      ORDER BY m.title_en
    `);
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/movies/:id ──────────────────────────────────────────────────────
router.get('/movies/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM movies WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Movie not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/showtimes ───────────────────────────────────────────────────────
// ?cinema=major-1&date=2026-04-02
// ?movie=sf-uuid&date=2026-04-02
// date defaults to today (Bangkok time)
router.get('/showtimes', async (req, res) => {
  try {
    const { cinema, movie, date } = req.query;

    if (!cinema && !movie) {
      return res.status(400).json({ success: false, error: 'Provide cinema or movie param' });
    }

    // Default to today in Bangkok (UTC+7)
    const targetDate = date || new Date(Date.now() + 7*3600000).toISOString().split('T')[0];
    const dayStart   = `${targetDate}T00:00:00+07:00`;
    const dayEnd     = `${targetDate}T23:59:59+07:00`;

    let query = `
      SELECT
        s.*,
        m.title_en, m.title_th, m.poster_url, m.backdrop_url,
        m.runtime, m.rating, m.genre, m.synopsis, m.trailer_url,
        c.name_en AS cinema_name, c.name_th AS cinema_name_th,
        c.lat, c.lng, c.source AS cinema_source
      FROM showtimes s
      JOIN movies  m ON m.id = s.movie_id
      JOIN cinemas c ON c.id = s.cinema_id
      WHERE s.show_time BETWEEN $1 AND $2
    `;
    const params = [dayStart, dayEnd];

    if (cinema) {
      params.push(cinema);
      query += ` AND s.cinema_id = $${params.length}`;
    }
    if (movie) {
      params.push(movie);
      query += ` AND s.movie_id = $${params.length}`;
    }

    query += ' ORDER BY s.show_time ASC';

    const { rows } = await pool.query(query, params);

    // Group by movie (when querying by cinema) or by cinema (when querying by movie)
    const grouped = groupShowtimes(rows, cinema ? 'movie' : 'cinema');

    res.json({
      success: true,
      date: targetDate,
      count: rows.length,
      data: grouped,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Helper: group showtimes for clean API response ──────────────────────────
function groupShowtimes(rows, groupBy) {
  const groups = {};

  for (const row of rows) {
    const key = groupBy === 'movie'
      ? row.movie_id
      : row.cinema_id;

    if (!groups[key]) {
      groups[key] = groupBy === 'movie'
        ? {
            movie_id:    row.movie_id,
            title_en:    row.title_en,
            title_th:    row.title_th,
            poster_url:  row.poster_url,
            backdrop_url:row.backdrop_url,
            runtime:     row.runtime,
            rating:      row.rating,
            genre:       row.genre,
            synopsis:    row.synopsis,
            trailer_url: row.trailer_url,
            showtimes:   [],
          }
        : {
            cinema_id:   row.cinema_id,
            name_en:     row.cinema_name,
            name_th:     row.cinema_name_th,
            lat:         row.lat,
            lng:         row.lng,
            source:      row.cinema_source,
            showtimes:   [],
          };
    }

    groups[key].showtimes.push({
      id:          row.id,
      show_time:   row.show_time,
      screen_name: row.screen_name,
      screen_type: row.screen_type,
      audio:       row.audio,
      subtitles:   row.subtitles,
      is_sold_out: row.is_sold_out,
      booking_url: row.booking_url,
    });
  }

  return Object.values(groups);
}

// ─── GET /api/health ──────────────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM cinemas)  AS cinemas,
        (SELECT COUNT(*) FROM movies)   AS movies,
        (SELECT COUNT(*) FROM showtimes WHERE show_time > NOW()) AS future_showtimes,
        (SELECT MAX(updated_at) FROM showtimes) AS last_scraped
    `);
    res.json({ success: true, status: 'ok', stats: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
