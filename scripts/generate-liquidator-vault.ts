/**
 * generate-liquidator-vault.ts
 *
 * One-time setup script. Generates a fresh EVM-compatible wallet (address +
 * private key) to act as HyPaper's liquidator vault — the counterparty that
 * "receives" liquidation proceeds in the paper-trading simulation.
 *
 * This is NOT a real Hyperliquid vault and holds no real funds — it's just
 * an address used as a label/identity for the vault inside HyPaper's own
 * Redis + Postgres accounting (see engine/liquidator-vault.ts).
 *
 * Usage:
 *   npx tsx scripts/generate-liquidator-vault.ts
 *
 * Output:
 *   Prints the address and private key to the terminal ONCE.
 *   Nothing is written to disk by this script — you copy the values into
 *   your .env file yourself. This avoids accidentally committing a private
 *   key to git via a generated file.
 *
 * After running, add these two lines to your .env (and .env.example with
 * placeholder values):
 *
 *   LIQUIDATOR_VAULT_ADDRESS=0x...
 *   LIQUIDATOR_VAULT_PRIVATE_KEY=0x...
 *
 * Security note: HyPaper is a paper-trading simulator, so this key never
 * touches real funds. Still, don't commit the real value to git — only
 * .env.example should contain a placeholder.
 */

import { ethers } from 'ethers';

function main(): void {
  const wallet = ethers.Wallet.createRandom();

  console.log('\n========================================');
  console.log(' HyPaper Liquidator Vault — generated keypair');
  console.log('========================================\n');
  console.log(`Address:      ${wallet.address}`);
  console.log(`Private key:  ${wallet.privateKey}`);
  console.log('\n----------------------------------------');
  console.log('Add these two lines to your .env file:');
  console.log('----------------------------------------\n');
  console.log(`LIQUIDATOR_VAULT_ADDRESS=${wallet.address}`);
  console.log(`LIQUIDATOR_VAULT_PRIVATE_KEY=${wallet.privateKey}`);
  console.log('\n----------------------------------------');
  console.log('This key is NOT saved anywhere by this script.');
  console.log('Copy it now — re-running this script generates a');
  console.log('DIFFERENT wallet each time.');
  console.log('----------------------------------------\n');
}

main();
