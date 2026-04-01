// Major Cineplex scraper — fixed export and selectors
// Confirmed endpoint: GET /showtimes/get_showtime/?cinema={id}&date={YYYY-MM-DD}

const axios   = require('axios');
const cheerio = require('cheerio');
const { pool } = require('../db');

// Load geocoded cinema list
const CINEMAS = require('../../data/major_cinemas.json');

const BASE    = 'https://www.majorcineplex.com';
const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Referer':         'https://www.majorcineplex.com/',
  'X-Requested-With':'XMLHttpRequest',
};

async function fetchShowtimeHtml(cinemaId, date) {
  const url = `${BASE}/showtimes/get_showtime/?cinema=${cinemaId}&date=${date}`;
  const res  = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return res.data;
}

function parseShowtimes(html, cinemaId, date) {
  const $   = cheerio.load(html);
  const out = [];

  // Major's actual HTML structure from Network tab research
  // Each movie block has class box-showtime-cinema or bsc-*
  $('[class*="box-showtime"], .bsc-movie, [data-movie-id]').each((_, el) => {
    const $el     = $(el);
    const movieId = $el.attr('data-movie-id') || $el.closest('[data-movie-id]').attr('data-movie-id');
    const titleTH = $el.find('[class*="movie-name"], [class*="movie-title"]').first().text().trim();
    const rating  = $el.find('[class*="rate"], [class*="rating"]').first().text().trim();
    const poster  = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src');

    // Screen type rows
    $el.find('[class*="bsc-list"], [class*="screen-list"], [class*="showtime-list"]').each((_, row) => {
      const $row      = $(row);
      const screenRaw = $row.find('[class*="screen-type"], [class*="screen-name"]').first().text().trim() || 'STANDARD';

      // Time buttons
      $row.find('a[class*="time"], a[class*="btn"], .bsc-btn-time').each((_, btn) => {
        const $btn    = $(btn);
        const time    = $btn.text().trim();
        if (!time.match(/^\d{1,2}:\d{2}$/)) return;

        const isSoldOut = $btn.hasClass('sold-out') || $btn.hasClass('bsc-btn-soldout');
        const href      = $btn.attr('href') || '';
        const sessionId = href.match(/session[_=](\w+)/i)?.[1];
        const cls       = ($btn.attr('class') || '').toLowerCase();
        const audio     = cls.includes('eng') ? 'EN' : 'TH';

        const [h, m] = time.split(':').map(Number);
        const showTime = new Date(`${date}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+07:00`);

        out.push({
          id:          sessionId ? `major-${sessionId}` : `major-${cinemaId}-${movieId||'x'}-${date}-${time.replace(':','')}`,
          cinemaId:    `major-${cinemaId}`,
          movieId:     movieId ? `major-${movieId}` : null,
          titleTH, rating, poster,
          showTime,
          screenType:  normalizeScreen(screenRaw),
          screenName:  screenRaw,
          audio,
          subtitles:   [],
          isSoldOut,
          bookingUrl:  sessionId ? `${BASE}/buy-ticket?session=${sessionId}` : `${BASE}/movie/${movieId}`,
        });
      });
    });
  });

  return out;
}

function normalizeScreen(raw = '') {
  const s = raw.toUpperCase();
  if (s.includes('IMAX'))  return 'IMAX';
  if (s.includes('4DX'))   return '4DX';
  if (s.includes('ULTRA')) return 'ULTRASCREEN';
  if (s.includes('LASER')) return 'LASER';
  if (s.includes('DOLBY')) return 'DOLBY';
  return 'STANDARD';
}

function getDates(days = 7) {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i);
    return d.toISOString().split('T')[0];
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeMajor() {
  console.log('🎬 Major Cineplex: starting scrape...');
  const client = await pool.connect();

  try {
    const dates = getDates(7);

    // Upsert cinemas
    for (const c of CINEMAS) {
      if (!c.lat) continue;
      await client.query(`
        INSERT INTO cinemas (id, source, source_id, name_th, name_en, lat, lng, updated_at)
        VALUES ($1,'major',$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (id) DO UPDATE SET
          name_th=EXCLUDED.name_th, name_en=EXCLUDED.name_en,
          lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=NOW()
      `, [`major-${c.id}`, c.id, c.nameTH, c.nameTH, c.lat, c.lng]);
    }

    let totalInserted = 0;
    const movieCache  = {};

    for (const cinema of CINEMAS) {
      if (!cinema.lat) continue;
      for (const date of dates) {
        try {
          const html      = await fetchShowtimeHtml(cinema.id, date);
          const showtimes = parseShowtimes(html, cinema.id, date);

          if (showtimes.length > 0) {
            console.log(`  → Major [${cinema.id}] ${date}: ${showtimes.length} slots`);
          }

          for (const st of showtimes) {
            if (!st.movieId || st.showTime < new Date()) continue;

            if (!movieCache[st.movieId]) {
              await client.query(`
                INSERT INTO movies (id, source, source_id, title_th, title_en, poster_url, rating, updated_at)
                VALUES ($1,'major',$2,$3,$4,$5,$6,NOW())
                ON CONFLICT (id) DO UPDATE SET
                  title_th=EXCLUDED.title_th, title_en=EXCLUDED.title_en,
                  poster_url=EXCLUDED.poster_url, rating=EXCLUDED.rating, updated_at=NOW()
              `, [st.movieId, st.movieId.replace('major-',''), st.titleTH, st.titleTH, st.poster, st.rating]);
              movieCache[st.movieId] = true;
            }

            await client.query(`
              INSERT INTO showtimes (id, cinema_id, movie_id, show_time, screen_name, screen_type,
                                     audio, subtitles, is_sold_out, booking_url, updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
              ON CONFLICT (id) DO UPDATE SET is_sold_out=EXCLUDED.is_sold_out, updated_at=NOW()
            `, [
              st.id, st.cinemaId, st.movieId, st.showTime.toISOString(),
              st.screenName, st.screenType, st.audio, st.subtitles,
              st.isSoldOut, st.bookingUrl,
            ]);
            totalInserted++;
          }
          await sleep(300);
        } catch (err) {
          console.warn(`  ⚠️  Major [${cinema.id}] ${date}: ${err.message}`);
        }
      }
    }

    console.log(`  ✅ Major done: ${totalInserted} showtimes upserted`);
  } catch (err) {
    console.error('  ❌ Major failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { scrapeMajor };
