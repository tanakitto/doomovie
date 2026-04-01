// Scraper runner — uses showtimes.everyday.in.th as data source
// This bypasses SF 403 and Major session issues since Sarun's site is Thai-hosted

const cron = require('node-cron');
const { scrapeEveryday } = require('./everyday');

async function runScrape() {
  const start = Date.now();
  console.log('\n' + '='.repeat(50));
  console.log(`🚀 Scrape started at ${new Date().toISOString()}`);
  console.log('='.repeat(50));

  try {
    await scrapeEveryday();
  } catch (err) {
    console.error('❌ Scrape error:', err.message);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('='.repeat(50));
  console.log(`✅ Scrape complete in ${elapsed}s`);
  console.log('='.repeat(50));
}

// Run immediately on startup
runScrape();

// Then every 3 hours
cron.schedule('0 */3 * * *', runScrape, { timezone: 'Asia/Bangkok' });
console.log('⏰ Scraper scheduled: 0 */3 * * *');

module.exports = { runScrape };
