// SF Cinema scraper v5 — confirmed working endpoints from browser testing
// All 3 endpoints are on onl.sfcinema.com and return 200 from browsers
// Railway IPs are blocked by Cloudflare — use SF_PROXY_URL (Cloudflare Worker)
//
// Confirmed endpoints (Apr 2026):
//   branches: GET https://onl.sfcinema.com/ticket/data/branch?locale=en&channel=WEB&spceialScreenId=&seatCateId=&branch=
//   content:  GET https://onl.sfcinema.com/ticket/data/content?locale=en&channel=WEB&type=all&is_short=false
//   sessions: GET https://onl.sfcinema.com/ticket/data/session?locale=en&channel=WEB

const axios  = require('axios');
const { pool } = require('../db');

const PROXY = process.env.SF_PROXY_URL || null;

// Build URL — route through Cloudflare Worker proxy if configured
function sfUrl(path, query = '') {
  if (PROXY) {
    return `${PROXY}?path=${encodeURIComponent(path)}&query=${encodeURIComponent(query)}`;
  }
  return `https://onl.sfcinema.com${path}${query ? '?' + query : ''}`;
}

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
  'Origin':          'https://www.sfcinema.com',
  'Referer':         'https://www.sfcinema.com/',
  'sec-fetch-dest':  'empty',
  'sec-fetch-mode':  'cors',
  'sec-fetch-site':  'same-site',
};

// 67 branches with id, name, phone, GPS coords
async function fetchBranches() {
  const res = await axios.get(
    sfUrl('/ticket/data/branch', 'locale=en&channel=WEB&spceialScreenId=&seatCateId=&branch='),
    { headers: HEADERS, timeout: 20000 }
  );
  return res.data.data || [];
}

// All movies now showing + coming soon
async function fetchContent() {
  const res = await axios.get(
    sfUrl('/ticket/data/content', 'locale=en&channel=WEB&type=all&is_short=false'),
    { headers: HEADERS, timeout: 30000 }
  );
  return res.data.data || [];
}

// All sessions (8,900+ records — full schedule all branches all dates)
async function fetchSessions() {
  const res = await axios.get(
    sfUrl('/ticket/data/session', 'locale=en&channel=WEB'),
    { headers: HEADERS, timeout: 60000 }
  );
  return res.data.data || [];
}

function normalizeScreenType(session) {
  const attrs   = session.cinemaAttribute || [];
  const special = session.specialScreenId || '';
  if (special === 'ZIGMA')                                return 'ZIGMA';
  if (attrs.includes('IMAX'))                             return 'IMAX';
  if (attrs.includes('MX4D'))                             return '4DX';
  if (attrs.includes('ATMOS') && attrs.includes('LASER')) return 'LASER ATMOS';
  if (attrs.includes('ATMOS'))                            return 'ATMOS';
  if (attrs.includes('LASER'))                            return 'LASER';
  return 'STANDARD';
}

async function scrapeSF() {
  const mode = PROXY ? `Cloudflare Worker (${PROXY})` : 'direct (may 403)';
  console.log(`🎬 SF Cinema: scraping via ${mode}...`);
  const client = await pool.connect();

  try {
    // Fetch all 3 in parallel — saves time
    const [branches, contents, sessions] = await Promise.all([
      fetchBranches(),
      fetchContent(),
      fetchSessions(),
    ]);

    console.log(`  → ${branches.length} branches, ${contents.length} movies, ${sessions.length} sessions`);

    if (!branches.length || !sessions.length) {
      console.warn('  ⚠️  SF: empty response — proxy may not be configured');
      return;
    }

    // Build lookup maps
    const contentMap = Object.fromEntries(contents.map(c => [c.id, c]));

    // Upsert cinemas — branch object has lat/lng under geoLocation
    for (const b of branches) {
      const lat = b.geoLocation?.lat ?? b.lat ?? null;
      const lng = b.geoLocation?.lng ?? b.lng ?? b.long ?? null;
      await client.query(`
        INSERT INTO cinemas (id, source, source_id, name_en, lat, lng, updated_at)
        VALUES ($1,'sf',$2,$3,$4,$5,NOW())
        ON CONFLICT (id) DO UPDATE SET
          name_en=EXCLUDED.name_en, lat=EXCLUDED.lat,
          lng=EXCLUDED.lng, updated_at=NOW()
      `, [`sf-${b.id}`, b.id, b.name, lat, lng]);
    }

    // Upsert movies
    const movieCache = {};
    for (const c of contents) {
      if (movieCache[c.id]) continue;
      await client.query(`
        INSERT INTO movies (id, source, source_id, title_en, poster_url, backdrop_url,
                            synopsis, runtime, rating, genre, director, trailer_url, updated_at)
        VALUES ($1,'sf',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT (id) DO UPDATE SET
          title_en=EXCLUDED.title_en, poster_url=EXCLUDED.poster_url,
          backdrop_url=EXCLUDED.backdrop_url, synopsis=EXCLUDED.synopsis,
          runtime=EXCLUDED.runtime, rating=EXCLUDED.rating, genre=EXCLUDED.genre,
          director=EXCLUDED.director, trailer_url=EXCLUDED.trailer_url, updated_at=NOW()
      `, [
        `sf-${c.id}`, c.id, c.title,
        c.media?.portrait ?? null, c.media?.landscape ?? null,
        c.synopsis ?? null, c.contentLength ?? null, c.rating ?? null,
        c.genre ?? null, c.director ?? null, c.media?.video ?? null,
      ]);
      movieCache[c.id] = true;
    }

    // Upsert showtimes
    let inserted = 0;
    const now = new Date();
    for (const s of sessions) {
      if (!contentMap[s.contentId]) continue;
      const showTime = new Date(s.sessionDatetime);
      if (showTime < now) continue;

      await client.query(`
        INSERT INTO showtimes (id, cinema_id, movie_id, show_time, screen_name,
                               screen_type, audio, subtitles, is_sold_out, booking_url, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT (id) DO UPDATE SET
          is_sold_out=EXCLUDED.is_sold_out, updated_at=NOW()
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
        `https://www.sfcinema.com/movie/${s.contentId}/showtime?session=${s.id}&branch=${s.branchId}`,
      ]);
      inserted++;
    }

    console.log(`  ✅ SF done: ${Object.keys(movieCache).length} movies, ${inserted} showtimes`);
  } catch (err) {
    console.error('  ❌ SF failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { scrapeSF };
