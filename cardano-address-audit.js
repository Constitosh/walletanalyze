/**
 * cardano-address-audit.js
 *
 * Usage:
 *   BLOCKFROST_PROJECT_ID=your_key node cardano-address-audit.js <cardano_address>
 *
 * Installs:
 *   npm i axios dotenv
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
if (!BLOCKFROST_PROJECT_ID) {
  console.error("Error: set BLOCKFROST_PROJECT_ID in your environment or .env file");
  process.exit(1);
}

const baseURL = 'https://cardano-mainnet.blockfrost.io/api/v0';
const client = axios.create({
  baseURL,
  headers: { project_id: BLOCKFROST_PROJECT_ID },
  timeout: 20000,
});

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// (kept for completeness if you ever need it)
function lovelaceToAda(lovelaceStr) {
  return Number(BigInt(lovelaceStr) / 1000000n) + Number((BigInt(lovelaceStr) % 1000000n)) / 1e6;
}

// 1) Defensive helper for extracting lovelace from an amount array
function sumLovelaceAmount(arr) {
  if (!Array.isArray(arr)) return 0n;
  const item = arr.find((a) => a && a.unit === 'lovelace');
  if (!item || item.quantity == null) return 0n;
  return BigInt(item.quantity);
}

async function fetchAllTxsForAddress(address) {
  const pageSize = 100;
  let page = 1;
  let txs = [];
  while (true) {
    const resp = await client.get(`/addresses/${encodeURIComponent(address)}/transactions`, {
      params: { page, count: pageSize, order: 'asc' },
    });
    if (!Array.isArray(resp.data) || resp.data.length === 0) break;
    txs = txs.concat(resp.data.map((d) => d.tx_hash));
    page += 1;
    await sleep(200);
  }
  return txs;
}

async function fetchTxUtxos(txhash) {
  const resp = await client.get(`/txs/${txhash}/utxos`);
  return resp.data; // { inputs: [...], outputs: [...] }
}

async function fetchTxInfo(txhash) {
  const resp = await client.get(`/txs/${txhash}`);
  return resp.data; // includes "fees" (plural)
}

// Main
(async () => {
  const address = process.argv[2];
  if (!address) {
    console.error("Usage: node cardano-address-audit.js <address>");
    process.exit(1);
  }

  console.log(`Fetching transactions for ${address} ...`);
  let txHashes;
  try {
    txHashes = await fetchAllTxsForAddress(address);
  } catch (err) {
    console.error("Failed to fetch address tx list:", err?.response?.data || err.message);
    process.exit(1);
  }

  console.log(`Found ${txHashes.length} tx(s). Processing each tx (this may take some time)...`);

  // Totals in lovelace (BigInt)
  let totalReceivedLovelace = 0n;
  let totalSpentLovelace = 0n;
  let totalFeesAttributed = 0n;
  let outgoingWithAssetsCount = 0;
  const outgoingAssetsSet = new Set();

  const perTxSummary = [];

  for (const txhash of txHashes) {
    try {
      const utxos = await fetchTxUtxos(txhash);
      await sleep(200);

      const txinfo = await fetchTxInfo(txhash);
      await sleep(150);

      // 2) Use "fees" (plural) + guard
      const feeLovelace = BigInt(txinfo?.fees ?? 0);

      // 3) Make loops resilient: normalize arrays before iterating
      const inputs = Array.isArray(utxos?.inputs) ? utxos.inputs : [];
      const outputs = Array.isArray(utxos?.outputs) ? utxos.outputs : [];

      // compute input lovelace total and lovelace from this address in inputs
      let totalInputsLovelace = 0n;
      let inputsFromAddressLovelace = 0n;
      let inputsFromAddressHasAssets = false;
      const assetsMovedFromAddressThisTx = [];

      for (const inp of inputs) {
        const inpL = sumLovelaceAmount(inp?.amount);
        totalInputsLovelace += inpL;

        if (inp?.address === address) {
          inputsFromAddressLovelace += inpL;
          const amounts = Array.isArray(inp?.amount) ? inp.amount : [];
          for (const a of amounts) {
            if (a && a.unit && a.unit !== 'lovelace') {
              inputsFromAddressHasAssets = true;
              assetsMovedFromAddressThisTx.push({ unit: a.unit, quantity: a.quantity });
              outgoingAssetsSet.add(a.unit);
            }
          }
        }
      }

      // compute outputs to the address (received)
      let outputsToAddressLovelace = 0n;
      for (const out of outputs) {
        if (out?.address === address) {
          outputsToAddressLovelace += sumLovelaceAmount(out?.amount);
        }
      }

      // accumulate totals
      totalReceivedLovelace += outputsToAddressLovelace;
      totalSpentLovelace += inputsFromAddressLovelace;

      // attribute fee proportionally (estimate)
      let feeAttributedToThisAddress = 0n;
      if (inputsFromAddressLovelace > 0n && totalInputsLovelace > 0n) {
        feeAttributedToThisAddress = (feeLovelace * inputsFromAddressLovelace) / totalInputsLovelace;
        totalFeesAttributed += feeAttributedToThisAddress;
      }

      if (inputsFromAddressHasAssets) {
        outgoingWithAssetsCount += 1;
      }

      perTxSummary.push({
        txhash,
        inputs_from_address_lovelace: inputsFromAddressLovelace.toString(),
        outputs_to_address_lovelace: outputsToAddressLovelace.toString(),
        fee_lovelace: feeLovelace.toString(),
        fee_attributed_lovelace: feeAttributedToThisAddress.toString(),
        outgoing_assets: assetsMovedFromAddressThisTx,
      });

    } catch (err) {
      console.warn(`Warning: failed to fetch/process tx ${txhash}: ${err?.response?.status} ${err?.response?.data || err?.message}`);
    }
  }

  const totalReceivedAda = Number(totalReceivedLovelace) / 1e6;
  const totalSpentAda = Number(totalSpentLovelace) / 1e6;
  const totalFeesAttributedAda = Number(totalFeesAttributed) / 1e6;
  const netAda = totalReceivedAda - totalSpentAda;

  const assetsMoved = Array.from(outgoingAssetsSet);

  const summary = {
    address,
    tx_count: txHashes.length,
    total_received_ada: totalReceivedAda,
    total_spent_ada: totalSpentAda,
    net_ada_change: netAda,
    estimated_fees_paid_ada: totalFeesAttributedAda,
    outgoing_txs_with_assets_count: outgoingWithAssetsCount,
    unique_asset_units_moved_out: assetsMoved,
    per_tx_count: perTxSummary.length,
  };

  console.log("\n===== SUMMARY =====");
  console.log(JSON.stringify(summary, null, 2));

  // Optional: write detailed JSON
  // import fs from 'fs';
  // fs.writeFileSync(
  //   `audit_${address.replace(/[^a-z0-9]/gi,'')}.json`,
  //   JSON.stringify({ summary, perTxSummary }, null, 2)
  // );

  console.log("\nDone.");
})();
