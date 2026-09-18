import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeAbiParameters, encodeEventTopics, padHex } from 'viem'

const dataDirectory = mkdtempSync(join(tmpdir(), 'arc-bridge-api-'))
const dataFileDirectory = join(dataDirectory, 'render-disk', 'analytics')
process.env.DATA_FILE = join(dataFileDirectory, 'bridges.json')
mkdirSync(dataFileDirectory, { recursive: true })
writeFileSync(process.env.DATA_FILE, JSON.stringify({ bridges: [{
  chain: 'Base_Sepolia',
  txHash: `0x${'1'.repeat(64)}`,
  amount: 2.5,
  timestamp: 1000,
}] }))

const { app, assertSupportedChainRegistry, setBridgeVerifierForTests, supportedChains, verifyBridge } = await import('../server.js')
const server = app.listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const port = server.address().port
const endpoint = (path) => `http://127.0.0.1:${port}${path}`
const wallet = (suffix) => `0x${suffix.padStart(40, '0')}`
let verifiedFixture = { amount: '7.25', amountAtomic: '7250000', depositor: wallet('a1') }

const depositForBurnEvent = [{
  type: 'event', name: 'DepositForBurn', inputs: [
    { indexed: true, name: 'burnToken', type: 'address' },
    { indexed: false, name: 'amount', type: 'uint256' },
    { indexed: true, name: 'depositor', type: 'address' },
    { indexed: false, name: 'mintRecipient', type: 'bytes32' },
    { indexed: false, name: 'destinationDomain', type: 'uint32' },
    { indexed: false, name: 'destinationTokenMessenger', type: 'bytes32' },
    { indexed: false, name: 'destinationCaller', type: 'bytes32' },
    { indexed: false, name: 'maxFee', type: 'uint256' },
    { indexed: true, name: 'minFinalityThreshold', type: 'uint32' },
    { indexed: false, name: 'hookData', type: 'bytes' },
  ],
}]

const mainnetChain = (chainId) => supportedChains.find((chain) => chain.environment === 'mainnet' && chain.chainId === chainId)
const mockClient = (receipt) => ({
  getTransactionReceipt: async () => receipt,
  getBlock: async () => ({ timestamp: 2n }),
})
const depositReceipt = ({ source, destination, domain = destination.cctp.domain, messenger = source.cctp.tokenMessenger }) => ({
  status: 'success', blockNumber: 1n, logs: [{
    address: messenger,
    topics: encodeEventTopics({ abi: depositForBurnEvent, eventName: 'DepositForBurn', args: {
      burnToken: source.usdcAddress, depositor: '0x00000000000000000000000000000000000000a1', minFinalityThreshold: 1000,
    } }),
    data: encodeAbiParameters(
      depositForBurnEvent[0].inputs.filter((input) => !input.indexed),
      [7250000n, padHex('0x00000000000000000000000000000000000000a1', { size: 32 }), domain, padHex(destination.cctp.tokenMessenger, { size: 32 }), padHex('0x', { size: 32 }), 0n, '0x'],
    ),
  }],
})

before(() => {
  setBridgeVerifierForTests(async ({ source, destinationChainId }) => {
    if (verifiedFixture.error) throw new Error('verification failed')
    const destination = supportedChains.find((chain) => chain.environment === source.environment && chain.chainId === (destinationChainId ?? 5042002))
    assert.ok(destination)
    return {
      source,
      destination,
      ...verifiedFixture,
      timestamp: 2000,
    }
  })
})

after(() => {
  server.close()
  rmSync(dataDirectory, { recursive: true, force: true })
})

test('all frontend EVM mainnet routes have a unique, valid CCTP V2 registry entry', () => {
  const expectedDomains = new Map([
    [5042, 26], [42161, 3], [43114, 1], [8453, 6], [81224, 12], [25, 32], [3343, 28], [1, 0], [999, 19], [1776, 29], [57073, 21], [59144, 11], [143, 15], [2818, 30], [10, 2], [1672, 31], [9745, 33], [98866, 22], [137, 7], [1329, 16], [146, 13], [130, 10], [480, 14], [50, 18], [196, 37],
  ])
  const mainnet = supportedChains.filter((chain) => chain.environment === 'mainnet')
  assert.equal(mainnet.length, expectedDomains.size)
  assert.deepEqual(new Map(mainnet.map((chain) => [chain.chainId, chain.cctp.domain])), expectedDomains)
  assert.doesNotThrow(() => assertSupportedChainRegistry(supportedChains))
  assert.equal(mainnet.find((chain) => chain.chainId === 3343)?.cctp.tokenMessenger, '0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c')
})

