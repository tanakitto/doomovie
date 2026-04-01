// Scraper using showtimes.everyday.in.th for Major Cineplex
// + direct scrape of housesamyan.com for House Samyan
// SF Cinema is excluded until a Thai-hosted solution is found

const axios   = require('axios');
const cheerio = require('cheerio');
const { pool } = require('../db');

const BASE    = 'https://showtimes.everyday.in.th';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Referer':    'https://showtimes.everyday.in.th/',
};
const API_HEADERS = { ...HEADERS, 'Accept': 'application/json' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parsePoint(point) {
  const m = point?.match(/POINT \(([0-9.-]+) ([0-9.-]+)\)/);
  if (!m) return { lat: null, lng: null };
  return { lat: parseFloat(m[2]), lng: parseFloat(m[1]) };
}

function normalizeAudio(audio) {
  const a = (audio || '').toLowerCase();
  if (a.includes('en')) return 'EN';
  if (a.includes('ja') || a.includes('jp')) return 'JA';
  if (a.includes('ko') || a.includes('kr')) return 'KO';
  return 'TH';
}

// ── Fetch Major theaters only ─────────────────────────────────────────────────
async function fetchMajorTheaters() {
  console.log('  → Fetching Major theater list...');
  const theaters = [];
  let url = `${BASE}/api/v2/theater/?limit=50&format=json&group__code=major`;

  while (url) {
    const res  = await axios.get(url, { headers: API_HEADERS, timeout: 15000 });
    const data = res.data;
    theaters.push(...data.results.filter(t => t.status === 'operate'));
    // Fix pagination URL (http → https)
    url = data.next ? data.next.replace('http://', 'https://') : null;
    await sleep(200);
  }
  console.log(`  → ${theaters.length} Major theaters`);
  return theaters;
}

// ── Scrape showtime page for a Major theater ──────────────────────────────────
async function scrapeMajorTheater(theater) {
  const url = `${BASE}/theater/major/${theater.id}/`;
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
    const $   = cheerio.load(res.data);
    const rows = [];

    $('.showtimes-item').each((_, item) => {
      const $item   = $(item);
      const titleEl = $item.find('h4 a');
      const title   = titleEl.text().trim();
      const slug    = titleEl.attr('href')?.match(/\/movie\/([^\/]+)\//)?.[1];
      if (!title || !slug) return;

      const descItems = $item.find('ul.desc li').map((_, li) => $(li).text().trim()).get();
      const audio     = descItems[0] || 'th';
      const subtitle  = descItems[1] || '';
      const screen    = $item.find('.screen').text().trim();

      $item.find('ul.times li').each((_, li) => {
        const time = $(li).text().trim();
        if (!time.match(/^\d{2}:\d{2}$/)) return;
        rows.push({ title, slug, time, audio, subtitle, screen });
      });
    });
    return rows;
  } catch (err) {
    if (!err.response || err.response.status !== 404) {
      console.warn(`    ⚠️  Major [${theater.id}] ${theater.english}: ${err.message}`);
    }
    return [];
  }
}

// ── Fetch movie detail for poster ─────────────────────────────────────────────
const movieCache = {};
async function fetchMovieDetail(slug) {
  if (movieCache[slug] !== undefined) return movieCache[slug];
  try {
    const res = await axios.get(`${BASE}/movie/${slug}/`, { headers: HEADERS, timeout: 10000 });
    const $   = cheerio.load(res.data);
    const poster = $('img[src*="passport-go"], img[src*="stth"]').first().attr('src') || null;
    const titleTH = $('h1, h2').first().text().trim().replace(/\s*\(\d{4}\)\s*$/, '');
    const durationMatch = $('body').text().match(/(\d+)\s*min/i);
    const runtime = durationMatch ? parseInt(durationMatch[1]) : null;
    const movie = { slug, poster, titleTH, runtime };
    movieCache[slug] = movie;
    await sleep(150);
    return movie;
  } catch {
    movieCache[slug] = { slug, poster: null, titleTH: null, runtime: null };
    return movieCache[slug];
  }
}

// ── House Samyan scraper ──────────────────────────────────────────────────────
async function scrapeHouseSamyan(client, today) {
  console.log('  🏠 House Samyan: scraping...');
  try {
    const res = await axios.get('https://www.housesamyan.com/', {
      headers: { ...HEADERS, Referer: 'https://www.housesamyan.com/' },
      timeout: 15000
    });
    const $ = cheerio.load(res.data);
    let inserted = 0;

    // Upsert House Samyan cinema
    await client.query(`
      INSERT INTO cinemas (id, source, source_id, name_en, name_th, lat, lng, updated_at)
      VALUES ('house-1','house','1','House Samyan','House Samyan',13.7318,100.5269,NOW())
      ON CONFLICT (id) DO UPDATE SET updated_at=NOW()
    `);

    // Parse movies and showtimes from their HTML
    $('[class*="movie"], .movie-item, article').each((_, el) => {
      const $el   = $(el);
      const title = $el.find('h2, h3, .title').first().text().trim();
      if (!title) return;

      $el.find('a[href*="showtimes_id"], a[href*="showtime"]').each(async (_, a) => {
        const $a     = $(a);
        const timeEl = $a.text().trim();
        if (!timeEl.match(/\d{1,2}:\d{2}/)) return;

        const [h, m] = timeEl.match(/(\d{1,2}):(\d{2})/).slice(1).map(Number);
        const showTime = new Date(`${today}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+07:00`);
        if (showTime < new Date()) return;

        const href    = $a.attr('href') || '';
        const sid     = href.match(/showtimes_id=(\d+)/)?.[1] || `${Date.now()}`;
        const movieId = `house-${title.replace(/\s+/g, '-').toLowerCase().slice(0,30)}`;

        await client.query(`
          INSERT INTO movies (id, source, source_id, title_th, title_en, updated_at)
          VALUES ($1,'house',$2,$3,$4,NOW())
          ON CONFLICT (id) DO UPDATE SET title_th=EXCLUDED.title_th, updated_at=NOW()
        `, [movieId, movieId, title, title]);

        await client.query(`
          INSERT INTO showtimes (id, cinema_id, movie_id, show_time, screen_type, audio,
                                 subtitles, is_sold_out, booking_url, updated_at)
          VALUES ($1,'house-1',$2,$3,'STANDARD','TH','{}',false,$4,NOW())
          ON CONFLICT (id) DO UPDATE SET updated_at=NOW()
        `, [
          `house-${sid}`, movieId, showTime.toISOString(),
          `https://www.housesamyan.com/get_showtime_seat?showtimes_id=${sid}`
        ]);
        inserted++;
      });
    });

    console.log(`  ✅ House Samyan: ${inserted} showtimes`);
  } catch (err) {
    console.warn(`  ⚠️  House Samyan: ${err.message}`);
  }
}

// ── Main scraper ──────────────────────────────────────────────────────────────
async function scrapeEveryday() {
  console.log('🎬 Scraper: starting via showtimes.everyday.in.th (Major only)...');
  const client = await pool.connect();

  try {
    const today    = new Date(Date.now() + 7*3600000).toISOString().split('T')[0];
    const theaters = await fetchMajorTheaters();

    // Upsert Major cinemas
    for (const t of theaters) {
      const { lat, lng } = parsePoint(t.point);
      await client.query(`
        INSERT INTO cinemas (id, source, source_id, name_en, name_th, lat, lng, updated_at)
        VALUES ($1,'major',$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (id) DO UPDATE SET
          name_en=EXCLUDED.name_en, name_th=EXCLUDED.name_th,
          lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=NOW()
      `, [`major-${t.id}`, String(t.id), t.english, t.thai, lat, lng]);
    }
    console.log(`  ✅ ${theaters.length} Major cinemas upserted`);

    // Scrape showtimes
    let totalShowtimes = 0;
    const slugsToFetch = new Set();
    const allRows = [];

    for (const theater of theaters) {
      const rows = await scrapeMajorTheater(theater);
      rows.forEach(r => slugsToFetch.add(r.slug));
      allRows.push({ theater, rows });
      if (rows.length) console.log(`  → Major [${theater.id}] ${theater.english}: ${rows.length} slots`);
      await sleep(400);
    }

    // Fetch movie details
    console.log(`  → Fetching ${slugsToFetch.size} movie details...`);
    for (const slug of slugsToFetch) {
      await fetchMovieDetail(slug);
    }

    // Upsert movies + showtimes
    for (const { theater, rows } of allRows) {
      for (const row of rows) {
        const movie   = movieCache[row.slug];
        if (!movie) continue;
        const movieId = `everyday-${row.slug}`;

        await client.query(`
          INSERT INTO movies (id, source, source_id, title_th, title_en, poster_url, runtime, updated_at)
          VALUES ($1,'everyday',$2,$3,$4,$5,$6,NOW())
          ON CONFLICT (id) DO UPDATE SET
            title_th=EXCLUDED.title_th, title_en=EXCLUDED.title_en,
            poster_url=EXCLUDED.poster_url, runtime=EXCLUDED.runtime, updated_at=NOW()
        `, [movieId, row.slug, movie.titleTH, row.title, movie.poster, movie.runtime]);

        const [h, m]  = row.time.split(':').map(Number);
        const showTime = new Date(`${today}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+07:00`);
        if (showTime < new Date()) continue;

        const sid = `everyday-${theater.id}-${row.slug}-${today}-${row.time.replace(':','')}${row.screen}`;
        await client.query(`
          INSERT INTO showtimes (id, cinema_id, movie_id, show_time, screen_name,
                                 screen_type, audio, subtitles, is_sold_out, booking_url, updated_at)
          VALUES ($1,$2,$3,$4,$5,'STANDARD',$6,$7,false,$8,NOW())
          ON CONFLICT (id) DO UPDATE SET is_sold_out=EXCLUDED.is_sold_out, updated_at=NOW()
        `, [
          sid,
          `major-${theater.id}`,
          movieId,
          showTime.toISOString(),
          row.screen ? `Screen ${row.screen}` : null,
          normalizeAudio(row.audio),
          row.subtitle ? [row.subtitle] : [],
          `https://www.majorcineplex.com/booking/search-results.php?cinemaId_1=${theater.code}`,
        ]);
        totalShowtimes++;
      }
    }

    console.log(`  ✅ Major done: ${Object.keys(movieCache).length} movies, ${totalShowtimes} showtimes`);

    // House Samyan
    await scrapeHouseSamyan(client, today);

  } catch (err) {
    console.error('  ❌ Scrape failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { scrapeEveryday };
