// House Samyan scraper
// Main page is server-rendered HTML — parse with Cheerio
// Seat/detail data available via JSON API per session

const axios   = require('axios');
const cheerio = require('cheerio');
const { pool } = require('../db');

const BASE_URL = 'https://www.housesamyan.com';
// House Samyan has only one location — hardcoded from research
const CINEMA = {
  id:     'house-samyan',
  nameEN: 'House Samyan',
  nameTH: 'เฮาส์ สามย่าน',
  lat:    13.7318,
  lng:    100.5269,
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*',
  'Referer': 'https://www.housesamyan.com/',
};

// ─── Fetch and parse the main showtimes page ──────────────────────────────────
async function fetchMainPage() {
  const res = await axios.get(BASE_URL, { headers: HEADERS, timeout: 10000 });
  return res.data;
}

// ─── Fetch session detail (seat layout, pricing, full movie info) ────────────
async function fetchSessionDetail(showtimeId) {
  const res = await axios.get(
    `${BASE_URL}/get_showtime_seat?showtimes_id=${showtimeId}`,
    { headers: { ...HEADERS, 'Accept': 'application/json' }, timeout: 10000 }
  );
  return res.data;
}

// ─── Parse the main page HTML ─────────────────────────────────────────────────
function parseMainPage(html) {
  const $ = cheerio.load(html);
  const showtimes = [];

  // House Samyan groups by screen (House 3, House 4, House 5)
  // Their HTML structure: each screen section contains movie + time slots
  $('[class*="screen"], [class*="theater"], .showtime-section, .house-section').each((_, screenEl) => {
    const $screen    = $(screenEl);
    const screenName = $screen.find('.screen-name, .theater-name, h3, h4').first().text().trim();

    $screen.find('.movie-item, .showtime-item, [class*="movie"]').each((_, movieEl) => {
      const $movie     = $(movieEl);
      const titleTH    = $movie.find('.movie-title, .title').first().text().trim();
      const showtimeId = $movie.find('[data-id], [data-showtime-id]').attr('data-id')
                      || $movie.find('a[href*="showtimes_id"]').attr('href')?.match(/showtimes_id=(\d+)/)?.[1];
      const timeText   = $movie.find('.time, .showtime-time').text().trim();
      const dateText   = $movie.find('.date, .showtime-date').text().trim();

      if (showtimeId || timeText) {
        showtimes.push({
          showtimeId,
          screenName: screenName || 'House',
          titleTH,
          timeText,
          dateText,
        });
      }
    });
  });

  // Fallback: look for any time slots with showtime IDs
  if (showtimes.length === 0) {
    $('a[href*="showtimes_id"], [data-showtimes-id], [onclick*="showtimes_id"]').each((_, el) => {
      const $el        = $(el);
      const href       = $el.attr('href') || $el.attr('onclick') || '';
      const showtimeId = href.match(/showtimes_id[=_](\d+)/)?.[1];
      const timeText   = $el.text().trim();
      const $parent    = $el.closest('[class*="movie"],[class*="show"],[class*="item"]');
      const titleTH    = $parent.find('[class*="title"]').text().trim();
      const screenName = $el.closest('[class*="screen"],[class*="house"],[class*="theater"]')
                           .find('h3,h4,.name').first().text().trim() || 'House';

      if (showtimeId) {
        showtimes.push({ showtimeId, screenName, titleTH, timeText, dateText: '' });
      }
    });
  }

  return showtimes;
}