test('registry validation rejects invalid CCTP domains and malformed routes', () => {
  const invalidDomain = structuredClone(supportedChains[0])
  invalidDomain.cctp.domain = -1
  assert.throws(() => assertSupportedChainRegistry([invalidDomain]), /Invalid or duplicate CCTP domain/)

  const invalidAddress = structuredClone(supportedChains[0])
  invalidAddress.cctp.tokenMessenger = '0x1234'
  assert.throws(() => assertSupportedChainRegistry([invalidAddress]), /Invalid CCTP address configuration/)
})

test('CCTP receipt verification derives the event amount and verifies the configured route', async () => {
  const source = mainnetChain(8453)
  const destination = mainnetChain(1)
  const result = await verifyBridge({
    source, destinationChainId: destination.chainId, txHash: `0x${'3'.repeat(64)}`,
    client: mockClient(depositReceipt({ source, destination })),
  })
  assert.equal(result.amount, '7.25')
  assert.equal(result.amountAtomic, '7250000')
  assert.equal(result.destination.chainId, 1)
})

test('CCTP verification rejects an App Kit FeePaid event as a DepositForBurn event', async () => {
  const source = mainnetChain(8453)
  await assert.rejects(
    verifyBridge({
      source, destinationChainId: 5042, txHash: `0x${'9'.repeat(64)}`,
      client: mockClient({
        status: 'success', blockNumber: 1n,
        logs: [{
          address: '0xB3FA262d0fB521cc93bE83d87b322b8A23DAf3F0',
          topics: ['0xaf81f7f62ee75dafb220171fa668da33f390a1cc0afcd2df70558e33970acee2'],
          data: '0x',
        }],
      }),
    }),
    /No CCTP DepositForBurn event/,
  )
})

test('CCTP verification rejects unsupported destination domains, route mismatches, and unverified TokenMessenger logs', async () => {
  const source = mainnetChain(8453)
  const destination = mainnetChain(1)
  await assert.rejects(
    verifyBridge({ source, destinationChainId: destination.chainId, txHash: `0x${'4'.repeat(64)}`, client: mockClient(depositReceipt({ source, destination, domain: 999 })) }),
    /destination is not a supported route/,
  )
  await assert.rejects(
    verifyBridge({ source, destinationChainId: destination.chainId, txHash: `0x${'5'.repeat(64)}`, client: mockClient(depositReceipt({ source, destination: mainnetChain(5042) })) }),
    /destination chain does not match/,
  )
  await assert.rejects(
    verifyBridge({ source, destinationChainId: destination.chainId, txHash: `0x${'6'.repeat(64)}`, client: mockClient(depositReceipt({ source, destination, messenger: '0x000000000000000000000000000000000000dead' })) }),
    /No CCTP DepositForBurn event/,
  )
})

test('legacy volume read remains isolated to testnet', async () => {
  const response = await fetch(endpoint('/api/volume'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    environment: 'testnet',
    total: 2.5,
    count: 1,
    average: 2.5,
    networkActivity: [{ chainId: 84532, chain: 'Base_Sepolia', count: 1, volume: 2.5 }],
    recentTransfers: [{
      environment: 'testnet', sourceChainId: 84532, destinationChainId: null,
      sourceChain: 'Base_Sepolia', destinationChain: null, chain: 'Base_Sepolia',
      txHash: `0x${'1'.repeat(64)}`, amount: 2.5, timestamp: 1000,
      explorerUrl: `https://sepolia.basescan.org/tx/0x${'1'.repeat(64)}`,
    }],
  })
})

