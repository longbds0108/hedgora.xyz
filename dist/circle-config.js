window.CIRCLE_CONFIG = {
  // Public App ID from Circle Console → Wallets → User Controlled → Configurator.
  appId: '2ec119fc-7953-5335-8d33-b8a1519c6435',
  // Public OAuth Client ID from Google Cloud Console. Its redirect URI must match googleRedirectUri
  // (defaults to the page origin, e.g. http://localhost:5173).
  googleClientId: '761581395064-sugblt73r6mtp4q16vb8n6hselckopdb.apps.googleusercontent.com',
  // The API key must stay in circle-server.mjs/.env, never in this file.
  apiBase: 'http://localhost:8787',
};
