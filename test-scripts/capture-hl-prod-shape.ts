/**
 * Capture the exact HL-prod response shape for the three endpoints HyPaper
 * needs to mirror, so we can patch HyPaper's responses to match field-by-
 * field instead of guessing from the gitbook + SDK structs.
 *
 * Read-only — only hits `/info` (no signed exchange actions, no wallet
 * keys needed). Run against any HL-prod wallet that currently has:
 *   - at least one open perp position
 *   - at least one TP and one SL trigger order attached to that position
 *   - some recent fills
 *
 * Outputs three JSON files into ./hl-prod-snapshots/:
 *   clearinghouseState.json
 *   frontendOpenOrders.json
 *   userFills.json
 *
 * Plus a printed summary listing every field the responses surface, so
 * we can scan for HyPaper omissions at a glance.
 *
 * Usage:
 *   npx tsx test-scripts/capture-hl-prod-shape.ts <walletAddress>
 *
 * Reference: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

const wallet = process.argv[2];
if (!wallet || !wallet.startsWith('0x')) {
  console.error('Usage: npx tsx test-scripts/capture-hl-prod-shape.ts <walletAddress>');
  process.exit(1);
}

const outDir = join(process.cwd(), 'hl-prod-snapshots');
mkdirSync(outDir, { recursive: true });

async function post(body: object): Promise<unknown> {
  const r = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HL ${HL_INFO_URL} ${r.status}: ${t}`);
  }
  return r.json();
}

/** Recursively enumerate every leaf field name + its concrete type so we
 *  can compare against HyPaper output and spot missing fields. */
function enumerateFields(value: unknown, path = ''): string[] {
  if (value === null) return [`${path} = null`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${path}[] = empty array`];
    // Use the first element as a representative — HL responses are
    // homogeneous within a given array.
    return enumerateFields(value[0], `${path}[0]`);
  }
  if (typeof value === 'object') {
    const out: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = path ? `${path}.${k}` : k;
      out.push(...enumerateFields(v, next));
    }
    return out;
  }
  return [`${path}: ${typeof value} = ${JSON.stringify(value).slice(0, 80)}`];
}

(async () => {
  console.log(`[capture] wallet: ${wallet}\n`);
  const endpoints: Array<{ name: string; body: object }> = [
    { name: 'clearinghouseState', body: { type: 'clearinghouseState', user: wallet } },
    { name: 'frontendOpenOrders', body: { type: 'frontendOpenOrders', user: wallet } },
    { name: 'userFills',          body: { type: 'userFills',          user: wallet } },
  ];

  for (const { name, body } of endpoints) {
    console.log(`=== ${name} ===`);
    try {
      const data = await post(body);
      const file = join(outDir, `${name}.json`);
      writeFileSync(file, JSON.stringify(data, null, 2));
      console.log(`  wrote ${file}`);
      const fields = enumerateFields(data);
      console.log(`  ${fields.length} field(s):`);
      for (const f of fields) console.log(`    ${f}`);
    } catch (e) {
      console.error(`  FAILED: ${(e as Error).message}`);
    }
    console.log('');
  }
  console.log(`Done. Snapshots in ${outDir}.`);
})().catch((e) => {
  console.error('[capture] failed:', e);
  process.exit(2);
});
