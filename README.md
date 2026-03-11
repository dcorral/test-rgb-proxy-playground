# RGB Proxy Server – Regtest Playground

Docker-based regtest environment for end-to-end testing of the RGB proxy server.

## Services

| Service    | Image / Build                          | Port  | Description                     |
|------------|----------------------------------------|-------|---------------------------------|
| bitcoind   | `hashbeam/docker/bitcoind:30.2`        | 18443 | Bitcoin Core in regtest mode    |
| electrs    | `hashbeam/docker/electrs:0.11.0`       | 50001 | Electrum server (indexer)       |
| esplora    | `./esplora/Dockerfile.notor`           | 8094  | Block explorer (Tor disabled)   |
| proxy      | `./rgb-proxy-server` (submodule)       | 3000  | RGB proxy server under test     |

## Quick start

```bash
git clone --recurse-submodules <repo-url>
./regtest.sh start           # build images, start stack (electrs indexer)
./regtest.sh e2e             # run the automated test
./regtest.sh stop            # tear everything down

# Or test with esplora indexer
./regtest.sh start esplora   # start stack with esplora indexer
./regtest.sh e2e esplora     # run the test against esplora
./regtest.sh stop
```

## Commands

| Command                      | Description                                      |
|------------------------------|--------------------------------------------------|
| `./regtest.sh start`         | Start all services with electrs (default)        |
| `./regtest.sh start esplora` | Start all services with esplora indexer          |
| `./regtest.sh rebuild`       | Stop, rebuild all images (no cache), and start   |
| `./regtest.sh rebuild esplora` | Same as above with esplora indexer             |
| `./regtest.sh stop`          | Stop and remove all containers                   |
| `./regtest.sh mine <n>`      | Mine `n` additional blocks                       |
| `./regtest.sh logs`          | Follow proxy container logs                      |
| `./regtest.sh e2e`           | Run E2E test with electrs (default)              |
| `./regtest.sh e2e esplora`   | Run E2E test with esplora indexer                |

## What the E2E test verifies

The test exercises a full RGB asset lifecycle on regtest:

1. Creates sender and receiver wallets
2. Issues an NIA asset (1000 tokens)
3. Sends 100 tokens from sender to receiver via the proxy
4. Waits for the proxy to auto-ACK the valid consignment
5. Verifies the receiver's balance updates correctly

This confirms that async consignment validation, transport relay, and auto-ACK work end-to-end.

## Manual testing

See [TESTING.md](TESTING.md) for step-by-step manual test scenarios covering auto-NACK, relay-only mode, and manual ACK guards.
