import net from 'node:net';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createHardenedOAuthFetch, resetHardenedOAuthFetchDispatchers } from './hardenedFetch';

type TestServer = {
  port: number;
  requestCount: () => number;
  close: () => Promise<void>;
};

async function createLocalServer(
  hostname = 'localhost',
  redirect?: { status: 302 | 307; target: string },
): Promise<TestServer> {
  let requestCount = 0;
  const sockets = new Set<Socket>();
  const server = http.createServer((_req, res) => {
    requestCount += 1;
    if (redirect) {
      res.writeHead(redirect.status, { Location: redirect.target });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, hostname, resolve));
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    requestCount: () => requestCount,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

describe('createHardenedOAuthFetch request policy', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createLocalServer();
  });

  afterEach(async () => {
    resetHardenedOAuthFetchDispatchers();
    await server.close();
  });

  it('blocks local OAuth requests unless the endpoint is explicitly trusted', async () => {
    const oauthFetch = createHardenedOAuthFetch();

    await expect(
      oauthFetch(`http://localhost:${server.port}/token`, {
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow();

    expect(server.requestCount()).toBe(0);
  });

  it('blocks private IP literals even when the DNS lookup is bypassed', async () => {
    const target = await createLocalServer('127.0.0.1');
    try {
      await expect(
        createHardenedOAuthFetch()(`http://127.0.0.1:${target.port}/token`),
      ).rejects.toThrow('OAuth endpoint targets a blocked address');
      expect(target.requestCount()).toBe(0);
    } finally {
      await target.close();
    }
  });

  it('permits an explicitly exempted private IP and port', async () => {
    const target = await createLocalServer('127.0.0.1');
    try {
      const response = await createHardenedOAuthFetch({
        allowedAddresses: [`127.0.0.1:${target.port}`],
      })(`http://127.0.0.1:${target.port}/token`);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(target.requestCount()).toBe(1);
    } finally {
      await target.close();
    }
  });

  it('allows explicitly trusted local OAuth endpoints', async () => {
    const oauthFetch = createHardenedOAuthFetch({ allowedDomains: ['localhost'] });

    const response = await oauthFetch(`http://localhost:${server.port}/token`, {
      signal: AbortSignal.timeout(1000),
    });

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(server.requestCount()).toBe(1);
  });

  it.each([302, 307] as const)(
    'does not follow a %i from an allowlisted OAuth endpoint to a private IP',
    async (status) => {
      const target = await createLocalServer('127.0.0.1');
      const redirector = await createLocalServer('localhost', {
        status,
        target: `http://127.0.0.1:${target.port}/internal`,
      });
      try {
        await expect(
          createHardenedOAuthFetch({ allowedDomains: ['localhost'] })(
            `http://localhost:${redirector.port}/token`,
            { method: 'POST', body: 'grant_type=refresh_token', redirect: 'follow' },
          ),
        ).rejects.toThrow();
        expect(redirector.requestCount()).toBe(1);
        expect(target.requestCount()).toBe(0);
      } finally {
        await redirector.close();
        await target.close();
      }
    },
  );

  it('does not use address exemptions when domain policy is active but unmatched', async () => {
    const oauthFetch = createHardenedOAuthFetch({
      allowedDomains: ['trusted.example.com'],
      allowedAddresses: [`localhost:${server.port}`],
    });

    await expect(
      oauthFetch(`http://localhost:${server.port}/token`, {
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow();

    expect(server.requestCount()).toBe(0);
  });
});

type ConnectProxy = {
  url: string;
  targets: string[];
  close: () => Promise<void>;
};

/** A minimal HTTP CONNECT proxy that records each tunnel target. */
async function createConnectProxy(): Promise<ConnectProxy> {
  const targets: string[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, clientSocket: Socket, head: Buffer) => {
    targets.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    for (const socket of [clientSocket, upstream]) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    targets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

describe('createHardenedOAuthFetch through MCP_PROXY', () => {
  let proxy: ConnectProxy;
  let target: TestServer;
  const originalProxy = process.env.MCP_PROXY;
  const originalNoProxy = process.env.MCP_NO_PROXY;

  beforeEach(async () => {
    proxy = await createConnectProxy();
    target = await createLocalServer('127.0.0.1');
    process.env.MCP_PROXY = proxy.url;
    delete process.env.MCP_NO_PROXY;
  });

  afterEach(async () => {
    resetHardenedOAuthFetchDispatchers();
    for (const [key, value] of [
      ['MCP_PROXY', originalProxy],
      ['MCP_NO_PROXY', originalNoProxy],
    ] as const) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await target.close();
    await proxy.close();
  });

  it('tunnels an allowed OAuth request through the proxy', async () => {
    const response = await createHardenedOAuthFetch({
      allowedAddresses: [`127.0.0.1:${target.port}`],
    })(`http://127.0.0.1:${target.port}/.well-known/oauth-authorization-server`);

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(proxy.targets).toEqual([`127.0.0.1:${target.port}`]);
    expect(target.requestCount()).toBe(1);
  });

  it('refuses a private target before contacting the proxy', async () => {
    await expect(
      createHardenedOAuthFetch()(`http://127.0.0.1:${target.port}/token`),
    ).rejects.toThrow('resolved to a private/reserved address');

    expect(proxy.targets).toEqual([]);
    expect(target.requestCount()).toBe(0);
  });

  it('connects directly to hosts listed in MCP_NO_PROXY', async () => {
    process.env.MCP_NO_PROXY = '127.0.0.1';

    const response = await createHardenedOAuthFetch({
      allowedAddresses: [`127.0.0.1:${target.port}`],
    })(`http://127.0.0.1:${target.port}/token`);

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(proxy.targets).toEqual([]);
    expect(target.requestCount()).toBe(1);
  });
});
