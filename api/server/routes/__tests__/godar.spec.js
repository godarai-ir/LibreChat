const http = require('http');
const express = require('express');
const request = require('supertest');
const { generateKeyPairSync, verify } = require('crypto');

let mockAppConfig;

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(async () => mockAppConfig),
}));

describe('Godar seat routes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const calls = [];
  let gateway;
  let baseURL;
  let app;
  let currentUser;

  function claimsOf(authorization) {
    const [header, payload, signature] = (authorization ?? '').replace(/^Bearer /, '').split('.');
    if (!signature) {
      return null;
    }
    const ok = verify(
      null,
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
    return ok ? JSON.parse(Buffer.from(payload, 'base64url').toString()) : null;
  }

  beforeAll(async () => {
    process.env.USER_ASSERTION_PRIVATE_KEY = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    process.env.USER_ASSERTION_AUDIENCE = 'godar-gateway';

    gateway = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const claims = claimsOf(req.headers.authorization);
        calls.push({ path: req.url, method: req.method, claims, body });
        res.setHeader('content-type', 'application/json');
        if (!claims) {
          res.statusCode = 401;
          return res.end('{}');
        }
        if (req.url === '/v1/budget/me') {
          return res.end(JSON.stringify({ seat: { type: 'pro', enabled: true } }));
        }
        res.statusCode = 201;
        return res.end(JSON.stringify({ status: 'pending' }));
      });
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${gateway.address().port}/v1`;

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = currentUser;
      next();
    });
    app.use('/api/godar', require('../godar'));
  });

  afterAll(async () => {
    delete process.env.USER_ASSERTION_PRIVATE_KEY;
    delete process.env.USER_ASSERTION_AUDIENCE;
    await new Promise((resolve) => gateway.close(resolve));
  });

  beforeEach(() => {
    calls.length = 0;
    currentUser = { id: 'lc-1', openidId: 'idp-sub-1', tenantId: 'tenant-a', provider: 'openid' };
    mockAppConfig = {
      endpoints: {
        custom: [
          {
            name: 'Godar',
            baseURL,
            headers: { Authorization: 'Bearer {{LIBRECHAT_USER_ASSERTION}}' },
          },
        ],
      },
    };
  });

  it('asks the gateway for the seat with the signed assertion', async () => {
    const response = await request(app).get('/api/godar/seat');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ type: 'pro', enabled: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].claims).toMatchObject({
      aud: 'godar-gateway',
      sub: 'idp-sub-1',
      tid: 'tenant-a',
      uid: 'lc-1',
    });
  });

  it('forwards a seat request as the member', async () => {
    const response = await request(app)
      .post('/api/godar/seat-requests')
      .send({ seat: 'Max', reason: 'more credits', block_reason: 'pool_exhausted' });

    expect(response.status).toBe(201);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].claims.sub).toBe('idp-sub-1');
    expect(JSON.parse(calls[0].body)).toEqual({
      seat: 'max',
      reason: 'more credits',
      block_reason: 'pool_exhausted',
    });
  });

  it('refuses without calling the gateway when no credential resolves', async () => {
    currentUser = { id: 'local-1', tenantId: 'tenant-a', provider: 'local' };

    const response = await request(app).get('/api/godar/seat');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: { code: 'godar_auth_unavailable' } });
    expect(calls).toHaveLength(0);
  });

  it('answers 204 when the tenant has no Godar endpoint', async () => {
    mockAppConfig = { endpoints: { custom: [] } };

    const response = await request(app).get('/api/godar/seat');

    expect(response.status).toBe(204);
    expect(calls).toHaveLength(0);
  });
});
