// locker-multicall.mjs — scan SEMUA lock records via Multicall3, cari tokenId 1456181 & 5144842
// ABI asli locks(uint256) -> uint256,address,address,address,address,address,uint256,uint256,uint256,uint256 (10 words)
import { ethers } from 'ethers'

const RPCS = ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.defibit.io']
const LOCKER = '0x25c9c4b56e820e0dea438b145284f02d9ca9bd52'
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const TARGETS = [1456181n, 5144842n]

let provider
for (const url of RPCS) {
  try { const p = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true }); await p.getBlockNumber(); provider = p; break } catch (e) {}
}
if (!provider) { console.log('semua RPC gagal'); process.exit(1) }
const BLOCK = await provider.getBlockNumber() // latest (RPC publik tidak simpan trie historis)

const iface = new ethers.Interface(['function locks(uint256) view returns (uint256,address,address,address,address,address,uint256,uint256,uint256,uint256)'])
const sel = iface.encodeFunctionData('locks', [0]).slice(0, 10)

// nextLockId
const nextRaw = await provider.call({ to: LOCKER, data: ethers.id('nextLockId()').slice(0, 10) })
const nextId = Number(BigInt(nextRaw))
console.log('nextLockId =', nextId, '| scan semua', nextId, 'records via Multicall3 @ block', BLOCK)

const mc = new ethers.Interface(['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)'])

const BATCH = 500
const results = new Array(nextId)
for (let start = 0; start < nextId; start += BATCH) {
  const calls = []
  for (let i = start; i < Math.min(start + BATCH, nextId); i++) {
    calls.push({ target: LOCKER, allowFailure: true, callData: sel + ethers.zeroPadValue(ethers.toBeHex(i), 32).slice(2) })
  }
  const data = mc.encodeFunctionData('aggregate3', [calls])
  const raw = await provider.call({ to: MULTICALL3, data })
  const [rets] = mc.decodeFunctionResult('aggregate3', raw)
  rets.forEach((r, k) => { if (r.success) results[start + k] = r.returnData })
  process.stdout.write('.')
}
console.log('\nscan selesai')

// cari target tokenId di semua record (cek SEMUA word, karena posisi tokenId belum pasti)
const found = []
for (let i = 0; i < nextId; i++) {
  const r = results[i]
  if (!r || r === '0x') continue
  const words = r.slice(2).match(/.{64}/g) || []
  const nums = words.map((w) => BigInt('0x' + w))
  for (const t of TARGETS) {
    if (nums.includes(t)) {
      found.push({ lockId: i, target: t.toString(), words: nums })
      break
    }
  }
}

if (!found.length) { console.log('TIDAK ADA lock record dengan tokenId', TARGETS.map(String).join(' / ')); process.exit(0) }

for (const f of found) {
  console.log('\n=== lock id', f.lockId, '| tokenId', f.target, '===')
  f.words.forEach((w, i) => {
    const n = Number(w)
    let note = ''
    if (n > 1600000000 && n < 2600000000) note = '  <-- unix ts: ' + new Date(n * 1000).toISOString()
    else if (w < 2n ** 160n && w > 2n ** 40n) note = '  <-- addr?: 0x' + w.toString(16).padStart(40, '0')
    else if (w > 2n ** 100n) note = '  <-- uint besar (liquidity?)'
    console.log('  [' + i + ']', w.toString(), note)
  })
}

// interpretasi label (dari urutan ABI + heuristik):
// [0]=id [1]=owner [2]=token(pool) [3]=nftManager [4]/[5]=collectAddress dll [6..]=tokenId/times/liq/fee
console.log('\n=== ringkasan ===')
for (const f of found) {
  const w = f.words
  const tss = w.filter((x) => x > 1600000000n && x < 2600000000n).map((x) => new Date(Number(x) * 1000).toISOString())
  const addrs = w.filter((x) => x < 2n ** 160n && x > 2n ** 40n).map((x) => ethers.getAddress('0x' + x.toString(16).padStart(40, '0')))
  console.log('lock', f.lockId, 'tokenId', f.target, '| ts fields:', tss.join(' -> ') || '(none)', '| addrs:', addrs.join(', '))
}
