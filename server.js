import express from 'express'
import cors from 'cors'
import fs from 'fs'
import { createPublicClient, http } from 'viem'
import { baseSepolia, arbitrumSepolia, sepolia } from 'viem/chains'

const app = express()
app.use(cors())
app.use(express.json())

const DATA_FILE = './bridges.json'

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { bridges: [] }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'))
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

function sumTotal(data) {
  return data.bridges.reduce((sum, b) => sum + b.amount, 0)
}

const CHAIN_MAP = {
  Base_Sepolia: baseSepolia,
  Arbitrum_Sepolia: arbitrumSepolia,
  Ethereum_Sepolia: sepolia,
}

// Record a bridge — verifies the tx really happened on-chain before counting it
app.post('/api/bridges', async (req, res) => {
  const { chain, txHash, amount } = req.body
  if (!chain || !txHash || !amount) {
    return res.status(400).json({ error: 'Missing fields' })
  }

  const data = loadData()
  if (data.bridges.some((b) => b.txHash === txHash)) {
    return res.json({ ok: true, duplicate: true, total: sumTotal(data) })
  }

  const viemChain = CHAIN_MAP[chain]
  if (!viemChain) return res.status(400).json({ error: 'Unknown chain' })

  try {
    const client = createPublicClient({ chain: viemChain, transport: http() })
    const receipt = await client.getTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      return res.status(400).json({ error: 'Transaction not successful on-chain' })
    }
  } catch (err) {
    return res.status(400).json({ error: 'Could not verify transaction on-chain' })
  }

  data.bridges.push({ chain, txHash, amount: Number(amount), timestamp: Date.now() })
  saveData(data)
  res.json({ ok: true, total: sumTotal(data) })
})

// Get the running total
app.get('/api/volume', (req, res) => {
  const data = loadData()
  res.json({ total: sumTotal(data), count: data.bridges.length })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`ArcBridge backend running on port ${PORT}`))