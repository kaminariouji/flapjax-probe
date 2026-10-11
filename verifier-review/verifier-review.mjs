// verifier-review.mjs — review independen klaim verifier lander (vesper fjv)
// RPC INDEPENDEN dari verifier (mereka bsc-dataseed; kita publicnode) + baca lock record ON-CHAIN
// Needs ethers only: `npm i ethers`. Read-only, no keys, no signing.
import { ethers } from 'ethers'

const RPC = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.defibit.io', 'https://bsc-dataseed.binance.org']
const FJ = '0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const BTCB = '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c'
const POOL1 = '0xcA93EC685b8623688E6B236f9068034B298c2150'
const POOL2 = '0x740a3b4a91cb8fa47e85d7f9713ca6ec2f8a037e'
const TREASURY = '0x7C34E9e21eE28A49Ff0b84B61774119E6633359f'
const LOCKER = '0x25c9c4b56e820e0dea438b145284f02d9ca9bd52'

let provider
for (const url of RPC) {
  try { const p = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true }); await p.getBlockNumber(); provider = p; console.log('RPC:', url); break } catch {}
}
if (!provider) { console.error('semua RPC gagal'); process.exit(1) }
const BLOCK = await provider.getBlockNumber()
const at = { blockTag: BLOCK }
console.log('block:', BLOCK, '\n')

const call = async (to, data) => { const r = await provider.call({ to, data, ...at }); return r }
const sel = (sig) => ethers.id(sig).slice(0, 10)
const addr = (w) => ethers.getAddress('0x' + w.slice(26))
const OUT = { block: BLOCK, rpc: provider._getConnection?.().url, checks: {} }

// 1. token identity + owner (name/symbol ABI-encoded strings)
const abiCoder = ethers.AbiCoder.defaultAbiCoder()
const clean = (hex) => { try { return abiCoder.decode(['string'], hex)[0] } catch { return ethers.toUtf8String(hex).replace(/\x00/g, '') } }
const name = clean(await call(FJ, sel('name()')))
const sym = clean(await call(FJ, sel('symbol()')))
const owner = addr(await call(FJ, sel('owner()')))
OUT.checks.token = { name, symbol: sym, owner }
console.log('token:', name, sym, '| owner:', owner)

// 2. treasury
const fjBal = BigInt(await call(FJ, sel('balanceOf(address)') + ethers.zeroPadValue(TREASURY, 32).slice(2)))
const bnbBal = await provider.getBalance(TREASURY, BLOCK)
OUT.checks.treasury = { fj: fjBal.toString(), fjM: (Number(fjBal) / 1e24).toFixed(2) + 'M', bnb: ethers.formatEther(bnbBal) }
console.log('treasury FJ:', (Number(fjBal) / 1e24).toFixed(3) + 'M', '| BNB:', ethers.formatEther(bnbBal))

// 3. pools
for (const [tag, pool, counter] of [['primary', POOL1, WBNB], ['secondary', POOL2, BTCB]]) {
  const t0 = addr(await call(pool, sel('token0()')))
  const t1 = addr(await call(pool, sel('token1()')))
  const poolFJ = BigInt(await call(FJ, sel('balanceOf(address)') + ethers.zeroPadValue(pool, 32).slice(2)))
  const liq = BigInt(await call(pool, sel('liquidity()')))
  const slot0 = await call(pool, sel('slot0()'))
  const sqrtP = BigInt('0x' + slot0.slice(2, 66))
  const tick = Number(BigInt.asIntN(24, BigInt('0x' + slot0.slice(66, 130))))
  const counterSym = clean(await call(counter, sel('symbol()')))
  OUT.checks[tag] = { pool, token0: t0, token1: t1, fjHeld: (Number(poolFJ) / 1e18 / 1e9).toFixed(2) + 'B', liquidity: liq.toString(), sqrtPriceX96: sqrtP.toString(), tick, counter: counterSym }
  console.log(tag, '| token0==FJ:', t0.toLowerCase() === FJ.toLowerCase(), '| FJ held:', (Number(poolFJ) / 1e18 / 1e9).toFixed(2) + 'B', '| liq:', liq.toString().slice(0, 18) + '…', '| tick:', tick, '|', counterSym)
}

