# doomovie.today — API

Thailand cinema showtime aggregator. Scrapes Major Cineplex, SF Cinema, and House Samyan every 3 hours.

## Stack
- **Node.js + Express** — API server
- **PostgreSQL** — showtime cache (Railway)
- **Cheerio + Axios** — scraping
- **node-cron** — scheduled scrapes

## Setup

### 1. Clone and install
```bash
git clone https://github.com/yourusername/doomovie-api
cd doomovie-api
npm install
```

### 2. Environment variables
```bash
cp .env.example .env
# Fill in DATABASE_URL and TMDB_API_KEY
```

### 3. Add major_cinemas.json
Place your geocoded `major_cinemas.json` file in the `data/` folder.
This is committed to the repo — it never changes at runtime.

### 4. Run locally
```bash
npm run dev        # starts with nodemon (auto-reload)
npm start          # production
npm run scrape     # run scrapers once manually
```

### 5. Deploy to Railway
1. Push to GitHub
2. Connect repo in Railway
3. Add environment variables in Railway dashboard
4. Railway auto-deploys on push

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Stats: cinema/movie/showtime counts + last scrape time |
| GET | `/api/cinemas` | All cinemas |
| GET | `/api/cinemas?lat=13.75&lng=100.52` | Cinemas sorted by distance |
| GET | `/api/cinemas?source=sf` | Filter by source (sf / major / house) |
| GET | `/api/movies/now-playing` | Movies with future showtimes |
| GET | `/api/movies/:id` | Single movie detail |
| GET | `/api/showtimes?cinema=major-1&date=2026-04-02` | Showtimes for a cinema |
| GET | `/api/showtimes?movie=sf-uuid&date=2026-04-02` | Showtimes for a movie |

## Data Sources

| Source | Method | GPS |
|--------|--------|-----|
| SF Cinema | JSON API (no scraping) | From their `/api/v1/branch` endpoint |
| Major Cineplex | Cheerio HTML scraper | `data/major_cinemas.json` (geocoded once) |
| House Samyan | Cheerio + JSON detail API | Hardcoded (single location) |

## File Structure
```
src/
  index.js          — Express server entry point
  db/index.js       — PostgreSQL connection + schema
  routes/index.js   — API route handlers
  scrapers/
    sf.js           — SF Cinema scraper
    major.js        — Major Cineplex scraper
    house.js        — House Samyan scraper
    run.js          — Orchestrator + cron scheduler
data/
  major_cinemas.json — Geocoded Major branch coordinates
```
