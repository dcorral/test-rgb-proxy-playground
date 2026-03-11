#!/bin/bash
set -e

CWD=$(dirname "${0}")

_die() {
    echo "ERR: $*" >&2
    exit 1
}

COMPOSE="docker compose"
if ! $COMPOSE version >/dev/null 2>&1; then
    _die "could not call docker compose (hint: install docker compose plugin)"
fi

COMPOSE_FPATH="${CWD}/docker-compose.yaml"
COMPOSE="$COMPOSE -f ${COMPOSE_FPATH}"
TIMEOUT=120

BCLI="$COMPOSE exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password"
BCLI_ESPLORA="$COMPOSE exec -T esplora cli"

_help() {
    echo "Usage: $0 <command>"
    echo
    echo "  start    start services, wait for readiness, create wallet, mine 111 blocks"
    echo "  stop     tear down services"
    echo "  mine <n> mine n blocks"
    echo "  logs     show proxy logs"
    echo "  e2e      run E2E RGB transfer test"
    exit 0
}

_wait_for_bitcoind() {
    echo "Waiting for bitcoind..."
    start_time=$(date +%s)
    until $COMPOSE logs bitcoind 2>&1 | grep -q 'Bound to'; do
        current_time=$(date +%s)
        if [ $((current_time - start_time)) -gt $TIMEOUT ]; then
            echo "Timeout waiting for bitcoind"
            $COMPOSE logs bitcoind
            exit 1
        fi
        sleep 1
    done
    echo "bitcoind is ready"
}

_wait_for_electrs() {
    echo "Waiting for electrs..."
    start_time=$(date +%s)
    until $COMPOSE logs electrs 2>&1 | grep -q 'finished full compaction'; do
        current_time=$(date +%s)
        if [ $((current_time - start_time)) -gt $TIMEOUT ]; then
            echo "Timeout waiting for electrs"
            $COMPOSE logs electrs
            exit 1
        fi
        sleep 1
    done
    echo "electrs is ready"
}

_wait_for_esplora() {
    echo "Waiting for esplora..."
    start_time=$(date +%s)
    until $COMPOSE logs esplora 2>&1 | grep -q 'run: nginx:'; do
        current_time=$(date +%s)
        if [ $((current_time - start_time)) -gt $TIMEOUT ]; then
            echo "Timeout waiting for esplora"
            $COMPOSE logs esplora
            exit 1
        fi
        sleep 1
    done
    echo "esplora is ready"
}

_wait_for_proxy() {
    echo "Waiting for proxy..."
    start_time=$(date +%s)
    until $COMPOSE logs proxy 2>&1 | grep -q 'App is running at http://localhost:3000'; do
        current_time=$(date +%s)
        if [ $((current_time - start_time)) -gt $TIMEOUT ]; then
            echo "Timeout waiting for proxy"
            $COMPOSE logs proxy
            exit 1
        fi
        sleep 1
    done
    echo "proxy is ready"
}

start() {
    # check ports are free
    for port in 3000 50001 8094; do
        if [ -n "$(ss -HOlnt "sport = :$port" 2>/dev/null)" ]; then
            _die "port $port is already bound, services can't be started"
        fi
    done

    $COMPOSE up -d --build

    _wait_for_bitcoind

    echo "Creating wallets and mining 111 blocks..."
    $BCLI createwallet miner
    $BCLI_ESPLORA createwallet miner
    # peer the two bitcoind instances
    $BCLI addnode "esplora:18444" "add"
    $BCLI_ESPLORA addnode "bitcoind:18444" "add"
    $BCLI -rpcwallet=miner -generate 111 >/dev/null

    _wait_for_electrs
    _wait_for_esplora
    _wait_for_proxy
    echo "All services are ready!"
}

stop() {
    $COMPOSE down -v --remove-orphans
    echo "Services stopped"
}

mine() {
    [ -n "$1" ] || _die "number of blocks is required"
    $BCLI -rpcwallet=miner -generate "$1"
}

logs() {
    $COMPOSE logs -f proxy
}

e2e() {
    $COMPOSE run --rm e2e
}

case "${1:-}" in
    -h|--help|"")
        _help
        ;;
    start|stop|mine|logs|e2e)
        "$@"
        ;;
    *)
        _die "unknown command \"$1\""
        ;;
esac
