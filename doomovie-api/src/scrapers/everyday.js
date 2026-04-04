// Orchestrates all scrapers:
//   - Major Cineplex (direct API, requires MAJOR_COOKIE env var)
//   - House Samyan  (direct scrape, no auth needed)
// SF Cinema excluded until a Thai-IP solution is found

const { scrapeMajor } = require('./major');
const { scrapeHouse } = require('./house');

async function scrapeEveryday() {
  await scrapeMajor();
  await scrapeHouse();
}

module.exports = { scrapeEveryday };