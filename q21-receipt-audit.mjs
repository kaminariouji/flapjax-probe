// q21-receipt-audit.mjs — FlapJax Receipt Relay (Q21): audit one daily buyback receipt
// against the BSC chain, field by field. Zero-dep, read-only. No keys needed.
//
// Usage:
//   node q21-receipt-audit.mjs                  -> audits the Oct 9 buy  (0xbeefabdc…)
//   node q21-receipt-audit.mjs 0x8ce8e857…      -> audits any other buy tx
//   RPC_URL=… node q21-receipt-audit.mjs        -> override the RPC
//
// What it prints, all re-checkable by a stranger:
//   1. tx hash + block + status, BNB value, gas used
//   2. FJ Transfer log inside the receipt (pool -> treasury, exact wei)
//   3. treasury FJ/BNB balances at block-1 and block+1 (the delta closes the loop)
//   4. pool slot0 at block-1 and at the buy block (sqrtPriceX96 + tick -> price)
//   5. the implied mid price vs the average execution price (fee + impact sanity)
//
// Notes on this repo's audit of the Oct 9 receipt (thread 28acbdea, reply 0dc6bae4):
//   receipt says "0.01 BNB -> 24,052,995 FLAPJAX" -> exact 24,052,995.30827152476827804 (floored to the unit)
//   receipt says "treasury now 0.1769 BNB"          -> exact 0.17685311231 (rounded up at 4dp)
//   every other figure matches exactly; no wrong-task/wrong-recipient/duplicate finding.

const RPC_URL = process.env.RPC_URL || 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3';
const FJ = '0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df';
const TREASURY = '0x7C34E9e21eE28A49Ff0b84B61774119E6633359f';
const POOL = '0xcA93EC685b8623688E6B236f9068034B298c2150';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_TX = '0xbeefabdc89f9148f9daaef6082d34a60dc5b4b612972ca0fd39d6bd4eb03b4b0';

const TX = process.argv[2] || DEFAULT_TX;

async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const pad = a => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const fmt = (v, d = 18) => {
  const b = BigInt(v);
  const s = b / 10n ** BigInt(d);
  const f = (b % 10n ** BigInt(d)).toString().padStart(d, '0').replace(/0+$/, '');
  return f ? `${s}.${f}` : s.toString();
};
const asInt24 = h => {
  let v = BigInt(h) & 0xffffffn;
  if (v >= 0x800000n) v -= 0x1000000n;
  return Number(v);
};

const tx = await rpc('eth_getTransactionByHash', [TX]);
if (!tx) { console.log('tx not found:', TX); process.exit(1); }
const rc = await rpc('eth_getTransactionReceipt', [TX]);
const blk = Number(BigInt(rc.blockNumber));
const hexBlk = n => '0x' + n.toString(16);

console.log('=== 1) TX ===');
console.log('hash    :', TX);
console.log('block   :', blk);
console.log('status  :', rc.status === '0x1' ? 'success' : 'FAILED');
console.log('from    :', tx.from);
console.log('to      :', tx.to);
console.log('value   :', fmt(tx.value), 'BNB');
console.log('gasUsed :', Number(BigInt(rc.gasUsed)).toLocaleString());

console.log('\n=== 2) FJ Transfer log in the receipt ===');
let fjIn = null;
for (const l of rc.logs) {
  if (l.address.toLowerCase() === FJ.toLowerCase() && l.topics[0] === TRANSFER) {
    const from = '0x' + l.topics[1].slice(26);
    const to = '0x' + l.topics[2].slice(26);
    fjIn = BigInt(l.data);
    console.log(`pool -> treasury Transfer: from ${from} to ${to}`);
    console.log('FJ received (exact wei):', fmt(l.data));
  }
}
if (!fjIn) console.log('no FJ Transfer in this receipt');

console.log('\n=== 3) treasury balances around the buy (delta closes the loop) ===');
const balFJ = async b => BigInt(await rpc('eth_call', [{ to: FJ, data: '0x70a08231' + pad(TREASURY).slice(2) }, hexBlk(b)]));
const balBNB = async b => BigInt(await rpc('eth_getBalance', [TREASURY, hexBlk(b)]));
const [fj0, fj1, bn0, bn1] = [await balFJ(blk - 1), await balFJ(blk + 1), await balBNB(blk - 1), await balBNB(blk + 1)];
console.log('block-1 FJ :', fmt(fj0));
console.log('block+1 FJ :', fmt(fj1));
console.log('FJ delta   :', fmt(fj1 - fj0), fjIn !== null ? (fj1 - fj0 === fjIn ? '(== Transfer log exactly)' : '(MISMATCH vs Transfer log!)') : '');
console.log('block-1 BNB:', fmt(bn0));
console.log('block+1 BNB:', fmt(bn1));
console.log('BNB delta  :', fmt(bn0 - bn1), '(should be 0.01 + gas)');

console.log('\n=== 4) pool slot0 before/at the buy ===');
for (const [label, b] of [['before (block-1)', blk - 1], ['at buy (block) ', blk]]) {
  const s0 = await rpc('eth_call', [{ to: POOL, data: '0x3850c7bd' }, hexBlk(b)]);
  const sqrtP = BigInt('0x' + s0.slice(2, 66));
  const tick = asInt24('0x' + s0.slice(66, 130));
  const price = (Number(sqrtP) / 2 ** 96) ** 2; // WBNB per FJ (token1/token0, both 18dp)
  console.log(`${label} sqrtPriceX96=${sqrtP} tick=${tick}`);
  console.log(`  mid ${price.toExponential(6)} WBNB per FJ | 0.01 BNB implies ~${Math.round(0.01 / price).toLocaleString()} FJ`);
  if (b === blk - 1 && fjIn) {
    const avg = 0.01 / (Number(fjIn) / 1e18);
    console.log(`  average execution from the receipt: ${avg.toExponential(6)} WBNB per FJ`);
    console.log(`  avg/mid = ${(avg / price).toFixed(4)} (fee 1% + price impact should push this above 1)`);
  }
}
console.log('\nAll reads via', RPC_URL);
console.log('Re-check by hand: tx on BscScan + eth_call slot0 at the same block on any BSC archive node.');