// 4. locker lock record id 101 (SafeToken Locker) — upgrade klaim 'LP -> Dec 2034' dari NOT VERIFIABLE
// Layout terverifikasi dari raw words: [id, token(NPM), ?, owner?, ?, pool, fee?, tokenId, lockDate, unlockDate]
const lockerIface = new ethers.Interface(['function locks(uint256) view returns (uint256,address,address,address,address,address,uint256,uint256,uint256,uint256)'])
const lockRaw = await call(LOCKER, lockerIface.encodeFunctionData('locks', [101]))
const lk = lockerIface.decodeFunctionResult('locks', lockRaw)
const lock = {
  id: lk[0].toString(), nftContract: lk[1], pool: lk[5], tokenId: lk[7].toString(),
  lockDate: new Date(Number(lk[8]) * 1000).toISOString(), unlockDate: new Date(Number(lk[9]) * 1000).toISOString(),
  unlockTs: lk[9].toString(),
}
OUT.checks.lock101 = { ...lock, nftContractIsNPM: lk[1].toLowerCase() === '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364', poolIsPrimary: lk[5].toLowerCase() === POOL1.toLowerCase() }
console.log('\nlock 101:', JSON.stringify(OUT.checks.lock101, null, 1))

// 4b. ownerOf(tokenId) sekarang — masih di locker?
const npmIface = new ethers.Interface(['function ownerOf(uint256) view returns (address)'])
const ownRaw = await call('0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', npmIface.encodeFunctionData('ownerOf', [1456181]))
const nftOwner = addr(ownRaw)
OUT.checks.nftOwner1456181 = { owner: nftOwner, isLocker: nftOwner.toLowerCase() === LOCKER.toLowerCase() }
console.log('ownerOf(1456181):', nftOwner, '| = locker?', OUT.checks.nftOwner1456181.isLocker)

// 4c. positions(1456181) di NPM — liquidity HARUS == pool.liquidity() + tokensOwed (fee belum dipanen)
const NPM = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'
const posIface = new ethers.Interface(['function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'])
const posRaw = await call(NPM, posIface.encodeFunctionData('positions', [1456181]))
const pos = posIface.decodeFunctionResult('positions', posRaw)
const poolLiq = BigInt(OUT.checks.primary.liquidity)
OUT.checks.position1456181 = {
  fee: Number(pos[4]), tickLower: Number(pos[5]), tickUpper: Number(pos[6]),
  liquidity: pos[7].toString(),
  liquidityEqualsPool: BigInt(pos[7]) === poolLiq,
  tokensOwedFJ: pos[10].toString(), tokensOwedFJhuman: (Number(pos[10]) / 1e18).toFixed(3),
  tokensOwedWBNB: pos[11].toString(), tokensOwedWBNBhuman: (Number(pos[11]) / 1e18).toFixed(6),
}
console.log('positions(1456181): liq == pool.liq?', OUT.checks.position1456181.liquidityEqualsPool,
  '| tokensOwed:', OUT.checks.position1456181.tokensOwedFJhuman, 'FJ +', OUT.checks.position1456181.tokensOwedWBNBhuman, 'WBNB')

// 5. partial 0%-tax check: exact transfer amounts (treasury -> us): our balanceOf == sum of payouts
const US = '0x8c062Dc5D775B7D5efc168F75a875f392f53dCdf'
const ourBal = BigInt(await call(FJ, sel('balanceOf(address)') + ethers.zeroPadValue(US, 32).slice(2)))
OUT.checks.ourBalance = { addr: US, fj: ourBal.toString(), expected: '1750000' }
console.log('\nour FJ balance:', ourBal.toString(), '(expected 1750000e18 = 750k+250k+500k+250k)')

console.log('\n===JSON===')
console.log(JSON.stringify(OUT, null, 1))
