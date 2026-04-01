// House Samyan scraper — fixed with correct URL and HTML structure
// Schedule page: https://www.housesamyan.com/site/schedule
// Structure: h2 = screen name, then alternating: movie link, time text

const axios   = require('axios');
const cheerio = require('cheerio');
const { pool } = require('../db');

const BASE_URL = 'https://www.housesamyan.com';
const SCHEDULE = `${BASE_URL}/site/schedule`;

const CINEMA = {
  id:     'house-samyan',
  nameEN: 'House Samyan',
  nameTH: 'เฮ้าส์ สามย่าน',
  lat:    13.7318,
  lng:    100.5269,
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':     'text/html,application/xhtml+xml',
  'Referer':    'https://www.housesamyan.com/',
};

// Fetch detail for a movie by its ID
async function fetchMovieDetail(movieId) {
  try {
    const res = await axios.get(`${BASE_URL}/site/Movie/detail/${movieId}`, { headers: HEADERS, timeout: 10000 });
    const $   = cheerio.load(res.data);
    // Extract poster, title, synopsis from movie detail page
    const poster   = $('img[src*="poster"]').first().attr('src') || null;
    const titleEN  = $('h1, .movie-title, [class*="title"]').first().text().trim();
    const synopsis = $('[class*="synopsis"], [class*="story"], .detail').first().text().trim();
    return { poster: poster ? `${BASE_URL}${poster}` : null, titleEN, synopsis };
  } catch {
    return { poster: null, titleEN: '', synopsis: '' };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeHouse() {
  console.log('🎬 House Samyan: starting scrape...');
  const client = await pool.connect();

  try {
    // Upsert cinema
    await client.query(`
      INSERT INTO cinemas (id, source, source_id, name_th, name_en, lat, lng, updated_at)
      VALUES ($1,'house','samyan',$2,$3,$4,$5,NOW())
      ON CONFLICT (id) DO UPDATE SET updated_at=NOW()
    `, [CINEMA.id, CINEMA.nameTH, CINEMA.nameEN, CINEMA.lat, CINEMA.lng]);

    // Fetch schedule page
    const res = await axios.get(SCHEDULE, { headers: HEADERS, timeout: 15000 });
    const $   = cheerio.load(res.data);

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD Bangkok
    const showtimes = [];
    const movieCache = {};

    // Structure: h2 = screen name, then pairs of: <a href="/site/Movie/detail/{id}">title</a> + text node with time
    $('h2').each((_, screenEl) => {
      const screenName = $(screenEl).text().trim(); // "HOUSE 3", "HOUSE 4", "HOUSE 5"
      let $el = $(screenEl).next();

      while ($el.length && $el[0].tagName !== 'h2') {
        const $link = $el.is('a') ? $el : $el.find('a');
        if ($link.length) {
          const href    = $link.attr('href') || '';
          const movieId = href.match(/\/detail\/(\d+)/)?.[1];
          const title   = $link.text().trim();
          // Time is the next text node or element
          const $next   = $el.next();
          const timeText = $next.text().trim();

          if (movieId && timeText.match(/^\d{1,2}:\d{2}$/)) {
            const [h, m] = timeText.split(':').map(Number);
            const showTime = new Date(`${today}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+07:00`);

            showtimes.push({
              movieId,
              title,
              screenName,
              timeText,
              showTime,
              bookingUrl: `${BASE_URL}/site/Movie/detail/${movieId}`,
            });

            if (!movieCache[movieId]) {
              movieCache[movieId] = { title, poster: null };
            }
          }
        }
        $el = $el.next();
      }
    });

    console.log(`  → Found ${showtimes.length} showtimes across ${Object.keys(movieCache).length} movies`);

    // Upsert movies
    for (const [movieId, movie] of Object.entries(movieCache)) {
      const dbMovieId = `house-${movieId}`;
      await client.query(`
        INSERT INTO movies (id, source, source_id, title_en, title_th, updated_at)
        VALUES ($1,'house',$2,$3,$4,NOW())
        ON CONFLICT (id) DO UPDATE SET title_en=EXCLUDED.title_en, updated_at=NOW()
      `, [dbMovieId, movieId, movie.title, movie.title]);
    }

    // Upsert showtimes
    let inserted = 0;
    const now = new Date();
    for (const st of showtimes) {
      if (st.showTime < now) continue;
      const id = `house-${st.movieId}-${st.screenName.replace(/\s/g,'')}-${st.timeText.replace(':','')}`;
      await client.query(`
        INSERT INTO showtimes (id, cinema_id, movie_id, show_time, screen_name, screen_type,
                               audio, subtitles, is_sold_out, booking_url, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT (id) DO UPDATE SET updated_at=NOW()
      `, [
        id, CINEMA.id, `house-${st.movieId}`,
        st.showTime.toISOString(),
        st.screenName, 'STANDARD',
        'EN', ['TH'], false, st.bookingUrl,
      ]);
      inserted++;
    }

    console.log(`  ✅ House Samyan done: ${inserted} showtimes upserted`);
  } catch (err) {
    console.error('  ❌ House Samyan failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { scrapeHouse };
