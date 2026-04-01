// SF Cinema scraper v4 — via Cloudflare Worker proxy
// Worker runs on Cloudflare's own network so SF cannot block it
// Set SF_PROXY_URL env var in Railway after deploying the Worker

const axios  = require('axios');
const { pool } = require('../db');

// Falls back to direct call if no proxy configured (for local dev)
const PROXY = process.env.SF_PROXY_URL || null;

function sfUrl(path, query = '') {
  if (PROXY) {
    const encoded = encodeURIComponent(query);
    return `${PROXY}?path=${encodeURIComponent(path)}&query=${encoded}`;
  }
  const domain = path.startsWith('/api/v1/')
    ? 'https://www.sfcinema.com'
    : 'https://onl.sfcinema.com';
  return `${domain}${path}${query ? '?' + query : ''}`;
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':     'application/json',
};

async function fetchBranches() {
  const res = await axios.get(sfUrl('/api/v1/branch', 'locale=en&channel=WEB'), { headers: HEADERS, timeout: 15000 });
  return Array.isArray(res.data) ? res.data : (res.data.data || []);
}

async function fetchBranchContent(branchId) {
  const query = `locale=en&branch=${branchId}&is_short=false&type=all&channle=web&system=&audio=&subTitle=&channel=WEB`;
  const res = await axios.get(sfUrl('/ticket/data/content', query), { headers: HEADERS, timeout: 15000 });
  return res.data.data || [];
}

async function fetchBranchSessions(branchId) {
  const query = `locale=en&contentId=&branch=${branchId}&specialScreenId=&channel=WEB`;
  const res = await axios.get(sfUrl('/ticket/data/session', query), { headers: HEADERS, timeout: 15000 });
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeSF() {
  console.log(`🎬 SF Cinema: scraping via ${PROXY ? 'Cloudflare Worker proxy' : 'direct'}...`);
  const client = await pool.connect();

  try {
    const branches = await fetchBranches();
    console.log(`  → ${branches.length} branches`);
    if (!branches.length) { console.warn('  ⚠️  SF: no branches'); return; }

    for (const b of branches) {
      await client.query(`
        INSERT INTO cinemas (id, source, source_id, name_en, lat, lng, updated_at)
        VALUES ($1,'sf',$2,$3,$4,$5,NOW())
        ON CONFLICT (id) DO UPDATE SET name_en=EXCLUDED.name_en, lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=NOW()
      `, [`sf-${b.id}`, b.id, b.name, b.geoLocation?.lat ?? null, b.geoLocation?.lng ?? null]);
    }

    let totalMovies = 0, totalShowtimes = 0;
    const movieCache = {};

    for (const branch of branches) {
      try {
        const [contents, sessions] = await Promise.all([
          fetchBranchContent(branch.id),
          fetchBranchSessions(branch.id),
        ]);
        await sleep(300);

        const contentMap = Object.fromEntries(contents.map(c => [c.id, c]));
        console.log(`  → SF [${branch.id}]: ${contents.length} movies, ${sessions.length} sessions`);

        for (const c of contents) {
          if (movieCache[c.id]) continue;
          await client.query(`
            INSERT INTO movies (id, source, source_id, title_en, poster_url, backdrop_url,
                                synopsis, runtime, rating, genre, director, trailer_url, updated_at)
            VALUES ($1,'sf',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
            ON CONFLICT (id) DO UPDATE SET title_en=EXCLUDED.title_en, poster_url=EXCLUDED.poster_url,
              backdrop_url=EXCLUDED.backdrop_url, synopsis=EXCLUDED.synopsis, runtime=EXCLUDED.runtime,
              rating=EXCLUDED.rating, genre=EXCLUDED.genre, director=EXCLUDED.director,
              trailer_url=EXCLUDED.trailer_url, updated_at=NOW()
          `, [`sf-${c.id}`, c.id, c.title, c.media?.portrait??null, c.media?.landscape??null,
              c.synopsis??null, c.contentLength??null, c.rating??null, c.genre??null,
              c.director??null, c.media?.video??null]);
          movieCache[c.id] = true;
          totalMovies++;
        }

        for (const s of sessions) {
          if (!contentMap[s.contentId]) continue;
          const showTime = new Date(s.sessionDatetime);
          if (showTime < new Date()) continue;
          await client.query(`
            INSERT INTO showtimes (id, cinema_id, movie_id, show_time, screen_name, screen_type,
                                   audio, subtitles, is_sold_out, booking_url, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
            ON CONFLICT (id) DO UPDATE SET is_sold_out=EXCLUDED.is_sold_out, updated_at=NOW()
          `, [`sf-${s.id}`, `sf-${branch.id}`, `sf-${s.contentId}`, showTime.toISOString(),
              s.screenName, normalizeScreenType(s), s.audio??null, s.subtitles??[],
              s.isSoldOut??false,
              `https://www.sfcinema.com/movie/${s.contentId}/showtime?session=${s.id}&branch=${s.branchId}`]);
          totalShowtimes++;
        }
      } catch (err) {
        console.warn(`  ⚠️  SF [${branch.id}]: ${err.message}`);
      }
    }

    console.log(`  ✅ SF done: ${totalMovies} movies, ${totalShowtimes} showtimes`);
  } catch (err) {
    console.error('  ❌ SF failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { scrapeSF };