// ─── Enrich a showtime with detail API data ───────────────────────────────────
async function enrichShowtime(raw) {
  try {
    const detail = await fetchSessionDetail(raw.showtimeId);
    // Response shape from research: { start_time, end_time, theater_name, movie: {...}, seats: [...] }
    const movie = detail.movie || detail.Movie || {};
    return {
      id:          `house-${raw.showtimeId}`,
      cinemaId:    CINEMA.id,
      movieId:     `house-movie-${movie.id || raw.showtimeId}`,
      titleTH:     movie.title || raw.titleTH,
      titleEN:     movie.title_en || movie.title || raw.titleTH,
      poster:      movie.poster_web_path ? `${BASE_URL}${movie.poster_web_path}` : null,
      trailer:     movie.trailer_mobile_path || null,
      rating:      movie.rate_name || null,
      showTime:    new Date(detail.start_time || `${raw.dateText} ${raw.timeText}`),
      screenName:  detail.theater_name || raw.screenName,
      screenType:  normalizeScreenType(detail.theater_name || raw.screenName),
      audio:       movie.language === 'English' ? 'EN' : 'TH',
      subtitles:   movie.language === 'English' ? ['TH'] : [],
      isSoldOut:   false, // House Samyan rarely sells out
      bookingUrl:  `${BASE_URL}/buy-ticket?showtimes_id=${raw.showtimeId}`,
    };
  } catch (err) {
    // Detail fetch failed — use whatever we parsed from main page
    return {
      id:         `house-${raw.showtimeId}`,
      cinemaId:   CINEMA.id,
      movieId:    null,
      titleTH:    raw.titleTH,
      titleEN:    raw.titleTH,
      poster:     null,
      showTime:   raw.timeText ? new Date(`${raw.dateText} ${raw.timeText}`) : null,
      screenName: raw.screenName,
      screenType: normalizeScreenType(raw.screenName),
      audio:      'TH',
      subtitles:  [],
      isSoldOut:  false,
      bookingUrl: `${BASE_URL}`,
    };
  }
}

function normalizeScreenType(name = '') {
  const s = name.toUpperCase();
  if (s.includes('LASER')) return 'LASER';
  if (s.includes('IMAX'))  return 'IMAX';
  return 'STANDARD';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main scrape function ─────────────────────────────────────────────────────
async function scrapeHouse() {
  console.log('🎬 House Samyan: starting scrape...');
  const client = await pool.connect();

  try {
    // ── Upsert cinema ─────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO cinemas (id, source, source_id, name_th, name_en, lat, lng, updated_at)
      VALUES ($1, 'house', $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
    `, [CINEMA.id, 'samyan', CINEMA.nameTH, CINEMA.nameEN, CINEMA.lat, CINEMA.lng]);

    // ── Parse main page ───────────────────────────────────────────────────────
    const html = await fetchMainPage();
    const rawShowtimes = parseMainPage(html);
    console.log(`  → Found ${rawShowtimes.length} showtime slots`);

    let inserted = 0;
    const movieCache = {};

    for (const raw of rawShowtimes) {
      if (!raw.showtimeId) continue;

      const st = await enrichShowtime(raw);
      await sleep(200); // polite delay between detail requests

      if (!st.showTime || isNaN(st.showTime.getTime())) continue;
      if (st.showTime < new Date()) continue;

      // Upsert movie
      if (st.movieId && !movieCache[st.movieId]) {
        await client.query(`
          INSERT INTO movies (id, source, source_id, title_th, title_en, poster_url, rating, trailer_url, updated_at)
          VALUES ($1, 'house', $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (id) DO UPDATE SET
            title_th   = EXCLUDED.title_th,
            title_en   = EXCLUDED.title_en,
            poster_url = EXCLUDED.poster_url,
            updated_at = NOW()
        `, [st.movieId, raw.showtimeId, st.titleTH, st.titleEN, st.poster, st.rating, st.trailer]);
        movieCache[st.movieId] = true;
      }

      // Upsert showtime
      await client.query(`
        INSERT INTO showtimes (id, cinema_id, movie_id, show_time, screen_name, screen_type,
                               audio, subtitles, is_sold_out, booking_url, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (id) DO UPDATE SET
          is_sold_out = EXCLUDED.is_sold_out,
          updated_at  = NOW()
      `, [
        st.id, st.cinemaId, st.movieId, st.showTime.toISOString(),
        st.screenName, st.screenType, st.audio, st.subtitles,
        st.isSoldOut, st.bookingUrl,
      ]);
      inserted++;
    }

    console.log(`  ✅ House Samyan done: ${inserted} showtimes upserted`);
  } catch (err) {
    console.error('  ❌ House Samyan scrape failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { scrapeHouse };
