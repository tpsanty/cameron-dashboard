require('dotenv').config();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const CID = 13545;
const SECRET = '0fa1fbd1-3b9f-444b-988b-8c64411fe087';
const DEVICE_ID = uuidv4();

class TradovateClient {
  constructor() {
    this.env = process.env.TRADOVATE_ENV || 'demo';
    this.baseUrl = this.env === 'live'
      ? 'https://live.tradovateapi.com/v1'
      : 'https://demo.tradovateapi.com/v1';
    this.token = null;
    this.tokenExpiry = null;
    this.contractCache = {};
    console.log(`[tradovate] env=${this.env}  endpoint=${this.baseUrl}`);
  }

  async authenticate() {
    const username = process.env.TRADOVATE_USERNAME;
    const password = process.env.TRADOVATE_PASSWORD || '';

    if (!username) {
      throw new Error('TRADOVATE_USERNAME is not set in .env');
    }

    // Google OAuth accounts (name starts with "Google:") don't use a
    // traditional Tradovate password. Cameron must go to:
    //   tradovate.com → Settings → Security → Set Password
    // and put that password in TRADOVATE_PASSWORD.
    const isGoogleAccount = username.startsWith('Google:');
    if (isGoogleAccount && !password) {
      console.warn('[auth] Google OAuth account detected with no password.');
      console.warn('[auth] Visit tradovate.com → Settings → Security → Set Password');
      console.warn('[auth] then add that password to the TRADOVATE_PASSWORD env var.');
    }

    console.log(`[auth] POST ${this.baseUrl}/auth/accesstokenrequest`);
    console.log(`[auth] name="${username}"  isGoogleAccount=${isGoogleAccount}  hasPassword=${!!password}`);

    let res;
    try {
      res = await axios.post(`${this.baseUrl}/auth/accesstokenrequest`, {
        name: username,
        password,
        appId: 'CameronDashboard',
        appVersion: '1.0',
        cid: CID,
        sec: SECRET,
        deviceId: DEVICE_ID
      });
    } catch (err) {
      // Axios throws on 4xx/5xx — extract Tradovate's error body
      const status = err.response?.status;
      const body   = err.response?.data;
      console.error(`[auth] HTTP ${status} from Tradovate:`, JSON.stringify(body));
      const msg = body?.errorText || body?.error || body?.message || err.message;
      throw new Error(`Tradovate auth failed (HTTP ${status}): ${msg}`);
    }

    const data = res.data;
    // Log full response with tokens redacted
    const redacted = { ...data, accessToken: data.accessToken ? '[redacted]' : undefined, mdAccessToken: data.mdAccessToken ? '[redacted]' : undefined };
    console.log('[auth] Response:', JSON.stringify(redacted));

    if (data['p-ticket']) {
      throw new Error('Two-factor authentication is required — complete 2FA at tradovate.com then retry.');
    }

    if (!data.accessToken) {
      console.error('[auth] No access token. Full response:', JSON.stringify(data));
      throw new Error(data.errorText || data.error || 'Authentication failed — check TRADOVATE_USERNAME / TRADOVATE_PASSWORD');
    }

    this.token = data.accessToken;
    this.tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
    console.log(`[auth] Authenticated as "${username}" (token valid 23h)`);
    return data;
  }

  async ensureToken() {
    if (!this.token || Date.now() > this.tokenExpiry) {
      await this.authenticate();
    }
  }

  async get(endpoint, params = {}) {
    await this.ensureToken();
    const res = await axios.get(`${this.baseUrl}${endpoint}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      params
    });
    return res.data;
  }

  async getAccounts() {
    return this.get('/account/list');
  }

  async getPositions() {
    return this.get('/position/list');
  }

  async getFills() {
    return this.get('/fill/list');
  }

  async getOrders() {
    return this.get('/order/list');
  }

  async getContract(contractId) {
    if (this.contractCache[contractId]) return this.contractCache[contractId];
    const res = await this.get(`/contract/item`, { id: contractId });
    this.contractCache[contractId] = res;
    return res;
  }

  async getContractBatch(ids) {
    const unique = [...new Set(ids)].filter(id => !this.contractCache[id]);
    if (unique.length > 0) {
      try {
        const items = await this.get('/contract/items', { ids: unique.join(',') });
        (Array.isArray(items) ? items : []).forEach(c => {
          this.contractCache[c.id] = c;
        });
      } catch (_) {
        // fall back to individual fetches if batch fails
      }
    }
    return this.contractCache;
  }

  async getCashBalanceSnapshot(accountId) {
    return this.get('/cashBalance/getCashBalanceSnapshot', { accountId });
  }
}

module.exports = new TradovateClient();
