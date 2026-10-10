/**
 * create-subaccount.mjs — signs and submits a HyPaper `createSubAccount`
 * L1 action, the same way slushy.trade's hlClient.ts does it (same
 * nomeida/hyperliquid SDK, same field order, same signing call).
 *
 * Reads your private key from HyPaper's own .env file (HL_TESTNET_PRIVATE_KEY)
 * — no need to pass it on the command line or set it as an env var yourself.
 *
 * Setup (once):
 *   npm install hyperliquid ethers
 *
 * Usage:
 *   node create-subaccount.mjs
 *   node create-subaccount.mjs "My Sub Name"        (optional name arg)
 *
 * Override the backend URL if needed:
 *   $env:HYPAPER_URL="http://localhost:3000"; node create-subaccount.mjs
 *
 * NEVER paste a private key into chat, Thunder Client, or commit it to git.
 * Any key that was ever pasted into a chat should be treated as compromised
 * and replaced with a fresh generated wallet for testing.
 */
import { readFileSync, existsSync } from 'fs';
import { ethers } from 'ethers';
import { signL1Action as nomeidaSignL1Action } from 'hyperliquid';

// ── Load .env manually (no dotenv dependency needed) ──────────────────
function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const dotenv = loadEnvFile(new URL('./.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const PRIVATE_KEY = process.env.HL_TESTNET_PRIVATE_KEY ?? dotenv.HL_TESTNET_PRIVATE_KEY;
const HYPAPER_URL = (process.env.HYPAPER_URL ?? dotenv.HYPAPER_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const SUBACCOUNT_NAME = process.argv[2] ?? process.env.SUBACCOUNT_NAME ?? 'Alt-1';

if (!PRIVATE_KEY) {
  console.error('Could not find HL_TESTNET_PRIVATE_KEY — checked process.env and ./.env in this folder.');
  console.error('Make sure .env sits next to this script and has a line like:');
  console.error('  HL_TESTNET_PRIVATE_KEY=0x...');
  process.exit(1);
}

const wallet = new ethers.Wallet(PRIVATE_KEY);
console.log('Signing as:', wallet.address);
console.log('Target backend:', HYPAPER_URL);
console.log('Sub-account name:', SUBACCOUNT_NAME);

const action = { type: 'createSubAccount', name: SUBACCOUNT_NAME };
const nonce = Date.now();

// Same call hlSign.ts makes: (wallet, action, vaultAddress, nonce, isMainnet)
// vaultAddress is null — createSubAccount is signed by the master itself.
const signature = await nomeidaSignL1Action(wallet, action, null, nonce, true);

const body = { action, signature, nonce };

console.log('\n--- Body (for Thunder Client, if you want to inspect/replay) ---');
console.log('POST', `${HYPAPER_URL}/exchange`);
console.log(JSON.stringify(body, null, 2));

console.log('\n--- Submitting now ---');
const res = await fetch(`${HYPAPER_URL}/exchange`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log('Status:', res.status);
console.log('Response:', text);
