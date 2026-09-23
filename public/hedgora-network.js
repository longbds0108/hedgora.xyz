// Which Arc network Hedgora runs on is decided by the server (CIRCLE_BLOCKCHAIN, reported by /api/health).
// The pages are written for Arc mainnet, where USDC is real money; this switches their wording, their explorer
// links and their testnet-only parts (the faucet) back when the server is on the test network.
;(() => {
  const apiBase = String(window.CIRCLE_CONFIG?.apiBase || '').replace(/\/$/, '')
  const MAINNET = { blockchain: 'ARC', name: 'Arc', testnet: false, explorer: 'https://explorer.arc.io' }
  window.HedgoraNetwork = MAINNET
  document.documentElement.dataset.network = 'mainnet'

  function apply(net) {
    window.HedgoraNetwork = net
    document.documentElement.dataset.network = net.testnet ? 'testnet' : 'mainnet'
    document.querySelectorAll('[data-net-name]').forEach((el) => { el.textContent = net.name })
    // data-net-explorer holds the path after the explorer's address, e.g. "" or "/tx".
    document.querySelectorAll('[data-net-explorer]').forEach((el) => { el.href = net.explorer + el.dataset.netExplorer })
    window.dispatchEvent(new CustomEvent('hedgora:network', { detail: net }))
  }

  fetch(apiBase + '/api/health')
    .then((r) => r.json())
    .then((health) => { if (health?.network?.name && health.network.testnet !== MAINNET.testnet) apply(health.network) })
    .catch(() => {})
})()
