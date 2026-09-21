const config = window.CIRCLE_CONFIG || {}
const apiBase = String(config.apiBase || '').replace(/\/$/, '')
const byId = (id) => document.getElementById(id)
// Google redirects away and back, so the device credentials must survive the reload.
const googleDeviceKey = 'hedgora.circleGoogleDevice'
// The connected wallet is shared across pages in this tab. Circle user tokens last 60 minutes.
const sessionKey = 'hedgora.circleSession'
const sessionTtl = 55 * 60 * 1000
// Google always returns to the site origin, so remember which page started the login.
const returnKey = 'hedgora.returnTo'
let sdk
let sdkModule

function apiUrl(path) {
  return `${apiBase}${path}`
}

// The Circle Web SDK is ~1 MB, so it is only downloaded when a Circle window is actually needed.
function loadSdkModule() {
  sdkModule ||= import('@circle-fin/w3s-pw-web-sdk')
  return sdkModule
}

function setStatus(message, error = false) {
  const status = byId('circleStatus')
  if (!status) return
  status.textContent = message
  status.style.background = error ? '#fff0c9' : '#e5f7f0'
  status.style.color = error ? '#725714' : '#31655a'
}

function setOpen(open) {
  const modal = byId('circleModal')
  if (!modal) return
  if (open) renderModal()
  modal.classList.toggle('open', open)
  modal.setAttribute('aria-hidden', String(!open))
}

function formatError(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

async function postJson(path, body) {
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { message: text } }
  if (!response.ok) {
    // Keep Circle's error code so pages can show a specific, friendly message.
    throw Object.assign(new Error(data?.message || `Circle request failed (${response.status})`), { code: data?.code, status: response.status })
  }
  return data
}

function loadSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(sessionKey) || 'null')
    if (session && session.expiresAt > Date.now()) return session
    sessionStorage.removeItem(sessionKey)
  } catch {}
  return null
}

function announceWallet(session) {
  window.hedgoraWallet?.setConnected(Boolean(session), session?.address)
  const detail = session ? { address: session.address, walletId: session.walletId, blockchain: session.blockchain, expiresAt: session.expiresAt } : null
  window.dispatchEvent(new CustomEvent('hedgora:wallet', { detail }))
}

// When a wallet is connected the modal shows it with a Disconnect button instead of the login.
function renderModal() {
  const session = loadSession()
  const connected = byId('circleConnected')
  if (connected) connected.hidden = !session
  if (byId('circleConnectedAddress')) byId('circleConnectedAddress').textContent = session?.address || ''
  const login = byId('circleGoogle')?.closest('.circle-actions')
  if (login) login.hidden = Boolean(session)
  if (session) setStatus('Ví Circle đang được kết nối trong tab này.')
}

function signOut() {
  try { sessionStorage.removeItem(sessionKey) } catch {}
  announceWallet(null)
  renderModal()
  setStatus('Đã ngắt kết nối ví. Đăng nhập Google để kết nối lại.')
}

function ensureAppId() {
  if (config.appId) return true
  byId('circleSetup').hidden = false
  byId('circleGoogle').disabled = true
  setStatus('Thêm Circle App ID vào public/circle-config.js trước khi kết nối.', true)
  return false
}

async function getSdk() {
  if (!ensureAppId()) throw new Error('Circle App ID is not configured')
  if (sdk) return sdk
  const { W3SSdk } = await loadSdkModule()
  sdk = new W3SSdk({ appSettings: { appId: config.appId } }, handleGoogleLogin)
  return sdk
}

// Circle's SDK never calls back when the traveler closes its window, which left pages waiting forever.
// Treat the removal of its iframe as a cancel. On success the SDK removes the iframe and then calls back
// synchronously, so by the time this check runs the promise is already settled.
function executeChallenge(walletSdk, challengeId) {
  return new Promise((resolve, reject) => {
    let settled = false
    const observer = new MutationObserver((records) => {
      const removed = records.some((record) => [...record.removedNodes].some((node) => node.id === 'sdkIframe'))
      if (!removed) return
      setTimeout(() => {
        if (settled || document.getElementById('sdkIframe')) return
        finish(reject, Object.assign(new Error('Bạn đã đóng cửa sổ Circle. Chưa có tiền nào được gửi.'), { code: 'CANCELLED' }))
      }, 50)
    })
    function finish(settle, value) {
      if (settled) return
      settled = true
      observer.disconnect()
      settle(value)
    }
    observer.observe(document.body, { childList: true })
    walletSdk.execute(challengeId, (error, result) => (error ? finish(reject, Object.assign(new Error(formatError(error)), { code: error?.code })) : finish(resolve, result)))
  })
}

function googleLoginConfigs(device) {
  return {
    ...device,
    google: {
      clientId: config.googleClientId,
      redirectUri: config.googleRedirectUri || window.location.origin,
      selectAccountPrompt: true,
    },
  }
}

async function finishLogin(walletSdk, userToken, encryptionKey) {
  walletSdk.setAuthentication({ userToken, encryptionKey })
  const { challengeId } = await postJson('/api/user/initialize', { userToken })
  if (challengeId) {
    setStatus('Xác nhận tạo ví trong cửa sổ Circle…')
    await executeChallenge(walletSdk, challengeId)
  }
  await showWallet(userToken, encryptionKey)
}

