const axios = require('axios');
const { readFile } = require('fs/promises');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { Wallet } = require('ethers');

// ASCII Art IDOS
console.log(`
██╗██████╗  ██████╗ ███████╗
██║██╔══██╗██╔═══██╗██╔════╝
██║██║  ██║██║   ██║███████╗
██║██║  ██║██║   ██║╚════██║
██║██████╔╝╚██████╔╝███████║
╚═╝╚═════╝  ╚═════╝ ╚══════╝
   Auto Check-in Bot v1.0
================================
`);

const API_ENDPOINTS = {
  msg: 'https://app.idos.network/api/auth/message',
  verify: 'https://app.idos.network/api/auth/verify',
  quest: 'https://app.idos.network/api/user-quests/complete',
  pts: (uid) => `https://app.idos.network/api/user/${uid}/points`
};

const timer = (sec) => new Promise(r => setTimeout(r, sec * 1000));

const buildHeaders = (authToken) => {
  const base = {
    'accept': '*/*',
    'content-type': 'application/json',
    'origin': 'https://app.idos.network',
    'referer': 'https://app.idos.network/',
    'user-agent': 'Mozilla/5.0'
  };
  return authToken ? { ...base, 'authorization': `Bearer ${authToken}` } : base;
};

const createProxyAgent = (proxyStr) => {
  if (!proxyStr) return null;
  if (proxyStr.startsWith('http://') || proxyStr.startsWith('https://')) {
    return new HttpsProxyAgent(proxyStr);
  }
  if (proxyStr.startsWith('socks4://') || proxyStr.startsWith('socks5://')) {
    return new SocksProxyAgent(proxyStr);
  }
  console.log(`[!] Unsupported proxy format: ${proxyStr}`);
  return null;
};

async function loadFileLines(filename) {
  try {
    const content = await readFile(filename, 'utf-8');
    return content.split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const makeRequest = async (httpMethod, endpoint, data = null, proxyStr = null, token = null, maxRetries = 3) => {
  const cfg = {
    headers: buildHeaders(token),
    timeout: 60000
  };
  
  if (proxyStr) {
    cfg.httpsAgent = createProxyAgent(proxyStr);
    cfg.proxy = false;
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = httpMethod === 'get' 
        ? await axios.get(endpoint, cfg)
        : await axios.post(endpoint, data, cfg);
      return { ok: true, data: result.data };
    } catch (err) {
      if (attempt === maxRetries - 1) {
        return { ok: false, error: err.message };
      }
      await timer(3);
    }
  }
};

async function retrievePoints(uid, authToken, proxyStr) {
  const resp = await makeRequest('get', API_ENDPOINTS.pts(uid), null, proxyStr, authToken);
  return resp.ok ? (resp.data.totalPoints || 'N/A') : 'N/A';
}

const extractUserId = (jwtToken) => {
  try {
    const parts = jwtToken.split('.');
    const decoded = Buffer.from(parts[1], 'base64').toString();
    return JSON.parse(decoded).userId;
  } catch {
    return null;
  }
};

async function executeCheckIn(uid, authToken, proxyStr) {
  const body = { questName: 'daily_check', userId: uid };
  return await makeRequest('post', API_ENDPOINTS.quest, body, proxyStr, authToken);
}

async function authenticate(privateKey, proxyStr) {
  try {
    const w = new Wallet(privateKey);
    const addr = w.address;
    
    const msgResp = await makeRequest('post', API_ENDPOINTS.msg, {
      publicAddress: addr,
      publicKey: addr
    }, proxyStr);
    
    if (!msgResp.ok) return null;

    const { message, nonce } = msgResp.data;
    const sig = await w.signMessage(message);

    const verifyResp = await makeRequest('post', API_ENDPOINTS.verify, {
      publicAddress: addr,
      publicKey: addr,
      signature: sig,
      message,
      nonce,
      walletType: 'evm'
    }, proxyStr);

    return verifyResp.ok ? verifyResp.data.accessToken : null;
  } catch {
    return null;
  }
}

async function handleAccount(pk, idx, totalCount, proxyStr = null) {
  const w = new Wallet(pk);
  const addr = w.address;
  
  console.log(`\n╔════════════════════════════════╗`);
  console.log(`║  Account ${idx + 1}/${totalCount}`.padEnd(33) + '║');
  console.log(`╚════════════════════════════════╝`);
  console.log(`Address      : ${addr}`);

  const authToken = await authenticate(pk, proxyStr);
  if (!authToken) {
    console.log("Login        : ❌ Failed");
    return;
  }
  console.log("Login        : ✅ Success");

  const uid = extractUserId(authToken);
  if (!uid) {
    console.log("UserID       : ❌ Extract failed");
    return;
  }

  const checkInResult = await executeCheckIn(uid, authToken, proxyStr);
  if (checkInResult?.ok) {
    console.log("Check-in     : ✅ Success");
  } else if (checkInResult?.error?.includes("already")) {
    console.log("Check-in     : ⚠️  Already done today");
  } else {
    console.log("Check-in     : ❌ Failed");
  }

  const totalPts = await retrievePoints(uid, authToken, proxyStr);
  console.log(`Total Points : ${totalPts}`);
}

async function processBatch(proxyList, shouldUseProxy) {
  const keys = await loadFileLines('privatekeys.txt');
  if (keys.length === 0) {
    console.log("[!] No private keys found in privatekeys.txt");
    return;
  }

  console.log(`\n[+] Processing ${keys.length} accounts...\n`);

  for (let i = 0; i < keys.length; i++) {
    const selectedProxy = shouldUseProxy && proxyList.length 
      ? proxyList[i % proxyList.length] 
      : null;
    
    await handleAccount(keys[i], i, keys.length, selectedProxy);
    
    if (i < keys.length - 1) await timer(3);
  }
}

async function initialize() {
  const proxyList = await loadFileLines('proxy.txt');
  const enableProxy = proxyList.length > 0;

  if (enableProxy) {
    console.log(`[✓] Loaded ${proxyList.length} proxies from proxy.txt`);
  } else {
    console.log("[!] No proxy found, running without proxy...");
  }

  while (true) {
    await processBatch(proxyList, enableProxy);
    console.log("\n" + "=".repeat(40));
    console.log("All accounts processed!");
    console.log("Next cycle starts in 24 hours...");
    console.log("=".repeat(40) + "\n");
    await timer(86400);
  }
}

initialize();