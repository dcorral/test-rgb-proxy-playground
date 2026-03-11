# Offline Receiver Consignment Validation — Manual Testing Guide

This playground tests the proxy server's async consignment validation feature
using a regtest bitcoind + electrs + proxy stack.

## 1. Start the environment

```bash
cd playground
./regtest.sh start
```

This builds the proxy image, starts all three services, creates a bitcoind
wallet, and mines 111 blocks. Wait for "All services are ready!" before
continuing.

## 2. Verify proxy is up

```bash
curl -s -X POST http://localhost:3000/json-rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server.info","params":null}' | jq .
```

Expected:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocol_version": "0.2",
    "version": "0.3.0",
    "uptime": ...
  }
}
```

## 3. Test 1: Fake consignment — auto-NACK or error fallback

Post a fake file as a consignment. Since it's not a real RGB consignment,
`validateConsignment()` will either return `{valid: false}` (auto-NACK) or
throw an error (ack stays null). Both outcomes confirm async validation is
running.

```bash
# Create a fake consignment file
echo "not-a-real-consignment" > /tmp/fake_consignment.rgbc

# Post it
curl -s -X POST http://localhost:3000/json-rpc \
  -F 'jsonrpc=2.0' \
  -F 'id=1' \
  -F 'method=consignment.post' \
  -F 'params={"recipient_id":"recipient_test_1","txid":"0000000000000000000000000000000000000000000000000000000000000001"}' \
  -F 'file=@/tmp/fake_consignment.rgbc' | jq .
```

Expected — consignment accepted:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": true
}
```

Wait a moment for async validation, then check the ack:

```bash
curl -s -X POST http://localhost:3000/json-rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ack.get","params":{"recipient_id":"recipient_test_1"}}' | jq .
```

Expected — one of:

- `"result": false` — validation returned `{valid: false}`, auto-NACKed
- `"result": null` — validation threw an error, ack left as null (relay-only fallback)

Either outcome means the async validation path executed.

## 4. Test 2: Check proxy logs

```bash
./regtest.sh logs
```

Look for log lines like:

- `Consignment validation for recipient_test_1: valid=false` (auto-NACK case)
- `Consignment validation error for recipient_test_1: ...` (error fallback case)

Press `Ctrl+C` to stop following logs.

## 5. Test 3: Manual ACK flow — verify AND ack IS NULL guard

Post another consignment, then manually ACK it before async validation runs.
This verifies the `AND ack IS NULL` guard prevents the async validator from
overwriting a manual ACK.

```bash
# Create another fake consignment (different content so hash differs)
echo "another-fake-consignment" > /tmp/fake_consignment_2.rgbc

# Post it
curl -s -X POST http://localhost:3000/json-rpc \
  -F 'jsonrpc=2.0' \
  -F 'id=1' \
  -F 'method=consignment.post' \
  -F 'params={"recipient_id":"recipient_test_2","txid":"0000000000000000000000000000000000000000000000000000000000000002"}' \
  -F 'file=@/tmp/fake_consignment_2.rgbc' | jq .
```

Immediately ACK it manually:

```bash
curl -s -X POST http://localhost:3000/json-rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ack.post","params":{"recipient_id":"recipient_test_2","ack":true}}' | jq .
```

Expected:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": true
}
```

Wait a moment, then verify the manual ACK was preserved (not overwritten):

```bash
curl -s -X POST http://localhost:3000/json-rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ack.get","params":{"recipient_id":"recipient_test_2"}}' | jq .
```

Expected — manual ACK preserved:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": true
}
```

## 6. Test 4: No INDEXER_URL — relay-only mode

Restart the proxy without `INDEXER_URL` to verify it falls back to relay-only
mode (no auto-validation).

```bash
# Stop just the proxy
docker compose -f docker-compose.yaml stop proxy

# Restart without INDEXER_URL
docker compose -f docker-compose.yaml run -d --name proxy-no-indexer \
  -e INDEXER_URL= \
  -e BITCOIN_NETWORK=regtest \
  -p 3000:3000 \
  proxy

# Wait for it to start
sleep 5

# Create yet another fake consignment
echo "third-fake-consignment" > /tmp/fake_consignment_3.rgbc

# Post it
curl -s -X POST http://localhost:3000/json-rpc \
  -F 'jsonrpc=2.0' \
  -F 'id=1' \
  -F 'method=consignment.post' \
  -F 'params={"recipient_id":"recipient_test_3","txid":"0000000000000000000000000000000000000000000000000000000000000003"}' \
  -F 'file=@/tmp/fake_consignment_3.rgbc' | jq .
```

Wait a moment, then check ack:

```bash
curl -s -X POST http://localhost:3000/json-rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ack.get","params":{"recipient_id":"recipient_test_3"}}' | jq .
```

Expected — ack stays null (no auto-validation):

```json
{
  "jsonrpc": "2.0",
  "id": 1
}
```

(No `result` field, or `"result": null` — the consignment is waiting for a
manual ACK from the receiver.)

Clean up the temporary container:

```bash
docker stop proxy-no-indexer && docker rm proxy-no-indexer
```

## 7. Cleanup

```bash
./regtest.sh stop
rm -f /tmp/fake_consignment*.rgbc
```

## 8. Automated E2E test

An automated E2E test creates real RGB wallets, issues an asset, transfers it
through the proxy, and verifies the proxy's async `validateConsignment()`
auto-ACKs the consignment with `valid=true`.

```bash
./regtest.sh e2e
```

The test runs in a Docker container (Node 20) and exercises:

1. Sender wallet creation, funding, and NIA asset issuance
2. Receiver wallet creation and funding
3. Blind receive + send through the proxy transport endpoint
4. Proxy auto-validates the real consignment and sets `ack=true`
5. Receiver refreshes and confirms the asset balance

Expected output ends with `=== ALL TESTS PASSED ===` and exit code 0.

## Notes

- Fake consignments will fail validation — this is expected and useful for
  testing the error/NACK paths.
- The automated E2E test (section 8) uses real RGB wallets for a true positive
  validation path.
- The proxy Dockerfile uses Node 20 where `@utexo/rgb-lib-linux-x64` compiles
  successfully (unlike local Node 24).