async function connectWithGoogle() {
  if (!config.googleClientId) return setStatus('Thêm googleClientId vào public/circle-config.js trước khi đăng nhập Google.', true)
  const button = byId('circleGoogle')
  button.disabled = true
  try {
    setStatus('Đang chuẩn bị đăng nhập Google…')
    const walletSdk = await getSdk()
    const deviceId = await walletSdk.getDeviceId()
    const { deviceToken, deviceEncryptionKey } = await postJson('/api/social/token', { deviceId })
    const device = { deviceToken, deviceEncryptionKey }
    sessionStorage.setItem(googleDeviceKey, JSON.stringify(device))
    if (!['/', '/index.html'].includes(window.location.pathname)) sessionStorage.setItem(returnKey, window.location.pathname + window.location.search)
    walletSdk.updateConfigs({ appSettings: { appId: config.appId }, loginConfigs: googleLoginConfigs(device) }, handleGoogleLogin)
    // The SDK does not export its SocialLoginProvider enum; 'Google' is its value.
    await walletSdk.performLogin('Google')
  } catch (error) {
    setStatus(`Không thể đăng nhập Google: ${formatError(error)}`, true)
    button.disabled = !config.appId
  }
}

async function handleGoogleLogin(error, result) {
  if (error || !result?.userToken || !result.encryptionKey) {
    return setStatus(`Đăng nhập Google thất bại: ${formatError(error || 'Circle không trả về phiên người dùng hợp lệ.')}`, true)
  }
  try {
    await finishLogin(sdk, result.userToken, result.encryptionKey)
  } catch (walletError) {
    setStatus(`Không thể kết nối Circle Wallet: ${formatError(walletError)}`, true)
  }
}

async function resumeGoogleLogin() {
  let device = null
  try {
    device = JSON.parse(sessionStorage.getItem(googleDeviceKey) || 'null')
    sessionStorage.removeItem(googleDeviceKey)
  } catch {}
  if (!device) return
  const hash = new URLSearchParams(window.location.hash.slice(1))
  if (!hash.has('id_token') && !hash.has('error')) return
  setOpen(true)
  if (hash.has('error')) {
    history.replaceState(null, '', window.location.href.split('#')[0])
    return setStatus(`Đăng nhập Google bị hủy hoặc lỗi: ${hash.get('error')}`, true)
  }
  setStatus('Đang xác minh tài khoản Google…')
  // Constructing the SDK with the saved device credentials makes it verify the returned Google token.
  const { W3SSdk } = await loadSdkModule()
  sdk = new W3SSdk({ appSettings: { appId: config.appId }, loginConfigs: googleLoginConfigs(device) }, handleGoogleLogin)
}

async function showWallet(userToken, encryptionKey) {
  setStatus('Đang tải ví Arc Testnet…')
  // A new wallet can take a few seconds to appear after the challenge completes.
  for (let attempt = 0; attempt < 10; attempt++) {
    const { wallets = [] } = await postJson('/api/wallets/list', { userToken })
    const wallet = wallets[0]
    if (wallet) {
      const address = wallet.address || 'Circle Wallet'
      const session = { userToken, encryptionKey, walletId: wallet.id, address, blockchain: wallet.blockchain, expiresAt: Date.now() + sessionTtl }
      try { sessionStorage.setItem(sessionKey, JSON.stringify(session)) } catch {}
      announceWallet(session)
      setStatus(`Đã kết nối Circle Wallet trên ${wallet.blockchain || 'Arc Testnet'}: ${address}`)
      let returnTo = null
      try { returnTo = sessionStorage.getItem(returnKey); sessionStorage.removeItem(returnKey) } catch {}
      if (returnTo) return window.location.replace(returnTo)
      setTimeout(() => setOpen(false), 1300)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  setStatus('Circle chưa trả về địa chỉ ví. Thử lại sau ít giây.', true)
}

byId('walletBtn')?.addEventListener('click', () => {
  setOpen(true)
  if (!loadSession()) ensureAppId()
})
byId('closeCircle')?.addEventListener('click', () => setOpen(false))
byId('circleModal')?.addEventListener('click', (event) => { if (event.target.id === 'circleModal') setOpen(false) })
byId('circleGoogle')?.addEventListener('click', () => void connectWithGoogle())
byId('circleDisconnect')?.addEventListener('click', signOut)
if (config.appId) void resumeGoogleLogin()

// Used by payments.html (and the homepage wallet card) to act on the connected wallet.
window.HedgoraCircle = {
  session() {
    const session = loadSession()
    return session && { address: session.address, walletId: session.walletId, blockchain: session.blockchain, expiresAt: session.expiresAt }
  },
  connect() {
    setOpen(true)
    ensureAppId()
  },
  signOut,
  // Calls a wallet endpoint with the session's userToken and walletId filled in.
  async post(path, body = {}) {
    const session = loadSession()
    if (!session) throw Object.assign(new Error('Wallet session expired. Connect again.'), { code: 'SESSION_EXPIRED' })
    return postJson(path, { userToken: session.userToken, walletId: session.walletId, ...body })
  },
  // Opens Circle's hosted UI so the traveler approves (or rejects) the challenge.
  async approve(challengeId) {
    const session = loadSession()
    if (!session) throw Object.assign(new Error('Wallet session expired. Connect again.'), { code: 'SESSION_EXPIRED' })
    const walletSdk = await getSdk()
    walletSdk.setAuthentication({ userToken: session.userToken, encryptionKey: session.encryptionKey })
    return executeChallenge(walletSdk, challengeId)
  },
}
const restored = loadSession()
if (restored) announceWallet(restored)
