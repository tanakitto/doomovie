// Major Cineplex scraper
// Showtimes returned as HTML fragments — parsed with Cheerio
// GPS coords loaded from major_cinemas.json (one-time geocoded file)

const axios   = require('axios');
const cheerio = require('cheerio');
const path    = require('path');
const { pool } = require('../db');

// Load the geocoded cinema list — committed to repo, never changes at runtime
const CINEMAS = require('../../data/major_cinemas.json');

const BASE    = 'https://www.majorcineplex.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Referer': 'https://www.majorcineplex.com/',
};

// ─── Fetch showtime HTML for one cinema on one date ──────────────────────────
async function fetchShowtimes(cinemaId, date) {
  const url = `${BASE}/showtimes/get_showtime/?cinema=${cinemaId}&date=${date}`;
  const res = await axios.get(url, { headers: HEADERS, timeout: 10000 });
  return res.data;
}

// ─── Fetch now-playing movie list from Major's website ───────────────────────
async function fetchMovieList() {
  const res = await axios.get(`${BASE}/movie`, { headers: HEADERS, timeout: 10000 });
  const $ = cheerio.load(res.data);
  const movies = [];

  // Major's movie cards — adjust selector if their HTML changes
  $('.movie-item, .bx-movie-item, [data-movie-id]').each((_, el) => {
    const $el = $(el);
    const id  = $el.attr('data-movie-id') || $el.find('[data-movie-id]').attr('data-movie-id');
    const titleTH = $el.find('.movie-title-th, .title-th').text().trim();
    const titleEN = $el.find('.movie-title-en, .title-en').text().trim();
    const poster  = $el.find('img').attr('src') || $el.find('img').attr('data-src');
    const rating  = $el.find('.movie-rating, .rating').text().trim();
    if (id) movies.push({ id, titleTH, titleEN, poster, rating });
  });

  return movies;
}

// ─── Parse showtime HTML fragment ────────────────────────────────────────────
function parseShowtimeHtml(html, cinemaId, date) {
  const $ = cheerio.load(html);
  const showtimes = [];

  // Each movie block in Major's showtime HTML
  $('.box-showtime-cinema').each((_, movieBlock) => {
    const $block  = $(movieBlock);
    const movieId = $block.attr('data-movie-id') || $block.find('[data-movie-id]').attr('data-movie-id');
    const titleTH = $block.find('.bsc-movie-name-th').text().trim();
    const titleEN = $block.find('.bsc-movie-name-en').text().trim();
    const rating  = $block.find('.bsc-movie-rate').text().trim();
    const poster  = $block.find('img').attr('src');

    // Each screen type section (IMAX, Standard, etc.)
    $block.find('.bsc-list').each((_, screenBlock) => {
      const $screen    = $(screenBlock);
      const screenType = $screen.find('.bsc-screen-type, .screen-name').text().trim() || 'STANDARD';

      // Individual time slots
      $screen.find('.bsc-showtime a, .showtime-link, [data-session-id]').each((_, slot) => {
        const $slot     = $(slot);
        const timeText  = $slot.text().trim();                           // e.g. "14:30"
        const sessionId = $slot.attr('data-session-id') || $slot.attr('href')?.match(/session[_-]?id=(\w+)/)?.[1];
        const isSoldOut = $slot.hasClass('sold-out') || $slot.hasClass('soldout');
        const audio     = $slot.attr('data-audio') || detectAudio($slot.attr('class') || '');
        const subtitles = detectSubtitles($slot.attr('class') || '');

        if (!timeText.match(/^\d{1,2}:\d{2}$/)) return; // skip non-time text

        const [hours, minutes] = timeText.split(':').map(Number);
        const showTime = new Date(`${date}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00+07:00`);

        showtimes.push({
          id: sessionId ? `major-${sessionId}` : `major-${cinemaId}-${movieId}-${date}-${timeText}`,
          cinemaId: `major-${cinemaId}`,
          movieId:  movieId ? `major-${movieId}` : null,
          titleTH, titleEN, rating, poster,
          showTime,
          screenType: normalizeScreenType(screenType),
          audio,
          subtitles,
          isSoldOut,
          bookingUrl: sessionId
            ? `${BASE}/buy-ticket?session=${sessionId}`
            : `${BASE}/movie/${movieId}/showtime`,
        });
      });
    });
  });

  return showtimes;
}

// ─── Helper: detect audio language from CSS classes ──────────────────────────
function detectAudio(cls) {
  if (cls.includes('eng') || cls.includes('en-')) return 'EN';
  if (cls.includes('thai') || cls.includes('th-')) return 'TH';
  return 'TH'; // Major defaults to Thai dub
}

