import { redis } from '../src/store/redis.js';

async function main() {
  const coin = 'XRP';
  const crashPrice = '1.08'; // below liquidationPx of 1.0955

  console.log(`Forcing ${coin} price to $${crashPrice} repeatedly for 15 seconds...`);

  const interval = setInterval(async () => {
    await redis.hset('market:mids', coin, crashPrice);
    console.log(`  → re-forced price to ${crashPrice} at ${new Date().toISOString()}`);
  }, 500); // every half second

  setTimeout(() => {
    clearInterval(interval);
    console.log('Done forcing. Check your dev server logs now.');
    process.exit(0);
  }, 15000);
}

main();