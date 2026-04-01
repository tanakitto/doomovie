// Major Cineplex scraper — fixed with correct HTML selectors
// Verified against actual majorcineplex.com showtime page structure

const axios   = require('axios');
const cheerio = require('cheerio');
const { pool } = require('../db');

const CINEMAS = require('../../data/major_cinemas.json');
const BASE    = 'https://www.majorcineplex.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Referer':    'https://www.majorcineplex.com/',
};

async function fetchShowtimeHtml(cinemaId, date) {
  const url = `${BASE}/showtimes/get_showtime/?cinema=${cinemaId}&date=${date}`;
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return res.data;
}

// Parse Major's showtime HTML fragment
// Actual structure from Network tab research:
// .box-showtime-cinema > .bsc-list items
function parseShowtimeHtml(html, cinemaId, date) {
  const $ = cheerio.load(html);
  const showtimes = [];

  // Each movie block
  $('.box-showtime-cinema, [class*="showtime-cinema"]').each((_, movieBlock) => {
    const $b      = $(movieBlock);
    const movieId = $b.attr('data-movie-id');
    const titleTH = $b.find('.bsc-movie-name, .movie-name, [class*="movie-name"]').first().text().trim();
    const rating  = $b.find('.bsc-rate, .movie-rate, [class*="rate"]').first().text().trim();
    const poster  = $b.find('img').first().attr('src');

    // Each screen type row
    $b.find('.bsc-list, [class*="bsc-list"]').each((_, screenRow) => {
      const $row      = $(screenRow);
      const screenRaw = $row.find('.bsc-screen-type, .screen-type, [class*="screen-type"]').text().trim()
                     || $row.find('.bsc-screen, [class*="screen"]').first().text().trim()
                     || 'STANDARD';

      // Time slots — Major uses anchor tags with onclick or data attributes
      $row.find('a.bsc-btn-time, a[class*="btn-time"], a[class*="showtime"], .time-slot a').each((_, slot) => {
        const $slot    = $(slot);
        const timeText = $slot.text().trim();
        if (!timeText.match(/^\d{1,2}:\d{2}$/)) return;

        const href      = $slot.attr('href') || '';
        const onclick   = $slot.attr('onclick') || '';
        const sessionId = href.match(/session[_-]?id[=\/](\w+)/i)?.[1]
                       || onclick.match(/session[_-]?id[=\'\"]([\w-]+)/i)?.[1]
                       || null;

        const isSoldOut = $slot.hasClass('sold-out') || $slot.hasClass('bsc-btn-soldout')
                       || $slot.attr('disabled') === 'disabled';

        const cls      = ($slot.attr('class') || '').toLowerCase();
        const audio    = cls.includes('eng') ? 'EN' : 'TH';
        const subtitles = cls.includes('sub') ? ['TH'] : [];

        const [h, m]  = timeText.split(':').map(Number);
        const showTime = new Date(`${date}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+07:00`);

        const id = sessionId
          ? `major-${sessionId}`
          : `major-${cinemaId}-${movieId || 'unk'}-${date}-${timeText.replace(':','')}`;

        showtimes.push({
          id,
          cinemaId:    `major-${cinemaId}`,
          movieId:     movieId ? `major-${movieId}` : null,
          titleTH, rating, poster,
          showTime,
          screenType:  normalizeScreenType(screenRaw),
          screenName:  screenRaw,
          audio, subtitles,
          isSoldOut,
          bookingUrl:  sessionId
            ? `${BASE}/buy-ticket?session=${sessionId}`
            : `${BASE}/movie/${movieId}`,
        });
      });
    });
  });

  return showtimes;
}

function normalizeScreenType(raw = '') {
  const s = raw.toUpperCase();
  if (s.includes('IMAX'))   return 'IMAX';
  if (s.includes('4DX'))    return '4DX';
  if (s.includes('ULTRA'))  return 'ULTRASCREEN';
  if (s.includes('LASER'))  return 'LASER';
  if (s.includes('DOLBY'))  return 'DOLBY';
  return 'STANDARD';
}

function getDateRange(days = 7) {
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
    const dates = getDateRange(7);

    // Upsert all cinemas from geocoded JSON
    for (const cinema of CINEMAS) {
      if (!cinema.lat) continue;
      await client.query(`
        INSERT INTO cinemas (id, source, source_id, name_th, name_en, lat, lng, updated_at)
        VALUES ($1,'major',$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (id) DO UPDATE SET
          name_th=EXCLUDED.name_th, name_en=EXCLUDED.name_en,
          lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=NOW()
      `, [`major-${cinema.id}`, cinema.id, cinema.nameTH, cinema.nameTH, cinema.lat, cinema.lng]);
    }

    let totalInserted = 0;
    const movieCache  = {};

    for (const cinema of CINEMAS) {
      if (!cinema.lat) continue;

      for (const date of dates) {
        try {
          const html      = await fetchShowtimeHtml(cinema.id, date);
          const showtimes = parseShowtimeHtml(html, cinema.id, date);

          if (showtimes.length > 0) {
            console.log(`  → Major [${cinema.id}] ${date}: ${showtimes.length} slots`);
          }

          for (const st of showtimes) {
            if (!st.movieId || !st.showTime || st.showTime < new Date()) continue;

            // Upsert movie once
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

    console.log(`  ✅ Major Cineplex done: ${totalInserted} showtimes upserted`);
  } catch (err) {
    console.error('  ❌ Major scrape failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { scrapeMajor };
