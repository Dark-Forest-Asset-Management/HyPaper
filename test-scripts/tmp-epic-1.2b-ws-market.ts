/**
 * TMP verification — Epic 1.2b (WS market feeds relayed from HL).
 *
 * Subscribes to trades/bbo/candle/activeAssetCtx for BTC on BOTH HyPaper /ws
 * and HL /ws, captures the first frame of each from each, and shape-diffs
 * HyPaper's relayed frame against HL's — proving 1:1 relay (channel + payload).
 *
 * Throwaway — delete after sign-off.
 */
import WebSocket from 'ws';
import { compareToGolden, type Mismatch } from './parity/shape.js';

const HYPAPER = process.argv[2] ?? 'ws://localhost:3000/ws';
const HL = 'wss://api.hyperliquid.xyz/ws';
const SUBS = [
  { type: 'trades', coin: 'BTC' },
  { type: 'bbo', coin: 'BTC' },
  { type: 'candle', coin: 'BTC', interval: '1m' },
  { type: 'activeAssetCtx', coin: 'BTC' },
];
const CHANNELS = ['trades', 'bbo', 'candle', 'activeAssetCtx'];

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  ok ? pass++ : fail++;
};

/** Collect the first data frame per channel from a socket. */
function collect(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const got: Record<string, unknown> = {};
    const ws = new WebSocket(url);
    ws.on('open', () => SUBS.forEach((s) => ws.send(JSON.stringify({ method: 'subscribe', subscription: s }))));
    ws.on('message', (raw: WebSocket.RawData) => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (CHANNELS.includes(m.channel) && !(m.channel in got)) {
        got[m.channel] = m.data;
        if (Object.keys(got).length === CHANNELS.length) { ws.close(); resolve(got); }
      }
    });
    setTimeout(() => { try { ws.close(); } catch {} resolve(got); }, timeoutMs);
  });
}

(async () => {
  console.log(`HyPaper: ${HYPAPER}\nHL:      ${HL}\n`);
  const [paper, hl] = await Promise.all([collect(HYPAPER, 20000), collect(HL, 20000)]);

  for (const ch of CHANNELS) {
    const havePaper = ch in paper, haveHl = ch in hl;
    if (!havePaper) { check(`${ch} relayed by HyPaper`, false, 'no frame received within 20s'); continue; }
    check(`${ch} relayed by HyPaper`, true, `frame: ${JSON.stringify(Array.isArray(paper[ch]) ? (paper[ch] as unknown[])[0] : paper[ch]).slice(0, 110)}`);
    if (!haveHl) { console.log(`      (skip shape diff — no HL frame to compare)`); continue; }
    const mm: Mismatch[] = compareToGolden(hl[ch], paper[ch]);
    const fails = mm.filter((m) => m.severity === 'fail');
    check(`${ch} shape == HL`, fails.length === 0, fails.length ? fails.map((m) => `${m.path}: ${m.detail}`).join('; ') : 'matches HL frame');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