test('bridge recording ignores a caller supplied amount and returns mainnet analytics', async () => {
  const response = await fetch(endpoint('/api/bridges'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      environment: 'mainnet', sourceChainId: 8453, destinationChainId: 1,
      txHash: `0x${'2'.repeat(64)}`, amount: '999999',
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.duplicate, false)
  assert.equal(body.environment, 'mainnet')
  assert.equal(body.total, 7.25)
  assert.equal(body.recentTransfers[0].amount, '7.25')
  assert.equal(body.recentTransfers[0].amountAtomic, '7250000')
  assert.equal(body.recentTransfers[0].sourceChain, 'Base')
  assert.equal(body.recentTransfers[0].destinationChain, 'Ethereum')
})

test('duplicate mainnet records remain idempotent and do not leak into testnet analytics', async () => {
  const duplicate = await fetch(endpoint('/api/bridges'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ environment: 'mainnet', sourceChainId: 8453, destinationChainId: 1, txHash: `0x${'2'.repeat(64)}`, amount: '0.01' }),
  })
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).duplicate, true)

  const mainnet = await fetch(endpoint('/api/volume?environment=mainnet'))
  assert.equal((await mainnet.json()).count, 1)
  const testnet = await fetch(endpoint('/api/volume'))
  assert.equal((await testnet.json()).count, 1)
})

test('invalid request values are rejected before verification', async () => {
  const response = await fetch(endpoint('/api/bridges'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ environment: 'mainnet', sourceChainId: 8453, txHash: 'not-a-hash' }),
  })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Invalid transaction hash' })
})

test('unknown mainnet chain IDs are rejected before verification', async () => {
  const response = await fetch(endpoint('/api/bridges'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ environment: 'mainnet', sourceChainId: 999999, destinationChainId: 1, txHash: `0x${'7'.repeat(64)}` }),
  })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Unknown source chain for environment' })
})

test('custom absolute DATA_FILE path recreates its parent directory before persistence', async () => {
  rmSync(dataFileDirectory, { recursive: true, force: true })
  const txHash = `0x${'8'.repeat(64)}`
  const response = await fetch(endpoint('/api/bridges'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ environment: 'mainnet', sourceChainId: 8453, destinationChainId: 1, txHash }),
  })
  assert.equal(response.status, 200)
  assert.equal(existsSync(process.env.DATA_FILE), true)
  assert.ok(JSON.parse(readFileSync(process.env.DATA_FILE, 'utf-8')).bridges.some((bridge) => bridge.txHash === txHash))
})

