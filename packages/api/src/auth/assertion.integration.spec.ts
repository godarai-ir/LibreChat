import http from 'http';
import { ChatOpenAI } from '@langchain/openai';
import { generateKeyPairSync, verify } from 'crypto';
import type { AddressInfo } from 'net';
import type { RunLLMConfig } from '~/types';
import { getOpenAIConfig } from '~/endpoints/openai/config';
import { resolveConfigHeaders } from '~/utils/headers';
import { fetchModels } from '~/endpoints/models';

/** The real model-fetch and chat clients against a gateway that only trusts the signed assertion. */
describe('user assertion against a verifying gateway', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seen: Array<{ path: string; authorization?: string; claims?: Record<string, unknown> }> =
    [];
  let server: http.Server;
  let baseURL: string;

  function verifyBearer(authorization?: string): Record<string, unknown> | null {
    const token = authorization?.match(/^Bearer (.+)$/)?.[1];
    const [header, payload, signature] = token?.split('.') ?? [];
    if (!header || !payload || !signature) {
      return null;
    }
    const ok = verify(
      null,
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    if (!ok || claims.aud !== 'godar-gateway' || claims.exp <= now || claims.tid !== 'tenant-a') {
      return null;
    }
    return claims;
  }

  beforeAll(async () => {
    process.env.USER_ASSERTION_PRIVATE_KEY = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    process.env.USER_ASSERTION_AUDIENCE = 'godar-gateway';
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const claims = verifyBearer(req.headers.authorization);
        seen.push({
          path: req.url ?? '',
          authorization: req.headers.authorization,
          claims: claims ?? undefined,
        });
        res.setHeader('content-type', 'application/json');
        if (!claims) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ error: { message: 'invalid assertion' } }));
        }
        if (req.url?.endsWith('/models')) {
          return res.end(JSON.stringify({ data: [{ id: `models-for-${claims.sub}` }] }));
        }
        const { model } = JSON.parse(body || '{}');
        return res.end(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 0,
            model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: `hello ${claims.sub}` },
                finish_reason: 'stop',
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    delete process.env.USER_ASSERTION_PRIVATE_KEY;
    delete process.env.USER_ASSERTION_AUDIENCE;
    await new Promise((resolve) => server.close(resolve));
  });

  const headers = { Authorization: 'Bearer {{LIBRECHAT_USER_ASSERTION}}' };
  const user = { id: 'lc-1', openidId: 'idp-sub-1', tenantId: 'tenant-a' };

  it('lists models per user on the model-fetch path', async () => {
    const models = await fetchModels({
      name: 'Godar',
      apiKey: 'user-assertion',
      baseURL,
      headers,
      userObject: user,
      user: user.id,
      skipCache: true,
    });
    expect(models).toEqual(['models-for-idp-sub-1']);
  });

  it('replaces the apiKey bearer on the chat path', async () => {
    const { llmConfig, configOptions } = getOpenAIConfig('user-assertion', {
      reverseProxyUrl: baseURL,
      headers,
      streaming: false,
      modelOptions: { model: 'openai:acme-main:gpt-4o' },
    });
    const runConfig = { ...llmConfig, configuration: configOptions } as unknown as RunLLMConfig;
    resolveConfigHeaders({ llmConfig: runConfig, user, tenantId: 'tenant-a' });

    const chat = new ChatOpenAI(runConfig as ConstructorParameters<typeof ChatOpenAI>[0]);
    const reply = await chat.invoke('hi');

    expect(reply.content).toBe('hello idp-sub-1');
    const chatCall = seen.find((call) => call.path.endsWith('/chat/completions'));
    expect(chatCall?.authorization).not.toBe('Bearer user-assertion');
    expect(chatCall?.claims).toMatchObject({ sub: 'idp-sub-1', tid: 'tenant-a', uid: 'lc-1' });
  });

  it('is refused by the gateway for a user without an OpenID identity', async () => {
    const { llmConfig, configOptions } = getOpenAIConfig('user-assertion', {
      reverseProxyUrl: baseURL,
      headers,
      streaming: false,
      modelOptions: { model: 'openai:acme-main:gpt-4o' },
    });
    const runConfig = { ...llmConfig, configuration: configOptions } as unknown as RunLLMConfig;
    resolveConfigHeaders({ llmConfig: runConfig, user: { id: 'local' }, tenantId: 'tenant-a' });

    const chat = new ChatOpenAI({
      ...(runConfig as ConstructorParameters<typeof ChatOpenAI>[0]),
      maxRetries: 0,
    });
    await expect(chat.invoke('hi')).rejects.toThrow();
    expect(seen[seen.length - 1]?.authorization).toBe('Bearer user-assertion');
  });
});
