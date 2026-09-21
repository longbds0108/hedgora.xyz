import { W3SSdk } from '@circle-fin/w3s-pw-web-sdk'

const config = window.CIRCLE_CONFIG || {}
const apiBase = String(config.apiBase || '').replace(/\/$/, '')
const byId = (id) => document.getElementById(id)
// Google redirects away and back, so the device credentials must survive the reload.
const googleDeviceKey = 'localmate.circleGoogleDevice'
let sdk

function apiUrl(path) {
  return `${apiBase}${path}`
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
  if (!response.ok) throw new Error(data?.message || `Circle request failed (${response.status})`)
  return data
}

function ensureAppId() {
  if (config.appId) return true
  byId('circleSetup').hidden = false
  byId('circleGoogle').disabled = true
  setStatus('Thêm Circle App ID vào dist/circle-config.js trước khi kết nối.', true)
  return false
}

async function getSdk() {
  if (!ensureAppId()) throw new Error('Circle App ID is not configured')
  if (sdk) return sdk
  sdk = new W3SSdk({ appSettings: { appId: config.appId } }, handleGoogleLogin)
  return sdk
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
    await new Promise((resolve, reject) => walletSdk.execute(challengeId, (error, result) => error ? reject(error) : resolve(result)))
  }
  await showWallet(userToken)
}

async function connectWithGoogle() {
  if (!config.googleClientId) return setStatus('Thêm googleClientId vào dist/circle-config.js trước khi đăng nhập Google.', true)
  const button = byId('circleGoogle')
  button.disabled = true
  try {
    setStatus('Đang chuẩn bị đăng nhập Google…')
    const walletSdk = await getSdk()
    const deviceId = await walletSdk.getDeviceId()
    const { deviceToken, deviceEncryptionKey } = await postJson('/api/social/token', { deviceId })
    const device = { deviceToken, deviceEncryptionKey }
    sessionStorage.setItem(googleDeviceKey, JSON.stringify(device))
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

function resumeGoogleLogin() {
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
  sdk = new W3SSdk({ appSettings: { appId: config.appId }, loginConfigs: googleLoginConfigs(device) }, handleGoogleLogin)
}

async function showWallet(userToken) {
  setStatus('Đang tải ví Arc Testnet…')
  // A new wallet can take a few seconds to appear after the challenge completes.
  for (let attempt = 0; attempt < 10; attempt++) {
    const { wallets = [] } = await postJson('/api/wallets/list', { userToken })
    const wallet = wallets[0]
    if (wallet) {
      const address = wallet.address || 'Circle Wallet'
      window.localMateWallet?.setConnected(true, address)
      setStatus(`Đã kết nối Circle Wallet trên ${wallet.blockchain || 'Arc Testnet'}: ${address}`)
      setTimeout(() => setOpen(false), 1300)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  setStatus('Circle chưa trả về địa chỉ ví. Thử lại sau ít giây.', true)
}

byId('walletBtn')?.addEventListener('click', () => {
  setOpen(true)
  ensureAppId()
})
byId('closeCircle')?.addEventListener('click', () => setOpen(false))
byId('circleModal')?.addEventListener('click', (event) => { if (event.target.id === 'circleModal') setOpen(false) })
byId('circleGoogle')?.addEventListener('click', () => void connectWithGoogle())
if (config.appId) resumeGoogleLogin()
