require('dotenv').config();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const CID       = 13545;
const SECRET    = '0fa1fbd1-3b9f-444b-988b-8c64411fe087';
const DEVICE_ID = uuidv4();

// Refresh this many ms before the actual expiry so we never send a stale token
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

class TradovateClient {
  constructor() {
    this.env     = process.env.TRADOVATE_ENV || 'demo';
    this.baseUrl = this.env === 'live'
      ? 'https://live.tradovateapi.com/v1'
      : 'https://demo.tradovateapi.com/v1';
    this.token         = null;
    this.tokenExpiry   = null;
    this._authPromise  = null; // deduplicates concurrent auth attempts
    this._refreshTimer = null;
    this.contractCache = {};
    console.log(`[tradovate] env=${this.env}  endpoint=${this.baseUrl}`);
  }

  async authenticate() {
    const username = process.env.TRADOVATE_USERNAME;
    const password = process.env.TRADOVATE_PASSWORD || '';

    if (!username) {
      throw new Error('TRADOVATE_USERNAME is not set in .env');
    }

    const isGoogleAccount = username.startsWith('Google:');
    if (isGoogleAccount && !password) {
      console.warn('[auth] Google OAuth account detected with no password.');
      console.warn('[auth] Visit tradovate.com → Settings → Security → Set Password');
      console.warn('[auth] then add that password to the TRADOVATE_PASSWORD env var.');
    }

    console.log(`[auth] POST ${this.baseUrl}/auth/accesstokenrequest`);

    let res;
    try {
      res = await axios.post(`${this.baseUrl}/auth/accesstokenrequest`, {
        name:       username,
        password,
        appId:      'CameronDashboard',
        appVersion: '1.0',
        cid:        CID,
        sec:        SECRET,
        deviceId:   DEVICE_ID
      });
    } catch (err) {
      const status = err.response?.status;
      const body   = err.response?.data;
      console.error(`[auth] HTTP ${status} from Tradovate:`, JSON.stringify(body));
      const msg = body?.errorText || body?.error || body?.message || err.message;
      throw new Error(`Tradovate auth failed (HTTP ${status}): ${msg}`);
    }

    const data = res.data;
    const redacted = {
      ...data,
      accessToken:   data.accessToken   ? '[redacted]' : undefined,
      mdAccessToken: data.mdAccessToken ? '[redacted]' : undefined
    };
    console.log('[auth] Response:', JSON.stringify(redacted));

    if (data['p-ticket']) {
      throw new Error('Two-factor authentication is required — complete 2FA at tradovate.com then retry.');
    }

    if (!data.accessToken) {
      console.error('[auth] No access token. Full response:', JSON.stringify(data));
      throw new Error(data.errorText || data.error || 'Authentication failed — check TRADOVATE_USERNAME / TRADOVATE_PASSWORD');
    }

    this.token = data.accessToken;

    // Use the real expirationTime from the response if present; otherwise fall
    // back to 80 minutes (conservative default for Tradovate demo tokens).
    if (data.expirationTime) {
      this.tokenExpiry = new Date(data.expirationTime).getTime() - EXPIRY_BUFFER_MS;
    } else {
      this.tokenExpiry = Date.now() + 80 * 60 * 1000 - EXPIRY_BUFFER_MS;
    }

    console.log(`[auth] Token acquired, expires ~${new Date(this.tokenExpiry).toISOString()}`);
    this._scheduleProactiveRefresh();
    return data;
  }

  // Fires a background re-auth 1 minute before we consider the token stale,
  // so the very next API call never has to wait for an auth round-trip.
  _scheduleProactiveRefresh() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    const delay = this.tokenExpiry - Date.now() - 60_000; // 1 min before buffer hits
    if (delay <= 0) return;
    this._refreshTimer = setTimeout(() => {
      console.log('[auth] Proactive token refresh...');
      this._authPromise = this.authenticate().finally(() => { this._authPromise = null; });
      this._authPromise.catch(err => console.error('[auth] Proactive refresh failed:', err.message));
    }, delay);
    // Don't keep the process alive just for this timer
    if (this._refreshTimer.unref) this._refreshTimer.unref();
  }

  // Single-flight: if authentication is already in progress, all callers
  // wait on the same promise instead of triggering multiple auth requests.
  async ensureToken() {
    if (this.token && Date.now() < this.tokenExpiry) return; // still valid

    if (!this._authPromise) {
      this._authPromise = this.authenticate().finally(() => { this._authPromise = null; });
    }
    return this._authPromise;
  }

  // Clears the cached token so the next ensureToken() call re-authenticates.
  _invalidateToken() {
    this.token       = null;
    this.tokenExpiry = null;
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
  }

  async get(endpoint, params = {}) {
    await this.ensureToken();

    try {
      const res = await axios.get(`${this.baseUrl}${endpoint}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        params
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 401) {
        // Token was rejected server-side — re-auth once and retry.
        console.warn(`[auth] 401 on ${endpoint} — re-authenticating…`);
        this._invalidateToken();
        await this.ensureToken();
        const retry = await axios.get(`${this.baseUrl}${endpoint}`, {
          headers: { Authorization: `Bearer ${this.token}` },
          params
        });
        return retry.data;
      }
      throw err;
    }
  }

  async getAccounts()                { return this.get('/account/list'); }
  async getPositions()               { return this.get('/position/list'); }
  async getFills()                   { return this.get('/fill/list'); }
  async getFillsByAccount(accountId) { return this.get('/fill/ldeps', { masterid: accountId }); }
  async getOrders()                  { return this.get('/order/list'); }

  async getContract(contractId) {
    if (this.contractCache[contractId]) return this.contractCache[contractId];
    const res = await this.get('/contract/item', { id: contractId });
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
