/**
 * TMP verification — Epic 1.2a (WS ping/pong + post requests).
 *
 * Connects to HyPaper /ws and proves:
 *   1. {"method":"ping"} → {"channel":"pong"}
 *   2. post info: {"method":"post","id","request":{"type":"info","payload":{type:"allMids"}}}
 *        → {"channel":"post","data":{"id","response":{"type":"info","payload":{…mids}}}}
 *   3. post action (unsigned, wallet field) → response.type === "action"
 *   4. bogus method still returns an error (regression)
 *
 * Throwaway — delete after sign-off.
 */
import WebSocket from 'ws';

const URL = process.argv[2] ?? 'ws://localhost:3000/ws';
const W = '0x000000000000000000000000000000000000beef';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  ok ? pass++ : fail++;
};

function waitFor(ws: WebSocket, pred: (m: any) => boolean, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    const onMsg = (raw: WebSocket.RawData) => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (pred(m)) { clearTimeout(t); ws.off('message', onMsg); resolve(m); }
    };
    ws.on('message', onMsg);
  });
}

(async () => {
  const ws = new WebSocket(URL);
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  console.log(`connected ${URL}\n`);

  // 1. ping/pong
  ws.send(JSON.stringify({ method: 'ping' }));
  try {
    const pong = await waitFor(ws, (m) => m.channel === 'pong');
    check('ping → pong', pong.channel === 'pong', JSON.stringify(pong));
  } catch { check('ping → pong', false, 'no pong within timeout'); }

  // 2. post info
  ws.send(JSON.stringify({ method: 'post', id: 1, request: { type: 'info', payload: { type: 'allMids' } } }));
  try {
    const r = await waitFor(ws, (m) => m.channel === 'post' && m.data?.id === 1);
    const ok = r.data.response.type === 'info' && r.data.response.payload && typeof r.data.response.payload === 'object';
    check('post info (allMids)', ok, `type=${r.data.response.type}, keys=${Object.keys(r.data.response.payload || {}).length}`);
  } catch { check('post info (allMids)', false, 'no post response within timeout'); }

  // 3. post action (unsigned cancel of a non-existent oid)
  ws.send(JSON.stringify({ method: 'post', id: 2, request: { type: 'action', payload: { wallet: W, action: { type: 'cancel', cancels: [{ a: 0, o: 1 }] } } } }));
  try {
    const r = await waitFor(ws, (m) => m.channel === 'post' && m.data?.id === 2);
    check('post action (cancel)', r.data.response.type === 'action' && r.data.response.payload?.status === 'ok',
      `type=${r.data.response.type}, status=${r.data.response.payload?.status}`);
  } catch { check('post action (cancel)', false, 'no post response within timeout'); }

  // 4. bogus method → error
  ws.send(JSON.stringify({ method: 'frobnicate' }));
  try {
    const r = await waitFor(ws, (m) => m.error !== undefined);
    check('unknown method → error', /Unknown method/.test(r.error), JSON.stringify(r));
  } catch { check('unknown method → error', false, 'no error within timeout'); }

  ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
