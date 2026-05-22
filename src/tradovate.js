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
  }

  async authenticate() {
    const username = process.env.TRADOVATE_USERNAME;
    const password = process.env.TRADOVATE_PASSWORD;

    if (!username || !password) {
      throw new Error('TRADOVATE_USERNAME and TRADOVATE_PASSWORD must be set in .env');
    }

    const res = await axios.post(`${this.baseUrl}/auth/accesstokenrequest`, {
      name: username,
      password: password,
      appId: 'CameronDashboard',
      appVersion: '1.0',
      cid: CID,
      sec: SECRET,
      deviceId: DEVICE_ID
    });

    const data = res.data;

    if (data['p-ticket']) {
      throw new Error('Two-factor authentication required. Please complete 2FA on your Tradovate account.');
    }

    if (!data.accessToken) {
      throw new Error(data.errorText || 'Authentication failed');
    }

    this.token = data.accessToken;
    // Tokens typically expire in 24h; refresh 1h early
    this.tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
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
