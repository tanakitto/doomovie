// Scraper runner
// Runs all scrapers in sequence and schedules them via cron
// Can also be run manually: node src/scrapers/run.js

require('dotenv').config();
const cron = require('node-cron');
const { scrapeSF }    = require('./sf');
const { scrapeMajor } = require('./major');
const { scrapeHouse } = require('./house');

async function runAllScrapers() {
  const start = Date.now();
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🚀 Scrape started at ${new Date().toISOString()}`);
  console.log('═'.repeat(50));

  const results = { sf: 'pending', major: 'pending', house: 'pending' };

  // Run scrapers sequentially to avoid hammering servers simultaneously
  try {
    await scrapeSF();
    results.sf = '✅';
  } catch (err) {
    results.sf = `❌ ${err.message}`;
  }

  try {
    await scrapeMajor();
    results.major = '✅';
  } catch (err) {
    results.major = `❌ ${err.message}`;
  }

  try {
    await scrapeHouse();
    results.house = '✅';
  } catch (err) {
    results.house = `❌ ${err.message}`;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ Scrape complete in ${elapsed}s`);
  console.log(`   SF Cinema:    ${results.sf}`);
  console.log(`   Major:        ${results.major}`);
  console.log(`   House Samyan: ${results.house}`);
  console.log('═'.repeat(50) + '\n');
}

// If run directly (node src/scrapers/run.js), execute once immediately
if (require.main === module) {
  runAllScrapers().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

// Schedule via cron — default every 3 hours
function startCron() {
  const schedule = process.env.SCRAPE_CRON || '0 */3 * * *';
  console.log(`⏰ Scraper scheduled: ${schedule}`);
  cron.schedule(schedule, runAllScrapers, { timezone: 'Asia/Bangkok' });

  // Also run immediately on startup
  runAllScrapers();
}

module.exports = { runAllScrapers, startCron };
