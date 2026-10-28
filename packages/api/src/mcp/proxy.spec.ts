import { lookup } from 'node:dns/promises';
import {
  getMCPDeploymentProxy,
  getMCPDeploymentProxyUrl,
  assertMCPDeploymentProxyTarget,
} from './proxy';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

const mockLookup = lookup as unknown as jest.Mock;

describe('MCP deployment proxy', () => {
  const originalProxy = process.env.MCP_PROXY;
  const originalNoProxy = process.env.MCP_NO_PROXY;

  afterEach(() => {
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
    mockLookup.mockReset();
  });

  describe('getMCPDeploymentProxy', () => {
    it('is off when MCP_PROXY is unset or blank', () => {
      delete process.env.MCP_PROXY;
      expect(getMCPDeploymentProxy()).toBeUndefined();
      process.env.MCP_PROXY = '   ';
      expect(getMCPDeploymentProxy()).toBeUndefined();
    });

    it('reads the trimmed proxy and bypass list', () => {
      process.env.MCP_PROXY = ' http://10.10.0.190:1443 ';
      process.env.MCP_NO_PROXY = ' .godarai.ir ';
      expect(getMCPDeploymentProxy()).toEqual({
        url: 'http://10.10.0.190:1443',
        noProxy: '.godarai.ir',
      });
    });
  });

  describe('getMCPDeploymentProxyUrl', () => {
    const proxy = { url: 'http://10.10.0.190:1443', noProxy: '.godarai.ir,localhost' };

    it('proxies HTTP and HTTPS targets', () => {
      expect(getMCPDeploymentProxyUrl('https://mcp.notion.com/mcp', proxy)).toBe(proxy.url);
      expect(getMCPDeploymentProxyUrl('http://mcp.example.com/mcp', proxy)).toBe(proxy.url);
    });

    it('connects directly to bypassed hosts and non-HTTP schemes', () => {
      expect(getMCPDeploymentProxyUrl('https://delpak.godarai.ir/mcp', proxy)).toBeUndefined();
      expect(getMCPDeploymentProxyUrl('http://localhost:3000/mcp', proxy)).toBeUndefined();
      expect(getMCPDeploymentProxyUrl('wss://mcp.example.com/ws', proxy)).toBeUndefined();
    });

    it('connects directly when no proxy is configured', () => {
      delete process.env.MCP_PROXY;
      expect(getMCPDeploymentProxyUrl('https://mcp.notion.com/mcp')).toBeUndefined();
    });
  });

  describe('assertMCPDeploymentProxyTarget', () => {
    it('allows a hostname that resolves only to public addresses', async () => {
      mockLookup.mockResolvedValue([{ address: '104.18.12.1', family: 4 }]);
      await expect(
        assertMCPDeploymentProxyTarget('https://mcp.notion.com/mcp'),
      ).resolves.toBeUndefined();
      expect(mockLookup).toHaveBeenCalledWith('mcp.notion.com', { all: true });
    });

    it('refuses a hostname with any private address', async () => {
      mockLookup.mockResolvedValue([
        { address: '104.18.12.1', family: 4 },
        { address: '10.10.0.5', family: 4 },
      ]);
      await expect(
        assertMCPDeploymentProxyTarget('https://rebind.example.com/mcp'),
      ).rejects.toThrow('resolved to a private/reserved address');
    });

    it('checks IP literals without a lookup', async () => {
      await expect(assertMCPDeploymentProxyTarget('http://169.254.169.254/')).rejects.toThrow(
        'private/reserved',
      );
      await expect(assertMCPDeploymentProxyTarget('http://[::1]:8080/')).rejects.toThrow(
        'private/reserved',
      );
      await expect(
        assertMCPDeploymentProxyTarget('https://104.18.12.1/mcp'),
      ).resolves.toBeUndefined();
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('allows an address the admin exempted', async () => {
      await expect(
        assertMCPDeploymentProxyTarget('http://10.10.0.50:8080/mcp', ['10.10.0.50:8080']),
      ).resolves.toBeUndefined();
    });
  });
});