const resetPointsData = () => writeFileSync(process.env.DATA_FILE, JSON.stringify({ bridges: [], points: { totalDistributedMicro: '0', users: {}, referrals: {}, ledger: [] } }))
const post = async (path, body) => fetch(endpoint(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const recordMainnetBridge = (txChar, amountAtomic, depositor, extra = {}) => {
  verifiedFixture = { amount: String(Number(amountAtomic) / 1_000_000), amountAtomic, depositor }
  return post('/api/bridges', { environment: 'mainnet', sourceChainId: 8453, destinationChainId: 5042, txHash: `0x${txChar.repeat(64)}`, amount: '999999', wallet: wallet('ffff'), ...extra })
}

test('verified bridge points use exact atomic USDC amounts and ignore client amount or wallet', async () => {
  resetPointsData()
  const depositor = wallet('101')
  let response = await recordMainnetBridge('a', '1000000', depositor)
  let body = await response.json()
  assert.equal(body.points.awarded, 1)
  assert.equal(body.points.walletPoints, 1)

  response = await recordMainnetBridge('b', '50000', depositor)
  body = await response.json()
  assert.equal(body.points.awarded, 0.05)
  assert.equal(body.points.points, 1.05)

  response = await recordMainnetBridge('c', '125500000', depositor)
  body = await response.json()
  assert.equal(body.points.awarded, 125.5)
  assert.equal(body.points.points, 126.55)
  const points = await (await fetch(endpoint(`/api/points?address=${depositor}`))).json()
  assert.equal(points.points, 126.55)
  assert.equal(points.bridgePoints, 126.55)
  assert.equal((await (await fetch(endpoint(`/api/points?address=${wallet('ffff')}`))).json()).points, 0)
})

test('failed and duplicate bridge submissions award no additional points', async () => {
  const depositor = wallet('102')
  const before = await (await fetch(endpoint(`/api/points?address=${depositor}`))).json()
  verifiedFixture = { error: true }
  const failed = await post('/api/bridges', { environment: 'mainnet', sourceChainId: 8453, destinationChainId: 5042, txHash: `0x${'0'.repeat(64)}` })
  assert.equal(failed.status, 400)
  assert.equal((await (await fetch(endpoint(`/api/points?address=${depositor}`))).json()).points, before.points)
  verifiedFixture = { amount: '1', amountAtomic: '1000000', depositor }
  const txHash = `0x${'d'.repeat(64)}`
  const first = await post('/api/bridges', { environment: 'mainnet', sourceChainId: 8453, destinationChainId: 5042, txHash })
  assert.equal((await first.json()).points.awarded, 1)
  const duplicate = await post('/api/bridges', { environment: 'mainnet', sourceChainId: 8453, destinationChainId: 5042, txHash })
  assert.equal((await duplicate.json()).points.awarded, 0)
  const after = await (await fetch(endpoint(`/api/points?address=${depositor}`))).json()
  assert.equal(after.points, before.points + 1)
})

test('referrals are immutable, reject invalid and self referrals, and reward only a first verified bridge', async () => {
  const referrer = wallet('201')
  const referred = wallet('202')
  assert.equal((await post('/api/referrals', { referrer, referred })).status, 200)
  assert.equal((await post('/api/referrals', { referrer: referred, referred })).status, 400)
  assert.equal((await post('/api/referrals', { referrer: 'invalid', referred })).status, 400)
  assert.equal((await post('/api/referrals', { referrer: wallet('203'), referred })).status, 409)
  let referrerPoints = await (await fetch(endpoint(`/api/points?address=${referrer}`))).json()
  assert.equal(referrerPoints.points, 0)
  let first = await recordMainnetBridge('e', '50000', referred)
  assert.equal((await first.json()).points.referralAwarded, true)
  referrerPoints = await (await fetch(endpoint(`/api/points?address=${referrer}`))).json()
  assert.equal(referrerPoints.referralPoints, 50)
  assert.equal(referrerPoints.successfulReferrals, 1)
  const second = await recordMainnetBridge('f', '1000000', referred)
  assert.equal((await second.json()).points.referralAwarded, false)
  referrerPoints = await (await fetch(endpoint(`/api/points?address=${referrer}`))).json()
  assert.equal(referrerPoints.referralPoints, 50)
})

test('testnet bridges do not award mainnet points', async () => {
  const depositor = wallet('301')
  verifiedFixture = { amount: '10', amountAtomic: '10000000', depositor }
  const response = await post('/api/bridges', { environment: 'testnet', chain: 'Base_Sepolia', txHash: `0x${'7'.repeat(64)}` })
  assert.equal(response.status, 200)
  const points = await (await fetch(endpoint(`/api/points?address=${depositor}`))).json()
  assert.equal(points.points, 0)
})

test('the global cap clamps bridge and referral awards and completes the program exactly', async () => {
  const referrer = wallet('401')
  const referred = wallet('402')
  const data = JSON.parse(readFileSync(process.env.DATA_FILE, 'utf-8'))
  data.points.totalDistributedMicro = '999999996750'
  data.points.totalDistributed = 999999.99675
  data.points.users = {}
  data.points.referrals = { [referred]: { referrer, createdAt: 1, rewarded: false, rewardedAt: null } }
  data.points.ledger = []
  writeFileSync(process.env.DATA_FILE, JSON.stringify(data))
  const response = await recordMainnetBridge('8', '50000', referred)
  const body = await response.json()
  assert.equal(body.points.awarded, 0.00325)
  assert.equal(body.points.referralAwarded, false)
  assert.equal(body.points.programComplete, true)
  const program = await (await fetch(endpoint(`/api/points?address=${referred}`))).json()
  assert.equal(program.totalDistributed, 1000000)
  assert.equal(program.remaining, 0)
  assert.equal(program.programComplete, true)
})
