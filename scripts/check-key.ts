import { privateKeyToAccount } from 'viem/accounts';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}

const key = process.env.HL_TESTNET_PRIVATE_KEY;
console.log('Key from .env:', key);
console.log('Key length:', key?.length);

const account = privateKeyToAccount(key as `0x${string}`);
console.log('Address generated:', account.address);
console.log('Expected:         0x4A1AE5A6cFB24390a704b1cc1aB88d0F89eF596B');
console.log('Match:', account.address.toLowerCase() === '0x4a1ae5a6cfb24390a704b1cc1ab88d0f89ef596b');