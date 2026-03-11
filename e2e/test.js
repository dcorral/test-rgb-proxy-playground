const rgblib = require("@utexo/rgb-lib-linux-x64");
const fs = require("fs");

const PROXY_URL = "rpc://proxy:3000/json-rpc";
const PROXY_HTTP = "http://proxy:3000/json-rpc";
const ELECTRS_URL = "tcp://electrs:50001";
const BITCOIND_URL = "http://bitcoind:18443/wallet/miner";
const BITCOIND_AUTH =
  "Basic " + Buffer.from("user:password").toString("base64");
const BITCOIN_NETWORK = rgblib.BitcoinNetwork.Regtest;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function bitcoindRpc(method, params = []) {
  const res = await fetch(BITCOIND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: BITCOIND_AUTH,
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: "e2e", method, params }),
  });
  const json = await res.json();
  if (json.error)
    throw new Error(`bitcoind ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function proxyRpc(method, params = null) {
  const res = await fetch(PROXY_HTTP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mine(n = 1) {
  const addr = await bitcoindRpc("getnewaddress");
  await bitcoindRpc("generatetoaddress", [n, addr]);
  console.log(`  Mined ${n} block(s)`);
}

async function waitForBalance(wallet, online, minSats, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const bal = wallet.getBtcBalance(online, false);
      if (BigInt(bal.vanilla.settled) >= BigInt(minSats)) {
        console.log(`  BTC balance settled: ${bal.vanilla.settled} sats`);
        return bal;
      }
    } catch (_) {
      /* electrs may still be indexing */
    }
    await sleep(500);
  }
  throw new Error(`Timeout waiting for BTC balance >= ${minSats}`);
}

async function waitForAck(recipientId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await proxyRpc("ack.get", { recipient_id: recipientId });
    if (res.result !== null && res.result !== undefined) {
      return res.result;
    }
    await sleep(1000);
  }
  throw new Error(`Timeout waiting for ACK on ${recipientId}`);
}

// ---------------------------------------------------------------------------
// Wallet helpers
// ---------------------------------------------------------------------------

function createWallet(name, vanillaKeychain = null) {
  const dataDir = `/tmp/rgb-e2e/${name}`;
  fs.mkdirSync(dataDir, { recursive: true });

  const keys = rgblib.generateKeys(BITCOIN_NETWORK);
  console.log(`  Keys generated for "${name}"`);

  const wallet = new rgblib.Wallet(
    new rgblib.WalletData({
      dataDir,
      bitcoinNetwork: BITCOIN_NETWORK,
      databaseType: rgblib.DatabaseType.Sqlite,
      maxAllocationsPerUtxo: "1",
      accountXpubVanilla: keys.accountXpubVanilla,
      accountXpubColored: keys.accountXpubColored,
      mnemonic: keys.mnemonic,
      masterFingerprint: keys.masterFingerprint,
      vanillaKeychain,
      supportedSchemas: [rgblib.AssetSchema.Nia],
    }),
  );
  console.log(`  Wallet "${name}" created`);
  return wallet;
}

async function fundWallet(wallet) {
  const address = wallet.getAddress();
  console.log(`  Address: ${address}`);

  await bitcoindRpc("sendtoaddress", [address, 1]);
  console.log("  Sent 1 BTC");
  await mine(1);
  await sleep(2000);

  const online = wallet.goOnline(false, ELECTRS_URL);
  console.log("  Online");

  await waitForBalance(wallet, online, 50000);

  const created = wallet.createUtxos(online, false, "5", null, "1", false);
  console.log(`  Created ${created} UTXOs`);

  return online;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    "=== E2E: Real RGB Transfer with Async Consignment Validation ===\n",
  );

  // 1. Verify proxy is reachable
  console.log("Step 1: Verify proxy is reachable");
  const info = await proxyRpc("server.info");
  if (!info.result || !info.result.version)
    throw new Error("Proxy not reachable: " + JSON.stringify(info));
  console.log(
    `  Proxy v${info.result.version} (protocol ${info.result.protocol_version})\n`,
  );

  // 2. Create and fund sender wallet
  console.log("Step 2: Create sender wallet");
  const sndWallet = createWallet("sender");
  console.log("");

  console.log("Step 3: Fund sender wallet");
  const sndOnline = await fundWallet(sndWallet);
  console.log("");

  // 3. Issue NIA asset
  console.log("Step 4: Issue NIA asset");
  const asset = sndWallet.issueAssetNIA(
    "ETEST",
    "E2E Test Token",
    "0",
    ["1000"],
  );
  console.log(`  Asset ID: ${asset.assetId}`);
  console.log(`  Balance:  ${JSON.stringify(asset.balance)}\n`);

  // 4. Create and fund receiver wallet
  console.log("Step 5: Create receiver wallet");
  const rcvWallet = createWallet("receiver", "3");
  console.log("");

  console.log("Step 6: Fund receiver wallet");
  const rcvOnline = await fundWallet(rcvWallet);
  // This mine also confirms sender's createUtxos + issuance txs
  console.log("");

  // 5. Blind receive
  console.log("Step 7: Blind receive on receiver");
  const receiveData = rcvWallet.blindReceive(
    null,
    '{"Fungible":100}',
    null,
    [PROXY_URL],
    "1",
  );
  console.log(`  Recipient ID: ${receiveData.recipientId}`);
  console.log(`  Invoice: ${receiveData.invoice}\n`);

  // 6. Send
  console.log("Step 8: Send asset from sender to receiver");
  const recipientMap = {
    [asset.assetId]: [
      {
        recipientId: receiveData.recipientId,
        witnessData: null,
        assignment: { Fungible: 100 },
        transportEndpoints: [PROXY_URL],
      },
    ],
  };
  // donation=true so the witness tx is broadcast immediately
  // (donation=false defers broadcast until receiver ACKs)
  const sendResult = sndWallet.send(
    sndOnline,
    recipientMap,
    true,
    "2",
    "1",
    false,
  );
  console.log(`  Send result: ${JSON.stringify(sendResult)}\n`);

  // Mine to confirm the send transaction so the validator can verify it
  console.log("Step 9: Mine and wait for auto-ACK");
  await mine(1);
  await sleep(2000);

  const ack = await waitForAck(receiveData.recipientId);
  console.log(`  ACK result: ${ack}`);
  if (ack !== true) throw new Error(`Expected ack=true, got ack=${ack}`);
  console.log("  Consignment validated and auto-ACKed!\n");

  // 7. Verify receiver got the asset
  // First refresh picks up the pending transfer, second settles it
  console.log("Step 10: Verify receiver asset balance");
  rcvWallet.refresh(rcvOnline, null, [], false);
  sndWallet.refresh(sndOnline, null, [], false);

  await mine(1);
  await sleep(2000);

  rcvWallet.refresh(rcvOnline, null, [], false);
  sndWallet.refresh(sndOnline, null, [], false);

  const rcvBalance = rcvWallet.getAssetBalance(asset.assetId);
  console.log(`  Receiver balance: ${JSON.stringify(rcvBalance)}`);
  if (Number(rcvBalance.settled) !== 100)
    throw new Error(
      `Expected settled=100, got settled=${rcvBalance.settled}`,
    );
  console.log("  Receiver has 100 ETEST tokens\n");

  // Cleanup
  console.log("Cleaning up...");
  rgblib.dropOnline(sndOnline);
  sndWallet.drop();
  rgblib.dropOnline(rcvOnline);
  rcvWallet.drop();

  console.log("\n=== ALL TESTS PASSED ===");
}

main().catch((err) => {
  console.error("\n=== TEST FAILED ===");
  console.error(err);
  process.exit(1);
});
