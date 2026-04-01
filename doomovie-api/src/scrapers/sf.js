// SF Cinema scraper v3
// Uses per-branch content + session endpoints with exact parameters from Network tab
// Key finding: branch filtering works on onl.sfcinema.com with specific param names
// Note the typo in SF's API: "channle=web" (must be included alongside channel=WEB)

const axios  = require('axios');
const { pool } = require('../db');

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin':          'https://www.sfcinema.com',
  'Referer':         'https://www.sfcinema.com/',
  'sec-fetch-dest':  'empty',
  'sec-fetch-mode':  'cors',
  'sec-fetch-site':  'same-site',
};

const BASE = 'https://onl.sfcinema.com/ticket/data';

// Fetch all branches (from sfcinema.com — no 403)
async function fetchBranches() {
  const res = await axios.get(
    'https://www.sfcinema.com/api/v1/branch?locale=en&channel=WEB',
    { headers: HEADERS, timeout: 15000 }
  );
  return Array.isArray(res.data) ? res.data : (res.data.data || []);
}

// Fetch movies for a specific branch — exact URL from Network tab
async function fetchBranchContent(branchId) {
  const url = `${BASE}/content?locale=en&branch=${branchId}&is_short=false&type=all&channle=web&system=&audio=&subTitle=&channel=WEB`;
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return res.data.data || [];
}

// Fetch sessions for a specific branch — filtered so much smaller than full dump
async function fetchBranchSessions(branchId, contentId = '') {
  const url = `${BASE}/session?locale=en&contentId=${contentId}&branch=${branchId}&specialScreenId=&channel=WEB`;
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return res.data.data || [];
}

function normalizeScreenType(session) {
  const attrs   = session.cinemaAttribute || [];
  const special = session.specialScreenId || '';
  if (special === 'ZIGMA')                             return 'ZIGMA';
  if (attrs.includes('IMAX'))                          return 'IMAX';
  if (attrs.includes('MX4D'))                          return '4DX';
  if (attrs.includes('ATMOS') && attrs.includes('LASER')) return 'LASER ATMOS';
  if (attrs.includes('ATMOS'))                         return 'ATMOS';
  if (attrs.includes('LASER'))                         return 'LASER';
  return 'STANDARD';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeSF() {
  console.log('🎬 SF Cinema: starting scrape (per-branch strategy)...');
  const client = await pool.connect();

  try {
    const branches = await fetchBranches();
    console.log(`  → ${branches.length} branches`);

    if (!branches.length) {
      console.warn('  ⚠️  SF: no branches returned');
      return;
    }

    // Upsert all cinemas first
    for (const b of branches) {
      const lat = b.geoLocation?.lat ?? null;
      const lng = b.geoLocation?.lng ?? null;
      await client.query(`
        INSERT INTO cinemas (id, source, source_id, name_en, lat, lng, updated_at)
        VALUES ($1, 'sf', $2, $3, $4, $5, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name_en=EXCLUDED.name_en, lat=EXCLUDED.lat,
          lng=EXCLUDED.lng, updated_at=NOW()
      `, [`sf-${b.id}`, b.id, b.name, lat, lng]);
    }

    let totalMovies   = 0;
    let totalShowtimes = 0;
    const movieCache  = {};

    // Process each branch individually
    for (const branch of branches) {
      try {
        // Get movies showing at this branch
        const contents = await fetchBranchContent(branch.id);
        await sleep(200);

        // Get all sessions for this branch at once
        const sessions = await fetchBranchSessions(branch.id);
        await sleep(200);

        console.log(`  → SF [${branch.id}] ${branch.name}: ${contents.length} movies, ${sessions.length} sessions`);

        const contentMap = Object.fromEntries(contents.map(c => [c.id, c]));

        // Upsert movies
        for (const c of contents) {
          if (!movieCache[c.id]) {
            await client.query(`
              INSERT INTO movies (id, source, source_id, title_en, poster_url, backdrop_url,
                                  synopsis, runtime, rating, genre, director, trailer_url, updated_at)
              VALUES ($1,'sf',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
              ON CONFLICT (id) DO UPDATE SET
                title_en=EXCLUDED.title_en, poster_url=EXCLUDED.poster_url,
                backdrop_url=EXCLUDED.backdrop_url, synopsis=EXCLUDED.synopsis,
                runtime=EXCLUDED.runtime, rating=EXCLUDED.rating,
                genre=EXCLUDED.genre, director=EXCLUDED.director,
                trailer_url=EXCLUDED.trailer_url, updated_at=NOW()
            `, [
              `sf-${c.id}`, c.id, c.title,
              c.media?.portrait ?? null, c.media?.landscape ?? null,
              c.synopsis ?? null, c.contentLength ?? null, c.rating ?? null,
              c.genre ?? null, c.director ?? null, c.media?.video ?? null,
            ]);
            movieCache[c.id] = true;
            totalMovies++;
          }
        }

        // Upsert showtimes
        for (const s of sessions) {
          const content  = contentMap[s.contentId];
          if (!content) continue;
          const showTime = new Date(s.sessionDatetime);
          if (showTime < new Date()) continue;

          await client.query(`
            INSERT INTO showtimes (id, cinema_id, movie_id, show_time, screen_name,
                                   screen_type, audio, subtitles, is_sold_out, booking_url, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
            ON CONFLICT (id) DO UPDATE SET
              is_sold_out=EXCLUDED.is_sold_out, updated_at=NOW()
          `, [
            `sf-${s.id}`,
            `sf-${branch.id}`,
            `sf-${s.contentId}`,
            showTime.toISOString(),
            s.screenName,
            normalizeScreenType(s),
            s.audio ?? null,
            s.subtitles ?? [],
            s.isSoldOut ?? false,
            `https://www.sfcinema.com/movie/${s.contentId}/showtime?session=${s.id}&branch=${s.branchId}`,
          ]);
          totalShowtimes++;
        }

      } catch (err) {
        console.warn(`  ⚠️  SF [${branch.id}]: ${err.message}`);
      }
    }

    console.log(`  ✅ SF done: ${totalMovies} movies, ${totalShowtimes} showtimes`);
  } catch (err) {
    console.error('  ❌ SF scrape failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { scrapeSF };
