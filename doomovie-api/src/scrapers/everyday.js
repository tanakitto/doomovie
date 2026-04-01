// Scraper using showtimes.everyday.in.th as data source
// Strategy:
//   1. Fetch all theaters from Sarun's API (has GPS + group + status)
//   2. For each operating theater, scrape HTML showtime page
//   3. Parse .showtimes-item elements for movies + times
//   4. Fetch movie detail pages for posters
// 
// Why this works:
//   - Sarun's server is Thai-hosted → no SF 403, no Major session issue
//   - His HTML pages are publicly accessible, no auth needed
//   - Data is real and updated (he's been running this 10 years)

const axios   = require('axios');
const cheerio = require('cheerio');
const { pool } = require('../db');

const BASE    = 'https://showtimes.everyday.in.th';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Referer':    'https://showtimes.everyday.in.th/',
};
const API_HEADERS = { ...HEADERS, 'Accept': 'application/json' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse GPS from WKT: "SRID=4326;POINT (100.53 13.7447)"
function parsePoint(point) {
  const m = point?.match(/POINT \(([0-9.-]+) ([0-9.-]+)\)/);
  if (!m) return { lat: null, lng: null };
  return { lat: parseFloat(m[2]), lng: parseFloat(m[1]) };
}

// Map Sarun's group code to our source field
function mapSource(group) {
  const map = { major: 'major', sf: 'sf', house: 'house', 'house-samyan': 'house' };
  return map[group] || group;
}

// Fetch all theaters from API
async function fetchTheaters() {
  console.log('  → Fetching theater list...');
  const theaters = [];
  let url = `${BASE}/api/v2/theater/?limit=50&format=json`;

  while (url) {
    const res  = await axios.get(url, { headers: API_HEADERS, timeout: 15000 });
    const data = res.data;
    theaters.push(...data.results);
    url = data.next;
    await sleep(200);
  }

  // Filter only operating cinemas
  const operating = theaters.filter(t => t.status === 'operate');
  console.log(`  → ${operating.length} operating theaters (of ${theaters.length} total)`);
  return operating;
}

// Scrape showtime HTML page for a theater
async function scrapeTheaterPage(theater) {
  const url = `${BASE}/theater/${theater.group.code}/${theater.id}/`;
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $   = cheerio.load(res.data);
    const showtimes = [];

    $('.showtimes-item').each((_, item) => {
      const $item   = $(item);
      const titleEl = $item.find('h4 a');
      const title   = titleEl.text().trim();
      const slug    = titleEl.attr('href')?.match(/\/movie\/([^\/]+)\//)?.[1];
      if (!title || !slug) return;

      // Language/audio info
      const descItems = $item.find('ul.desc li').map((_, li) => $(li).text().trim()).get();
      const audio     = descItems[0] || 'th';
      const subtitle  = descItems[1] || '';

      // Screen number
      const screen = $item.find('.screen').text().trim();

      // Times
      $item.find('ul.times li').each((_, li) => {
        const time = $(li).text().trim();
        if (!time.match(/^\d{2}:\d{2}$/)) return;
        showtimes.push({ title, slug, time, audio, subtitle, screen });
      });
    });

    return showtimes;
  } catch (err) {
    console.warn(`    ⚠️  ${theater.english}: ${err.message}`);
    return [];
  }
}

// Fetch movie detail for poster + metadata
const movieCache = {};
async function fetchMovieDetail(slug) {
  if (movieCache[slug]) return movieCache[slug];

  try {
    const res = await axios.get(`${BASE}/movie/${slug}/`, { headers: HEADERS, timeout: 10000 });
    const $   = cheerio.load(res.data);

    // Poster from passport-go CDN
    const poster = $('img[src*="passport-go"]').first().attr('src') ||
                   $('img[src*="stth"]').first().attr('src') ||
                   null;

    // Title
    const titleTH = $('h1, h2').first().text().trim().replace(/\s*\(\d{4}\)\s*$/, '');
    const titleEN = $('[lang="en"], .title-en').first().text().trim() || null;

    // Duration
    const durationMatch = $('body').text().match(/(\d+)\s*min/i);
    const runtime = durationMatch ? parseInt(durationMatch[1]) : null;

    // Rating
    const rating = $('[class*="rating"], .classification').first().text().trim() || null;

    // Synopsis
    const synopsis = $('[class*="storyline"], [class*="synopsis"], .description p').first().text().trim().slice(0, 500) || null;

    // TMDB link for future enrichment
    const tmdbUrl = $('a[href*="themoviedb"]').first().attr('href') || null;

    const movie = { slug, poster, titleTH, titleEN, runtime, rating, synopsis, tmdbUrl };
    movieCache[slug] = movie;
    await sleep(150);
    return movie;
  } catch {
    movieCache[slug] = { slug, poster: null, titleTH: null, titleEN: null };
    return movieCache[slug];
  }
}

// Build booking URL — deeplink to cinema's official booking page
function buildBookingUrl(theater, slug, date, time) {
  const group = theater.group.code;
  if (group === 'major') {
    return `https://www.majorcineplex.com/booking/search-results.php?cinemaId_1=${theater.code}`;
  }
  if (group === 'sf') {
    return `https://www.sfcinema.com`;
  }
  if (group === 'house' || group === 'house-samyan') {
    return `https://www.housesamyan.com`;
  }
  return `${BASE}/theater/${group}/${theater.id}/`;
}

function normalizeAudio(audio) {
  const a = (audio || '').toLowerCase();
  if (a.includes('en')) return 'EN';
  if (a.includes('th')) return 'TH';
  if (a.includes('ja') || a.includes('jp')) return 'JA';
  if (a.includes('ko') || a.includes('kr')) return 'KO';
  return audio.toUpperCase() || 'TH';
}

// Main scraper
async function scrapeEveryday() {
  console.log('🎬 Scraper: starting via showtimes.everyday.in.th...');
  const client = await pool.connect();

  try {
    // 1. Get theater list
    const theaters = await fetchTheaters();

    // 2. Upsert cinemas
    for (const t of theaters) {
      const { lat, lng } = parsePoint(t.point);
      const source = mapSource(t.group.code);
      await client.query(`
        INSERT INTO cinemas (id, source, source_id, name_en, name_th, lat, lng, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name_en=EXCLUDED.name_en, name_th=EXCLUDED.name_th,
          lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=NOW()
      `, [
        `${source}-${t.id}`, source, String(t.id),
        t.english, t.thai, lat, lng
      ]);
    }
    console.log(`  ✅ ${theaters.length} cinemas upserted`);

    // 3. Scrape showtimes for each theater
    const today = new Date().toISOString().split('T')[0];
    let totalShowtimes = 0;
    const slugsToFetch = new Set();

    // First pass: collect all slugs & showtimes
    const allShowtimes = [];
    for (const theater of theaters) {
      const rows = await scrapeTheaterPage(theater);
      rows.forEach(r => slugsToFetch.add(r.slug));
      allShowtimes.push({ theater, rows });
      if (rows.length) {
        console.log(`  → ${theater.english}: ${rows.length} slots`);
      }
      await sleep(300);
    }

    // Second pass: fetch all unique movie details
    console.log(`  → Fetching ${slugsToFetch.size} unique movie details...`);
    for (const slug of slugsToFetch) {
      await fetchMovieDetail(slug);
    }

    // Third pass: upsert movies + showtimes
    for (const { theater, rows } of allShowtimes) {
      const source   = mapSource(theater.group.code);
      const cinemaId = `${source}-${theater.id}`;

      for (const row of rows) {
        const movie = movieCache[row.slug];
        if (!movie) continue;

        const movieId = `everyday-${row.slug}`;

        // Upsert movie
        await client.query(`
          INSERT INTO movies (id, source, source_id, title_en, title_th, poster_url,
                              synopsis, runtime, rating, updated_at)
          VALUES ($1,'everyday',$2,$3,$4,$5,$6,$7,$8,NOW())
          ON CONFLICT (id) DO UPDATE SET
            title_en=EXCLUDED.title_en, title_th=EXCLUDED.title_th,
            poster_url=EXCLUDED.poster_url, synopsis=EXCLUDED.synopsis,
            runtime=EXCLUDED.runtime, rating=EXCLUDED.rating, updated_at=NOW()
        `, [
          movieId, row.slug,
          movie.titleEN || movie.titleTH,
          movie.titleTH,
          movie.poster,
          movie.synopsis,
          movie.runtime,
          movie.rating,
        ]);

        // Build show datetime (assume Bangkok timezone)
        const [h, m] = row.time.split(':').map(Number);
        const showTime = new Date(`${today}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+07:00`);
        if (showTime < new Date()) continue;

        const showtimeId = `everyday-${theater.id}-${row.slug}-${today}-${row.time.replace(':','')}${row.screen}`;

        await client.query(`
          INSERT INTO showtimes (id, cinema_id, movie_id, show_time, screen_name,
                                 screen_type, audio, subtitles, is_sold_out, booking_url, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
          ON CONFLICT (id) DO UPDATE SET
            is_sold_out=EXCLUDED.is_sold_out, updated_at=NOW()
        `, [
          showtimeId, cinemaId, movieId,
          showTime.toISOString(),
          row.screen ? `Screen ${row.screen}` : null,
          'STANDARD',
          normalizeAudio(row.audio),
          row.subtitle ? [row.subtitle] : [],
          false,
          buildBookingUrl(theater, row.slug, today, row.time),
        ]);
        totalShowtimes++;
      }
    }

    console.log(`  ✅ Scrape done: ${Object.keys(movieCache).length} movies, ${totalShowtimes} showtimes`);
  } catch (err) {
    console.error('  ❌ Scrape failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { scrapeEveryday };
