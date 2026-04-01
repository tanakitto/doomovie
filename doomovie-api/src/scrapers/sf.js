// SF Cinema scraper
// Uses their official JSON APIs — no HTML scraping needed
// Endpoints discovered via Network tab analysis

const axios = require('axios');
const { pool } = require('../db');

const BASE     = 'https://onl.sfcinema.com/ticket/data';
const BRANCH   = 'https://www.sfcinema.com/api/v1/branch';
const HEADERS  = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin':          'https://www.sfcinema.com',
  'Referer':         'https://www.sfcinema.com/',
  'sec-ch-ua':       '"Chromium";v="124", "Google Chrome";v="124"',
  'sec-ch-ua-mobile':'?0',
  'sec-fetch-dest':  'empty',
  'sec-fetch-mode':  'cors',
  'sec-fetch-site':  'same-site',
};

// ─── Fetch all SF branches with GPS ──────────────────────────────────────────
async function fetchBranches() {
  const res = await axios.get(`${BRANCH}?locale=en&channel=WEB`, { headers: HEADERS });
  return res.data; // array of branch objects
}

// ─── Fetch all movies currently showing + coming soon ────────────────────────
async function fetchContent() {
  const res = await axios.get(`${BASE}/content?locale=en&channel=WEB&type=all&is_short=false`, { headers: HEADERS });
  return res.data.data; // array of content objects
}

// ─── Fetch all sessions (entire schedule, all branches, all dates) ────────────
async function fetchSessions() {
  const res = await axios.get(`${BASE}/session?locale=en&channel=WEB`, { headers: HEADERS });
  return res.data.data; // array of session objects
}

// ─── Map SF screen types to our standard labels ──────────────────────────────
function normalizeScreenType(session) {
  const attrs = session.cinemaAttribute || [];
  const special = session.specialScreenId || '';
  if (special === 'ZIGMA') return 'ZIGMA';
  if (attrs.includes('IMAX'))  return 'IMAX';
  if (attrs.includes('MX4D'))  return '4DX';
  if (attrs.includes('ATMOS') && attrs.includes('LASER')) return 'LASER ATMOS';
  if (attrs.includes('ATMOS')) return 'ATMOS';
  if (attrs.includes('LASER')) return 'LASER';
  return 'STANDARD';
}

// ─── Build SF booking deeplink ────────────────────────────────────────────────
function bookingUrl(session) {
  return `https://www.sfcinema.com/movie/${session.contentId}/showtime?session=${session.id}&branch=${session.branchId}`;
}

// ─── Main scrape function ─────────────────────────────────────────────────────
async function scrapeSF() {
  console.log('🎬 SF Cinema: starting scrape...');
  const client = await pool.connect();

  try {
    const [branches, contents, sessions] = await Promise.all([
      fetchBranches(),
      fetchContent(),
      fetchSessions(),
    ]);

    console.log(`  → ${branches.length} branches, ${contents.length} movies, ${sessions.length} sessions`);

    // Build lookup maps
    const branchMap  = Object.fromEntries(branches.map(b => [b.id, b]));
    const contentMap = Object.fromEntries(contents.map(c => [c.id, c]));

    // ── Upsert cinemas ────────────────────────────────────────────────────────
    for (const b of branches) {
      const lat = b.geoLocation?.lat ?? null;
      const lng = b.geoLocation?.lng ?? null;
      await client.query(`
        INSERT INTO cinemas (id, source, source_id, name_en, lat, lng, updated_at)
        VALUES ($1, 'sf', $2, $3, $4, $5, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name_en    = EXCLUDED.name_en,
          lat        = EXCLUDED.lat,
          lng        = EXCLUDED.lng,
          updated_at = NOW()
      `, [`sf-${b.id}`, b.id, b.name, lat, lng]);
    }

    // ── Upsert movies ─────────────────────────────────────────────────────────
    for (const c of contents) {
      await client.query(`
        INSERT INTO movies (id, source, source_id, title_en, poster_url, backdrop_url,
                            synopsis, runtime, rating, genre, director, trailer_url, updated_at)
        VALUES ($1, 'sf', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (id) DO UPDATE SET
          title_en    = EXCLUDED.title_en,
          poster_url  = EXCLUDED.poster_url,
          backdrop_url= EXCLUDED.backdrop_url,
          synopsis    = EXCLUDED.synopsis,
          runtime     = EXCLUDED.runtime,
          rating      = EXCLUDED.rating,
          genre       = EXCLUDED.genre,
          director    = EXCLUDED.director,
          trailer_url = EXCLUDED.trailer_url,
          updated_at  = NOW()
      `, [
        `sf-${c.id}`, c.id, c.title,
        c.media?.portrait ?? null,
        c.media?.landscape ?? null,
        c.synopsis ?? null,
        c.contentLength ?? null,
        c.rating ?? null,
        c.genre ?? null,
        c.director ?? null,
        c.media?.video ?? null,
      ]);
    }

    // ── Upsert showtimes ──────────────────────────────────────────────────────
    // Only process sessions where we have both branch and content data
    let inserted = 0;
    for (const s of sessions) {
      const branch  = branchMap[s.branchId];
      const content = contentMap[s.contentId];
      if (!branch || !content) continue;

      // Only future showtimes
      const showTime = new Date(s.sessionDatetime);
      if (showTime < new Date()) continue;

      await client.query(`
        INSERT INTO showtimes (id, cinema_id, movie_id, show_time, screen_name,
                               screen_type, audio, subtitles, is_sold_out, booking_url, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (id) DO UPDATE SET
          is_sold_out = EXCLUDED.is_sold_out,
          updated_at  = NOW()
      `, [
        `sf-${s.id}`,
        `sf-${s.branchId}`,
        `sf-${s.contentId}`,
        showTime.toISOString(),
        s.screenName,
        normalizeScreenType(s),
        s.audio ?? null,
        s.subtitles ?? [],
        s.isSoldOut ?? false,
        bookingUrl(s),
      ]);
      inserted++;
    }

    console.log(`  ✅ SF Cinema done: ${inserted} showtimes upserted`);
  } catch (err) {
    console.error('  ❌ SF Cinema scrape failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { scrapeSF };
