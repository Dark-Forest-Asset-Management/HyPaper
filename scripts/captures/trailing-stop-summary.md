# Hyperliquid TESTNET — Trailing Stop probe summary

Probe: `scripts/probe-hl-testnet-trailing-stop.ts` · raw captures: `scripts/captures/30_trailing_*.json`
Run against `api.hyperliquid-testnet.xyz`, BTC (asset index 3), size 0.00015 BTC, mark ≈ 83,560.
Wire shape first confirmed from 6 real testnet-UI captures, then reproduced by the script with our own signing.

## 1. Action wire shape

It is a **separate top-level action `trailingStop`**, not an order type inside `order`.

```jsonc
{ "type": "trailingStop",
  "asset": 3, "isBuy": false, "sz": "0.00015", "reduceOnly": true,
  "retracement": { "px": "2507" },      // fixed distance   — OR —   { "pct": "5.0000%" }
  "activationPx": null }                // or a price string e.g. "86066"
```

**msgpack field order (signature-critical):** `type, asset, isBuy, sz, reduceOnly, retracement, activationPx`.
Found by offline signer recovery over all 5,040 orderings against the UI captures (exactly one order recovered a consistent
signer). The browser's JSON is key-sorted and does NOT show this. Our probe signs with this order and HL accepts it (6/6).

Response (success, all variants, HTTP 200): `{"status":"ok","response":{"type":"trailingStop","data":{"oid":N}}}`
— only an oid; no `resting`/`filled` wrapper. Cancel is the ordinary `cancel` action (`{a, o}`) and returned `success` for all six.

| # | Variant | isBuy | reduceOnly | retracement | activationPx | Result |
|---|---|---|---|---|---|---|
| 1 | CLOSE, distance | false | true | `{px:"2507"}` | `null` | ok, oid 62106112508 |
| 2 | CLOSE, percent | false | true | `{pct:"5.0000%"}` | `null` | ok, oid 62106115982 |
| 3 | CLOSE, distance + activation above mark | false | true | `{px:"2507"}` | `"86066"` | ok, oid 62106119938 |
| 4 | OPEN, distance | true | false | `{px:"2507"}` | `null` | ok, oid 62106124019 |
| 5 | OPEN, percent | true | false | `{pct:"5.0000%"}` | `null` | ok, oid 62106126834 |
| 6 | OPEN, distance + activation below mark | true | false | `{px:"2507"}` | `"81052"` | ok, oid 62106129977 |

## 2. How trailing stops appear in the info endpoints

All three show it as a **resting order**; only `frontendOpenOrders` and `orderStatus` reveal it is a trailing stop.

- **`openOrders`** — plain resting order, **no trailing info at all**: `{coin, side, limitPx, sz, oid, timestamp, origSz[, reduceOnly]}`.
  (`reduceOnly` key is omitted when false, as for normal orders.)
- **`frontendOpenOrders`** — the full picture:
  `orderType: "Trailing Stop Market"`, `isTrigger: true`, `tif: null`, `children: []`, `isPositionTpsl: false`,
  `triggerPx` (current computed trigger), `limitPx` (see below), and a prose
  `triggerCondition`: `"Activation immediate, retracement 2507, best 83563"` / `"…retracement 5%, best 83564"` /
  `"Activation above 86066, retracement 2507, best waiting"`.
- **`orderStatus`** — `{status:"order", order:{order:{…same fields as frontendOpenOrders…}, status:"open", statusTimestamp}}`.

