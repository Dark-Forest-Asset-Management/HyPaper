import { redis } from '../src/store/redis.js';

async function main() {
  const coin = 'XRP';
  const crashPrice = '1.08'; // below liquidationPx of 1.11251

  await redis.hset('market:mids', coin, crashPrice);

  console.log(`✓ Forced ${coin} price to $${crashPrice}`);
  console.log(`  Liquidation should fire within 5 seconds.`);
  console.log(`  Watch your npm run dev terminal for: "Liquidation triggered"`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});