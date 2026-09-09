import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COOKIE = '610ppt_local_session';
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{32,128}$/;

export function loadOrCreateLocalApiToken(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, '.api-token');
  if (!fs.existsSync(file)) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, crypto.randomBytes(24).toString('hex'), { mode: 0o600, flag: 'wx' });
      // Publish the complete token without overwriting another launcher's token.
      try { fs.linkSync(temporary, file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('本地访问凭证必须是普通文件');
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!TOKEN_FORMAT.test(token)) throw new Error('本地访问凭证无效，请检查本地数据目录中的 .api-token');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return token;
}

function sameToken(value, token) {
  if (typeof value !== 'string' || !TOKEN_FORMAT.test(value)) return false;
  const actual = Buffer.from(value), expected = Buffer.from(token);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function cookieToken(header = '') {
  const values = String(header).split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  return values.length === 1 ? values[0].slice(COOKIE.length + 1) : '';
}

// Loopback binding alone does not reject DNS rebinding or cross-origin forms.
// This guard runs before parsers and routes on both the UI and engine servers.
export function createLocalAccessGuard({ token, bootstrapPaths = [], publicPaths = ['/api/health'] }) {
  if (!TOKEN_FORMAT.test(token)) throw new Error('Invalid local access token');
  const bootstrap = new Set(bootstrapPaths), publicRoutes = new Set(publicPaths);
  return (req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin' });
    const host = String(req.get('host') || '').toLowerCase();
    const match = host.match(/^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/);
    if (!match || Number(match[2] || 80) !== req.socket.localPort) {
      return res.status(403).json({ error: '仅允许通过本机工作台地址访问' });
    }
    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');
    if ((origin && origin !== `http://${host}`) || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
      return res.status(403).json({ error: '拒绝其他网页发起的本地工作台请求' });
    }
    req.localAuthenticated = sameToken(req.get('x-ppt-token'), token) || sameToken(cookieToken(req.get('cookie')), token);
    if (req.method === 'GET' && bootstrap.has(req.path)) {
      // Only the first-party document establishes the HttpOnly browser session.
      // Cross-site navigations/subresources were rejected above; API responses
      // never mint credentials and the token is never exposed to JavaScript.
      const destination = req.get('sec-fetch-dest');
      if (destination && destination !== 'document') return res.status(403).json({ error: '请直接打开本地工作台' });
      res.append('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
      res.set('Cache-Control', 'no-store');
    }
    if ((req.path === '/api' || req.path.startsWith('/api/')) && !req.localAuthenticated
      && !(req.method === 'GET' && publicRoutes.has(req.path))) {
      return res.status(401).json({ error: '本地访问凭证缺失或失效，请刷新工作台页面' });
    }
    next();
  };
}