**Observed computation** (matches the docs' formulas):

| Case | Rule observed |
|---|---|
| Sell (close long), distance | `triggerPx = best − distance` (83563 − 2507 → 81056) |
| Sell, percent | `triggerPx = best × (1 − pct)` (83564 → 79385.8) |
| Buy (open long), distance | `triggerPx = best + distance` (83559 + 2507 → 86066) |
| Buy, percent | `triggerPx = best × (1 + pct)` (83564 → 87742.2) |
| `limitPx` (informational, market-style order) | sell: `triggerPx × 0.9`; buy: `triggerPx × 1.1` — checked on 4 orders to the unit |
| Not yet activated | `triggerPx: "0.0"`, `best waiting`; `limitPx` still populated (not 0) |

The "watermark" is the word **`best`** inside `triggerCondition`; sell stops track the highest mark, buy stops the lowest.

## 3. Is trigger / watermark queryable and live-updating?

13 polls over 240 s (mark moved 83,564 → 83,586 → 83,567):

- **`frontendOpenOrders`: YES, live.** For variants 1 and 2 `best`, `triggerPx` and `limitPx` changed in 7 distinct snapshots,
  moving only upward as mark rose and holding when mark dipped (ratchet). Variants 4/5 (buy, tracking the minimum) changed
  twice, when a new low formed — consistent with the docs ("updates only when new watermarks form").
- **Unactivated orders (3, 6): static**, `best waiting`, `triggerPx 0.0` — expected, mark never reached activation.
- **`orderStatus`: STALE.** Its response never changed across all 13 polls (still `best 83563` / `triggerPx 81056.0` from placement).
  Use `frontendOpenOrders` for live values.
- **`openOrders`** has no trailing fields, so nothing to track.
- The "best" HL uses can differ by a few dollars from `metaAndAssetCtxs.markPx` at the same instant (e.g. best 83583 while the
  polled mark read 83580) — HL evaluates on its own mark stream between our polls.

## 4. Docs term → actual API field

| Docs term | Actual API field | Mismatch? |
|---|---|---|
| Retracement (fixed distance) | request `retracement.px` (string, wire "3000") | ⚠️ name `px`, not "distance" |
| Retracement (percentage) | request `retracement.pct` (string **with `%` suffix**, `"5.0000%"`) | ⚠️ value is a percent string, not a decimal rate |
| Activation price | request `activationPx` (`null` = immediate) | matches; always present, `null` not omitted |
| Watermark | only the word `best` in `triggerCondition` prose; **no structured field** | ⚠️ not a field |
| Trigger price | response `triggerPx` | matches (but `"0.0"` until activated) |
| Activation status | only in `triggerCondition` prose (`immediate` / `above X` / `below X` / `best waiting`) | ⚠️ not a field |
| Order type | `orderType: "Trailing Stop Market"` | new string |
| Side/size | `isBuy`/`sz`/`asset`/`reduceOnly` (flat) vs `a/b/s/r` in `order` | ⚠️ different key naming from `order` wire |

## 5. Error shapes captured

- `retracement {pct:"0.0000%"}` → HTTP 200 `{"status":"err","response":"Trailing stop retracement is invalid."}`
- `retracement {px:"0"}` → HTTP 200 `{"status":"err","response":"Error converting float to price"}`

Errors come back as HTTP 200 with `status:"err"` and a plain string, like other exchange actions.

## 6. Uncertain / not confirmed

- **Trigger firing never observed.** No stop actually triggered, so I did not see the fill, the resulting `orderUpdates` /
  `userFills` shape, the order's final status string (`triggered`? `filled`?), or the fee/slippage behaviour of the
  market order it submits. The `limitPx` ±10 % band is inferred as the worst-price cap — not confirmed by a fill.
- **Activation transition not observed.** Orders 3 and 6 never activated, so I haven't seen how `triggerCondition`/`triggerPx`
  change at activation (e.g. what `best` is seeded with).
- **Activation on the "wrong side" of mark is ACCEPTED.** A close-long stop with activation 3 % *below* mark returned
  `ok` (oid 62106387963); no follow-up queries were taken for it, so what it does (activate immediately? wait?) is unknown.
  Same for the buy-side mirror case (not tested).
- **Percent format flexibility.** Only `"5.0000%"` was sent; whether `"5%"`, `"5"` or other precision is accepted is untested.
  Percent bounds, minimum/maximum retracement, and fixed-distance validity limits are untested.
- **Fractional distance.** Only integer distance (`"2507"`, `"3000"`) was sent. Whether decimals are accepted, or how they are
  normalised (the UI sent integers), is untested. `px:"0"` fails with a generic price-conversion message.
- **Optional envelope fields.** The UI sent `expiresAfter`, `isFrontend:true`, `vaultAddress:null`. The probe sent none of them
  (body = `{action, nonce, signature}`) and HL accepted — so they are not required for trailingStop; their effect is unknown.
- **`orderStatus` staleness** is observed on one order type over 4 minutes; whether it ever refreshes (e.g. on activation) is unknown.
- **Order of `activationPx` null vs omitted:** only `null` was tested; omitting the key was not.
- **Position/margin interaction** (reservation of margin for open stops, `reduceOnly` rejection when position is smaller or flips,
  behaviour when position closes underneath a reduce-only stop) not tested.
- **Not tested:** other assets, sub-accounts/vaults, `batch`/`modify` of a trailing stop, WebSocket (`orderUpdates`, `webData2`)
  representation, TP/SL grouping.
- Single run, ~4 minutes, a very quiet mark (range ≈ $22). Ratchet behaviour is clear but was not stress-tested through a reversal.

## 7. Cleanup state

All six stops cancelled, the extra accepted wrong-side stop cancelled, test long closed by a reduce-only IOC sell
(avgPx 83550.0). Final BTC `szi = 0`.

## 8. Trigger behavior (round 2 — `probe-hl-testnet-trailing-stop-trigger.ts`, captures `31_trigger_*.json`)

Run on testnet BTC, size 0.00015, mark ≈ 82,700. Resolves several items in §6 (marked below); others remain open.

### 8.1 A stop FIRING (T1: close-long, `retracement {px:"5"}`, no activation, oid 62155995023)

It fired ~1.1 s after placement (`timestamp` 1791456616582 → `statusTimestamp` 1791456617663), before our first 5 s poll, so
the pre-fire text comes from the query made immediately after placing:

- **triggerCondition just before firing:** `"Activation immediate, retracement 5, best 82760.2"`, `triggerPx "82755.2"`, `isTrigger: true`, `tif: null`
  (`limitPx "74480.0"` = 0.9 × triggerPx). Note the distance is echoed as `5`, not `5.0`.
- **The fill reuses the ORIGINAL oid.** No new oid is created. `userFills` entry:
  `{coin:"BTC", px:"82763.0", sz:"0.00015", side:"A", dir:"Close Long", closedPnl:"0.00855", crossed:true, fee:"0.005586", oid:62155995023, twapId:null, startPosition:"0.00015", …}`.
  `crossed:true` → taker fee (0.005586 on ~$12.4 = 4.5 bp, the testnet taker rate). Fill px 82763 was *above* the 82755.2 trigger: it is a market order at the then-current book, not a fill at `triggerPx`.
- **`orderStatus` after firing:** `status: "filled"` (not "triggered"), with the order body changed to:
  `triggerCondition: "Triggered"`, `isTrigger: false`, `triggerPx: "0.0"`, `sz: "0.0"` (remaining), `origSz: "0.00015"`, `tif: "Gtc"` (was `null`), `orderType` still `"Trailing Stop Market"`.
- **`historicalOrders` has TWO rows for the oid:** a `"triggered"` row (frozen pre-fire snapshot, still showing `best 82760.2`, `isTrigger:true`) and a `"filled"` row ("Triggered" body above).
- **`frontendOpenOrders`:** the order disappears at once; position closed (`szi` 0).
- **Websocket `orderUpdates`** (one frame, two entries): `[{… status:"triggered"}, {… sz:"0.0", status:"filled"}]`, delivered together with the `userFills` and `user` (userEvents) fill frames at the same instant.

### 8.2 Activation transition (T2: close-long, `activationPx "82761"`, mark 82,755 at placement, oid 62155972335)

| | `triggerCondition` | `triggerPx` | `limitPx` |
|---|---|---|---|
| Before (mark 82755, 82757) | `Activation above 82761, retracement 3000, best waiting` | `"0.0"` | 71785 |
| After (mark 82762 ≥ activation) | `Activation above 82761, retracement 3000, best 82762` | `"79762.0"` (= best − 3000) | 71786 |

- Activation happened on the poll where mark ≥ activationPx; the text keeps the **same `Activation above 82761` prefix** and only `best waiting` → `best <mark>` changes. `best` is seeded with the mark at activation. After activation `triggerPx` is non-zero and tracks `best` as in §3.
- **`orderStatus` still showed the stale `best waiting` / `triggerPx 0.0` at the activation tick** — reconfirms §3: `orderStatus` is a placement-time snapshot; use `frontendOpenOrders` for live state.
- Websocket `orderUpdates` sent **nothing** at activation or at trailing updates — only `open` (placement), `canceled`, and `triggered`/`filled`. The WS `open` event is a plain resting-order shape: **no `triggerCondition`/`triggerPx`/`isTrigger`/`orderType`** (compare `frontendOpenOrders`).

### 8.3 The odd case (T3: close-long with activation BELOW mark, oid 62155943600) — resolves §6

`activationPx "82680"` with mark 82,705: accepted and **active immediately**. Right after placement:
`triggerCondition: "Activation above 82680, retracement 3000, best 82705"`, `triggerPx "79705.0"`.
- HL does not reject or flip the activation; because mark is already beyond it, the stop begins tracking at once with `best` = current mark.
- ⚠️ The prose still says **"Activation above"** even though 82680 is below mark — for a sell stop the word is fixed to `above` and the condition `mark ≥ activationPx` is simply already true. So don't derive side-validity from this text.
- No error or warning is returned; a client wanting "must be on the far side of mark" validation has to do it itself (HL does not).

### 8.4 Updates to §6 "Uncertain / not confirmed"

- ✅ Now observed: trigger firing, fill shape, final status strings (`filled`; history also has `triggered`), same-oid fill, WS event sequence, activation transition, activation-on-wrong-side behaviour (sell side).
- ⚠️ Still open: `px` smaller than 5 (HL accepted 5 on the first try, so the minimum distance is unknown); percent-form firing (only `px` was fired); **buy-side** (open-long) firing and the buy-side wording of the activation prose (`below`?) and wrong-side behaviour; behaviour when the reduce-only position is gone/too small at fire time; partial fills (size too small to partially fill here); fee rate beyond this single taker sample.
- ⚠️ `triggerPx` 82755.2 vs actual fill 82763: a single sample, so slippage characteristics (the 10 % `limitPx` band) are inferred, not tested against a thin book.
- The first poll missed the pre-fire state because the stop fired in ~1 s; the pre-fire text above comes from the immediate post-placement query, not a poll.

### 8.5 Implications for HyPaper (observations only, nothing implemented)

- Model it as a distinct `trailingStop` action returning `{type:"trailingStop", data:{oid}}`, with a single oid reused through the fill.
- Matching: track `best` (max mark for sells, min for buys) from activation; `triggerPx = best ∓ distance` (or `× (1 ∓ pct)`); fire as a taker market order
  (VWAP book walk, capped at `limitPx` = `triggerPx × 0.9` sell / `× 1.1` buy).
- Order-history rows: `triggered` then `filled`; `orderUpdates` frame carries both; `frontendOpenOrders`/`orderStatus` carry the prose `triggerCondition`
  (`Activation immediate|above X|below X, retracement N|P%, best <n>|waiting` → `Triggered`).

## 9. Buy-side + smaller px (round 3 — `probe-hl-testnet-trailing-stop-buyside.ts`, captures `32_buyside_*.json`)

Testnet BTC, size 0.00015, mark ≈ 82,830. Buy-side = open-long (`isBuy:true`, `reduceOnly:false`); no setup position was needed.

### 9.1 Buy-side FIRING, smaller px (B3: `retracement {px:"0.5"}`, no activation, oid 62156596430)

- **`px:"0.5"` was accepted on the first try** (nothing rejected). So the minimum distance is below 0.5; round 2's `5` was not near the floor. The smallest valid value is still unknown (a sub-tick distance such as `0.1` was not tried).
- **Fractional distance is accepted and echoed verbatim:** `retracement 0.5` in `triggerCondition`; `triggerPx` carries the fractional part (`"82822.5"` = best 82822 + 0.5). (Round 1/2 only used integers.)
- **Buy-side ratchet, observed live (1 s polls):** `best` only moved DOWN (82831 → 82828 → 82825 → 82822) and `triggerPx` followed as `best + 0.5` (82831.5 → 82828.5 → 82825.5 → 82822.5). It never rose while mark rose — the buy mirror of §3.
- **Fired ~24 s after placement** when mark rose back through 82822.5. The pre-fire poll (1.8 s before the fill) shows:
  `"Activation immediate, retracement 0.5, best 82822"`, `triggerPx "82822.5"`, `limitPx "91104.0"` (≈ 1.1 × triggerPx), `isTrigger:true`, `tif:null`.
- **Same pattern as the sell side (§8.1):** the fill reuses the ORIGINAL oid; `orderStatus` → `status:"filled"`, `triggerCondition:"Triggered"`, `isTrigger:false`, `triggerPx:"0.0"`, `sz:"0.0"`, `tif:"Gtc"`; `historicalOrders` has a `triggered` row (frozen pre-fire snapshot) and a `filled` row; the order leaves `frontendOpenOrders`.
- **Fill:** `dir:"Open Long"`, `side:"B"`, `px:"82831.0"` (above the 82822.5 trigger — market order against the book), `crossed:true`, `fee:"0.005591"`, `startPosition:"0.0"`, `oid` = the stop's oid. The position opened (`szi 0.00015`, `entryPx 82831.0`).
- **Websocket `orderUpdates`:** `open` at placement, then one frame `[{status:"triggered"}, {status:"filled", sz:"0.0"}]` at fire — identical to the sell side. (The later `open`+`filled` pair with a different oid is the probe's own cleanup order.)

### 9.2 Buy-side wording and the "wrong side" case (B1: activation ABOVE mark, oid 62156561212)

`activationPx "82856"` with mark ≈ 82,831 — accepted, **active immediately**, text `"Activation below 82856, retracement 3000, best 82831"`, `triggerPx "85831.0"` (= best + 3000).
- **Side word is mirrored:** buy stops print **`Activation below X`**, sell stops print **`Activation above X`** (§8.3). A buy stop activates when mark ≤ activationPx; a sell stop when mark ≥ activationPx. Setting the activation on the already-satisfied side makes the stop active at once on both sides, with no error.
- Consequence: the buy "wrong side" is activation *above* mark (already satisfied), the mirror of the sell case in §8.3.

### 9.3 Buy-side activation transition — NOT observed (B2 is invalid, ignore its "activated" flag)

B2 asked for activation 6 below mark, but the mark fell below that level between my price read and the placement, so the stop was active from the first query (`"Activation below 82841 … best 82831"`, `triggerPx 85831.0`). The probe's `activated:true` in `32_buyside_b2_activation_poll.json` / `buyside-run-summary.json` is a **false positive** from a single tick that was already active — there is no before/after pair in that capture.
The buy-side `best waiting` → `best N` text/`triggerPx` change is therefore **inferred from the sell-side behaviour (§8.2), not seen**. Doing it properly needs an activation far enough below mark that it cannot already be satisfied (e.g. 0.3 % below) and a long wait for the mark to fall.

### 9.4 Other observations

- `best` follows HL's mark/oracle stream, not `allMids`: `allMids` sat at 82830.5 for the whole B3 window while `best` stepped down to 82822.
- Stale `orderStatus` again: the poll's `orderStatus` was not used here for `best`; only `frontendOpenOrders` was. (Not re-tested.)
- `limitPx` ≈ 1.1 × `triggerPx` for buys, confirming §2; it is truncated/rounded to a whole number (91104 for 82822.5 × 1.1 = 91104.75).

### 9.5 Still open after round 3

- Buy-side activation transition (§9.3), and the smallest accepted `px` (below 0.5).
- Percentage-form (`pct`) trailing stop actually firing, and tiny/large `pct` bounds.
- Reduce-only stop whose position is gone/smaller at fire time; partial fills; liquidity/slippage at the 10 % `limitPx` cap.
- Sub-accounts/vaults, `modify`/`batchModify` of a trailing stop, and which websocket channels carry trigger/watermark updates (`webData2` was not subscribed).

## 10. Reduce-only orphan + pct firing (round 4 — `probe-hl-testnet-trailing-stop-orphan.ts`, captures `33_orphan_*.json`)

Testnet BTC, size 0.00015, mark ≈ 82,700.

### 10.1 Reduce-only orphan: position closed under a resting close-long stop (oid 62156953329)

Sequence: open long → place `trailingStop` (`reduceOnly:true`, `retracement {px:"3000"}`, no activation; resting, `status:"open"`) → close the position with a normal reduce-only IOC sell (oid 62156958764, filled).

**HL auto-cancels the orphaned stop at the same instant the position goes flat, with status string `reduceOnlyCanceled`.**
- `orderStatus` (all three snapshots, +~1 s / +~11 s / +~31 s, byte-identical):
  `status:"reduceOnlyCanceled"`, `statusTimestamp 1791457498505` — **exactly the timestamp of the closing fill** (same ms).
  The order body is the frozen pre-cancel snapshot: still `triggerCondition:"Activation immediate, retracement 3000, best 82705"`, `isTrigger:true`, `triggerPx:"79705.0"`, **`sz:"0.00015"` (NOT zeroed)**, `reduceOnly:true`, `tif:null`.
- `frontendOpenOrders` and `openOrders`: the stop is **gone** immediately (+~1 s) and stays gone. Position `szi` = 0.
- `historicalOrders` for the oid: two rows — `reduceOnlyCanceled` (statusTimestamp 1791457498505) and the original `open` row (statusTimestamp 1791457493480).
- **Explicit cancel afterwards fails** (HTTP 200): `{"status":"ok","response":{"type":"cancel","data":{"statuses":[{"error":"Order was never placed, already canceled, or filled. asset=3"}]}}}` — note `status:"ok"` at the top with the error inside `statuses[]`, the usual cancel-error shape.
- **Websocket `orderUpdates`:** one frame at the close, containing the close order's `open`+`filled` AND the orphan's cancel:
  `[{close oid, "open"}, {close oid, "filled", sz:"0.0"}, {orphan oid, "reduceOnlyCanceled", sz:"0.00015", reduceOnly:true}]`.
  The orphan's WS body is the plain resting-order shape (no `triggerCondition`/`orderType`), as with `open` in §8.2.
- The cancel is decided by the position change (reduce-only with nothing left to reduce), not by a later poll — there is no delay window to observe.
- Not tested: orphaning by *reducing* (not closing) the position, or a flip (long → short); partial reduction relative to the stop's size.

### 10.2 Percentage firing (O2: close-long `retracement {pct:"0.0100%"}`, no activation, oid 62157017253)

- **`pct:"0.0100%"` (0.01 %) accepted on the first try** — nothing rejected. Echoed in the text as **`retracement 0.01%`** (trailing zeros stripped: `"0.0100%"` → `0.01%`; round 1's `"5.0000%"` → `5%`).
- **Formula confirmed: `triggerPx = best × (1 − pct/100)`, rounded to the price tick (1 decimal for BTC):**

  | best | expected best × 0.9999 | reported `triggerPx` |
  |---|---|---|
  | 82719 | 82710.7281 | `"82710.7"` |
  | 82730 | 82721.7270 | `"82721.7"` |

  All observed ticks differ from the unrounded product by < 0.03, i.e. only tick rounding. `limitPx` was `"74450.0"` (≈ 0.9 × triggerPx).
- **Sell-side ratchet:** `best` rose 82719 → 82730 while mark rose, `triggerPx` followed (82710.7 → 82721.7), and the stop did not move down on the dip.
- **Fired ~15 s after placement.** Last pre-fire text: `"Activation immediate, retracement 0.01%, best 82730"`, `triggerPx "82721.7"`.
- **Same fire pattern as §8.1/§9.1:** the fill reuses the ORIGINAL oid; `orderStatus` → `filled`, `triggerCondition:"Triggered"`, `isTrigger:false`, `triggerPx:"0.0"`, `sz:"0.0"`, `tif:"Gtc"`; WS frame `[triggered, filled]`.
  Fill: `dir:"Close Long"`, `px:"82714.0"` (below the 82721.7 trigger — taker market order against the book), `crossed:true`, `fee:"0.005583"`, `closedPnl:"-0.0009"`.
- **Correction to §8.1/§9.1:** `historicalOrders` actually holds **three** rows per fired stop, not two — `filled`, `triggered`, **and the original `open` row** (earlier analysis only looked at the first two). Their `triggerCondition`/`triggerPx` snapshots show the stop's state at each transition (`open`: best 82719 / trig 82710.7; `triggered`: best 82730 / trig 82721.7; `filled`: `Triggered` / `0.0`).

### 10.3 Status strings seen across all rounds

| Situation | `orderStatus` / history status | WS `orderUpdates` status |
|---|---|---|
| Resting | `open` | `open` |
| Fired | `triggered` (history snapshot) → `filled` | `triggered`, `filled` (one frame) |
| User cancel | `canceled` (frame at cancel) | `canceled` |
| Reduce-only, position gone | `reduceOnlyCanceled` | `reduceOnlyCanceled` |

### 10.4 Explicitly NOT observed (final state of the uncertainty list)

- **Buy-side activation transition (`best waiting` → `best N` for a buy stop): inferred from the sell side, not observed.** The only buy-side activation attempts (§9.2/§9.3) were already satisfied at placement.
- Minimum `px`/`pct` accepted: `px 0.5` and `pct 0.01 %` both passed; the actual floor is below those and unknown. Upper bounds (maximum pct, retracement ≥ price) untested.
- Orphaning by partial reduction or by a position flip; buy-side stops are not reduce-only so don't orphan, but `reduceOnly:true` on a buy (short-cover) stop was never tested.
- Partial fills, thin-book slippage versus the 10 % `limitPx` cap, margin reservation for open (buy) stops, sub-accounts/vaults, `modify`/`batchModify` of a trailing stop, `webData2` representation, behaviour across a restart/expiry.

## 11. Reduce-only edge cases (round 5 — `probe-hl-testnet-trailing-stop-reduceonly.ts`, captures `34_reduceonly_*.json`)

Testnet BTC; unit size 0.00015.

| Case | Result |
|---|---|
| R1: **flat account**, SELL `reduceOnly:true` stop | **Accepted** (`ok`, oid returned); rests `open`, `Activation immediate … best <mark>`, `triggerPx` populated like any stop. Not rejected, not auto-canceled at placement. |
| R2: **flat account**, BUY `reduceOnly:true` stop | **Accepted**, same. |
| R3: short position + BUY `reduceOnly:true` stop → close the short with a normal reduce-only IOC | Stop accepted; at the closing fill it becomes **`reduceOnlyCanceled`** (same ms as the fill), gone from `frontendOpenOrders` — the exact mirror of the long/sell orphan. |
| R4: long 2u + SELL reduce-only stop sized **3u** (> position) | **Accepted** at placement (no size check against the position). |
| R5: reduce that long by 1u with a normal reduce-only IOC | Stop **stays `open`, size unchanged (`sz` 0.00045)** at +1 s and +10 s — no resize, no cancel. |
| R6: flip the position (long 1u → short 2u via a non-reduce-only sell of 3u) | Stop → **`reduceOnlyCanceled`** at the flip fill's timestamp; `historicalOrders` = `[reduceOnlyCanceled, open]`. |

WebSocket: for R3 and R6 the orphan's `reduceOnlyCanceled` entry (plain body, `reduceOnly:true`, original `sz`) arrives **in the same `orderUpdates` frame** as the closing/flipping order's `open`+`filled`, with identical `statusTimestamp`. A manual cancel arrives as `canceled` (US spelling).

Still not observed: what happens when a reduce-only stop larger than the remaining position *fires* (fill size clamp) and whether the stop on a flat account is later auto-canceled by HL (it was cancelled by the probe within seconds).

## 12. Round 6 (`probe-hl-testnet-trailing-stop-round6.ts`, captures `35_r6_*.json`) + what HyPaper must change

Testnet, with a wallet holding only ~$3.5 USDC (all in the SPOT wallet; perp `accountValue` reads 0 — collateral is shared, effective cross leverage 20x). Run as: one full run (T2–T9), a `funded` rerun (T8, T8b, T1, T6b — the first run's T8 position had consumed the margin, so its T1/T6b opens failed with `Insufficient margin to place order. asset=3`), and a `webdata3` rerun. No funds were moved between spot and perp. The probe's own cleanup left the account flat every time; one aborted run (my mistake: an unrecognised mode flag started the full flow) was stopped and its leftovers cancelled/flattened.

### 12.1 Results

| # | Question | Result |
|---|---|---|
| T1 | Oversize reduce-only stop fires (long 0.00015, stop sz 0.00045) | **Fills exactly the position (0.00015)**, one fill, `Close Long`, `crossed`. Final `orderStatus`: `status:"filled"`, body `sz:"0.0"`, `origSz:"0.00045"`. History `[filled, triggered, open]`. WS frame `[triggered sz 0.00045, filled sz "0.0"]`. |
| T2 | webData2 / ratchet | **Inconclusive.** The testnet rejects the `webData2` subscription (`Error parsing JSON into valid websocket request`). It serves **`webData3`** instead (`{userState, perpDexStates:[{totalVaultEquity}]}`), which contains **no open-orders list** — none of our stops appeared in 31 frames (deep search by oid). So how HL's `webData2` represents trailing stops (if still served on mainnet) is **not observable on testnet**. |
| T3 | Buy-side activation transition | **Observed.** Activation 81323 (~0.12 % below mark 81420), `px 3000`. Before: `Activation below 81323, retracement 3000, best waiting`, `triggerPx "0.0"`, `limitPx "92755.0"` (from activation + 3000 → 84323 × 1.1, floored). After the mark fell to 81294: `…best 81294`, `triggerPx "84294.0"` (best + 3000), `limitPx "92723.0"`; `best` then ratcheted DOWN (81262 → 81256 → 81234 → 81201 → 81181). The side word is `below` for buys. Confirms the HyPaper model exactly. |
| T4 | Smallest values | **px (BTC, 1 price decimal):** `1`, `0.5`, `0.1` accepted; `0.05` … `0.000001` → `Error converting float to price`. **pct:** `1.0000%`, `0.1000%`, `0.0100%`, `0.0010%` accepted; `0.0001%`, `0.00001%`, `0.000001%` → `Percentage is invalid.`. Accepted pct spellings: `5%`, `5.0%`, `5.00000%`, `05.0000%` (echoed as `5%`). Rejected with `Percentage is invalid.`: `5`, `5.0000` (no `%`), `%5`, ` 5.0000%` (leading space), `99.9999%`. `100.0000%` and `150.0000%` → `Trailing stop retracement is invalid.`. On SOL/ETH `1.2345%` → `Percentage is invalid.` ⇒ **pct must be a multiple of 0.001 %** (0.0010 ok; 1.2345, 99.9999, 0.0001 not). **px upper bound:** `100000`, `1000000`, `99999999` (sell, BTC ≈ 81k) → `Trailing stop retracement is invalid.` (exact threshold not located; buy side untested). |
| T4b | px normalisation | ETH (2 price decimals) `px 0.123` was **normalised to `0.12`** (`retracement 0.12`, trigger = best − 0.12); SOL (4 decimals) kept `0.123`. BTC `0.05` (1 decimal) is rejected ⇒ it rounds to 0, so the mode is truncate/half-even, **not** half-up (floor vs half-even not distinguished). |
| T5 | Flat-account reduce-only stop, 5+ min | **Never cancelled.** Sell and buy stops on ETH, 34 polls over 331 s: always `open`, `best` kept ratcheting (sell: 2399.3 → 2402.6). |
| T6a | Non-BTC rounding / limitPx rule | **22/22 rows (SOL szDecimals 2, ETH szDecimals 4; sell + buy; px, pct, activation) match HyPaper's trigger / limitPx / text byte-for-byte**, e.g. SOL trigger `106.7436` (4 dp), limit `96.508` (5 significant figures). The limitPx rule and half-up trigger rounding generalise. |
| T6b | SOL fire | Fired in 15 s; fill 0.12 SOL `Close Long` crossed; the last live row before the fire matched HyPaper's rules (trigger `106.18`, limit `95.563`). History `[filled, triggered, open]`. |
| T7 | `modify` / `batchModify` on a trailing stop | `modify` → HTTP 200 `{"status":"err","response":"Attempted to modify to invalid new order"}` (both wires tried: non-RO buy limit, RO sell limit); `batchModify` → `{"status":"ok","response":{"type":"order","data":{"statuses":[{"error":"Attempted to modify to invalid new order"}]}}}`. The stop was untouched (still open, still `Trailing Stop Market`). *Caveat:* I only used two wires; the error could in principle come from the new order rather than the target type. |
| T8 | Open-long stop far larger than the margin (notional ≈ $420 vs $3.5) | Placement **accepted**. On fire it **partially filled up to the available margin** (0.0008 of 0.00516 BTC ≈ $65 notional ≈ $3.3 at 20x; the first run: 0.00089 of 0.00542 in two fills). Final `status:"filled"`, history `[filled, triggered, open]`, and the final body **keeps the unfilled remainder in `sz`** (`0.00436` = 0.00516 − 0.0008), unlike the reduce-only clamp (`0.0`). WS: `[triggered sz 0.00516, filled sz "0.00436"]`. |
| T8b | Stop fires with **zero** free margin | Status **`marginCanceled`**, no fill. History `[marginCanceled, triggered, open]` (a `triggered` row IS written first; same timestamp). WS: one frame `[triggered, marginCanceled]` (both bodies keep the full `sz` and the placement timestamp). `orderStatus` body is the frozen live body (still `isTrigger:true`, full `sz`). |
| T9 | `expiresAfter` | **It does not expire the order.** A stop placed with `expiresAfter` = now+90 s (accepted) was still `open` in all 25 samples after the deadline. An `expiresAfter` already in the past → HTTP 200 `{"status":"err","response":"Action already expired"}`. So it gates the *request*, not the order's lifetime. |

### 12.2 What HyPaper must change — **IMPLEMENTED** (items 1–7 below are done and covered by unit tests and the local end-to-end run; item 9 is deliberately unchanged)

Ordered by impact. **[C]** = confirmed on HL testnet; **[A]** = assumption beyond what was observed.

1. **Fire-time margin must be partial, not all-or-nothing** [C]. Compute the affordable size (free margin × leverage ÷ price). `> 0`: fill that much (same oid, taker), status `filled`, final body `sz` = `origSz − filled` (**non-zero**), WS `[triggered (full sz), filled (sz = remainder, timestamp = fill time)]`. `= 0`: status `marginCanceled`, history `[marginCanceled, triggered, open]`, WS `[triggered, marginCanceled]` in one frame, no fill. HyPaper today cancels immediately with `marginCanceled` and writes no `triggered` row/frame.
2. **Reduce-only clamp keeps `sz "0.0"`** [C]. HyPaper already clamps the fill to the position and prints `sz "0.0"` — keep it, but make sure the margin-partial case (1) is distinguished (remainder shown) from the reduce-only clamp (0.0).
3. **`expiresAfter` is request expiry, not order expiry** [C for trailing stops]. Reject when `expiresAfter ≤ now` with HTTP 200 `{"status":"err","response":"Action already expired"}` (HyPaper returns 400 `expiresAfter is in the past`), and **do not register the order for expiry / sweep it** (HyPaper's `saveOrder` / `sweepExpired` cancel the order at the deadline — wrong for trailing stops, and very likely for every order type: pre-existing behaviour to flag to the principal; only verified here for trailing stops).
4. **`modify` / `batchModify` on a trailing oid** [C, caveat above]. Return HL's `Attempted to modify to invalid new order`: `modify` → HTTP 200 `{"status":"err","response":<text>}`; `batchModify` → `ok` with `statuses:[{error:<text>}]`. HyPaper returns `Cannot modify a trailing stop order` (and HTTP 400 for `modify`).
5. **`px` normalisation** [C for ETH/BTC]. Round `px` down to `6 − szDecimals` decimals before use and echo the normalised value in `triggerCondition` (`0.123` → `0.12` on ETH); if it becomes 0 → `Error converting float to price` (BTC `0.05`). Rounding mode [A]: truncate (half-up is ruled out by the BTC case).
6. **`pct` validation** [C]. Format must be `\d+(\.\d+)?%`, otherwise `Percentage is invalid.` (HTTP 200, `status:"err"`) — **not** the deserialize error HyPaper's canonicaliser returns today. `pct × 1000` must be an integer (multiple of 0.001 %), else `Percentage is invalid.`. `pct == 0` → `Trailing stop retracement is invalid.` (already). `pct ≥ 100` → `Trailing stop retracement is invalid.`. Spellings `5%`, `5.0%`, `05.0000%`, `5.00000%` are valid. The canonicaliser must therefore only fix key order and basic JSON types and leave string-content validation to the semantic validator, so these errors carry HL's text.
7. **`px` upper bound** [C direction, A threshold]. A sell `px` at/above the reference price → `Trailing stop retracement is invalid.` Threshold assumed `px ≥ best` (or `activationPx` while waiting); buy side not verified.
8. **No change needed** (verified to match): flat-account reduce-only stops resting indefinitely (T5, 331 s); buy-side activation including the pre-activation `limitPx` (T3); trigger/limit/text rules on non-BTC coins (T6a/T6b); oversize reduce-only clamp (T1); modify being refused (the behaviour, not the text).
9. **`webData2` / `webData3`** — undecided. Testnet gives no way to see how HL lists trailing stops there (`webData2` is rejected, `webData3` has no open orders). Keep HyPaper's current behaviour (stops appear via the shared frontend-open-orders builder, no push on ratchet) and re-check against mainnet **read-only** only with explicit permission. Note slushy subscribes `webData2`, which the testnet no longer accepts.

### 12.3 Still not observed
The exact `px` upper-bound threshold and its buy-side behaviour; whether `activationPx` is also price-normalised; truncate vs half-even for `px`; `modify` with a wire that is valid on its own (to separate "wrong target type" from "invalid new order"); HL's mainnet `webData2`.