function detectSubtitles(cls) {
  const subs = [];
  if (cls.includes('sub-th') || cls.includes('thai-sub')) subs.push('TH');
  if (cls.includes('sub-en') || cls.includes('eng-sub'))  subs.push('EN');
  return subs;
}

// ─── Map Major's screen type strings to standard labels ──────────────────────
function normalizeScreenType(raw) {
  const s = raw.toUpperCase();
  if (s.includes('IMAX'))     return 'IMAX';
  if (s.includes('4DX'))      return '4DX';
  if (s.includes('ULTRA'))    return 'ULTRASCREEN';
  if (s.includes('LASER'))    return 'LASER';
  if (s.includes('DOLBY'))    return 'DOLBY';
  if (s.includes('DRIVE'))    return 'DRIVE-IN';
  return 'STANDARD';
}

// ─── Get next N dates to scrape ───────────────────────────────────────────────
function getDateRange(days = 7) {
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split('T')[0]); // "YYYY-MM-DD"
  }
  return dates;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main scrape function ─────────────────────────────────────────────────────
async function scrapeMajor() {
  console.log('🎬 Major Cineplex: starting scrape...');
  const client = await pool.connect();

  try {
    const dates = getDateRange(7);

    // ── Upsert cinemas from our geocoded JSON ─────────────────────────────────
    for (const cinema of CINEMAS) {
      if (!cinema.lat) continue; // skip any that failed geocoding
      await client.query(`
        INSERT INTO cinemas (id, source, source_id, name_th, name_en, lat, lng, updated_at)
        VALUES ($1, 'major', $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name_th    = EXCLUDED.name_th,
          name_en    = EXCLUDED.name_en,
          lat        = EXCLUDED.lat,
          lng        = EXCLUDED.lng,
          updated_at = NOW()
      `, [`major-${cinema.id}`, cinema.id, cinema.nameTH, cinema.nameTH, cinema.lat, cinema.lng]);
    }

    // ── Scrape showtimes for each cinema × each date ──────────────────────────
    let totalInserted = 0;
    const movieCache = {}; // avoid duplicate movie upserts

    for (const cinema of CINEMAS) {
      if (!cinema.lat) continue;

      for (const date of dates) {
        try {
          const html = await fetchShowtimeHtml(cinema.id, date);
          const showtimes = parseShowtimeHtml(html, cinema.id, date);

          for (const st of showtimes) {
            // Upsert movie if we have enough data and haven't done it yet
            if (st.movieId && !movieCache[st.movieId]) {
              await client.query(`
                INSERT INTO movies (id, source, source_id, title_th, title_en, poster_url, rating, updated_at)
                VALUES ($1, 'major', $2, $3, $4, $5, $6, NOW())
                ON CONFLICT (id) DO UPDATE SET
                  title_th   = EXCLUDED.title_th,
                  title_en   = EXCLUDED.title_en,
                  poster_url = EXCLUDED.poster_url,
                  rating     = EXCLUDED.rating,
                  updated_at = NOW()
              `, [st.movieId, st.movieId.replace('major-',''), st.titleTH, st.titleEN, st.poster, st.rating]);
              movieCache[st.movieId] = true;
            }

            // Upsert showtime
            if (st.movieId && st.showTime > new Date()) {
              await client.query(`
                INSERT INTO showtimes (id, cinema_id, movie_id, show_time, screen_type,
                                       audio, subtitles, is_sold_out, booking_url, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                ON CONFLICT (id) DO UPDATE SET
                  is_sold_out = EXCLUDED.is_sold_out,
                  updated_at  = NOW()
              `, [
                st.id, st.cinemaId, st.movieId, st.showTime.toISOString(),
                st.screenType, st.audio, st.subtitles,
                st.isSoldOut, st.bookingUrl,
              ]);
              totalInserted++;
            }
          }

          await sleep(300); // be polite between requests
        } catch (err) {
          // Log and continue — don't let one cinema/date failure kill the whole scrape
          console.warn(`  ⚠️  Major [${cinema.id}] ${date}: ${err.message}`);
        }
      }
    }

    console.log(`  ✅ Major Cineplex done: ${totalInserted} showtimes upserted`);
  } catch (err) {
    console.error('  ❌ Major scrape failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Named alias used in scraper ─────────────────────────────────────────────
async function fetchShowtimeHtml(cinemaId, date) {
  return fetchShowtimes(cinemaId, date);
}

module.exports = { scrapeMajor };
