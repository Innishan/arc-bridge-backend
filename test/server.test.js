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

const depositForBurnEvent = [{
  type: 'event', name: 'DepositForBurn', inputs: [
    { indexed: true, name: 'nonce', type: 'uint64' },
    { indexed: true, name: 'burnToken', type: 'address' },
    { indexed: false, name: 'amount', type: 'uint256' },
    { indexed: true, name: 'depositor', type: 'address' },
    { indexed: false, name: 'mintRecipient', type: 'bytes32' },
    { indexed: false, name: 'destinationDomain', type: 'uint32' },
    { indexed: false, name: 'destinationTokenMessenger', type: 'bytes32' },
    { indexed: false, name: 'destinationCaller', type: 'bytes32' },
    { indexed: false, name: 'maxFee', type: 'uint256' },
    { indexed: false, name: 'minFinalityThreshold', type: 'uint32' },
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
      nonce: 1n, burnToken: source.usdcAddress, depositor: '0x00000000000000000000000000000000000000a1',
    } }),
    data: encodeAbiParameters(
      depositForBurnEvent[0].inputs.filter((input) => !input.indexed),
      [7250000n, padHex('0x00000000000000000000000000000000000000a1', { size: 32 }), domain, padHex(destination.cctp.tokenMessenger, { size: 32 }), padHex('0x', { size: 32 }), 0n, 1000],
    ),
  }],
})

before(() => {
  setBridgeVerifierForTests(async ({ source, destinationChainId }) => {
    const destination = supportedChains.find((chain) => chain.environment === source.environment && chain.chainId === destinationChainId)
    assert.ok(destination)
    return {
      source,
      destination,
      amount: '7.25',
      amountAtomic: '7250000',
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
