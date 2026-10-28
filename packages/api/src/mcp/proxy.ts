import { isIP } from 'node:net';
import { isSSRFTarget, isAddressAllowed, resolveHostnameSSRF } from '~/auth/domain';
import { shouldBypassProxy } from '~/utils/proxy';

/**
 * The deployment's egress proxy for MCP traffic, from `MCP_PROXY` and `MCP_NO_PROXY`.
 *
 * It is process configuration, like `PROXY` and `HTTPS_PROXY`, rather than a `librechat.yaml`
 * field: it describes the deployment's network, and a tenant-scoped override could route another
 * tenant's MCP traffic through a proxy of its choosing. It applies to every MCP server, admin- and
 * user-defined, and to their OAuth requests; a server's own `proxy` still takes precedence.
 */
export interface MCPDeploymentProxy {
  url: string;
  noProxy?: string;
}

export function getMCPDeploymentProxy(): MCPDeploymentProxy | undefined {
  const url = process.env.MCP_PROXY?.trim();
  if (!url) {
    return undefined;
  }
  const noProxy = process.env.MCP_NO_PROXY?.trim();
  return noProxy ? { url, noProxy } : { url };
}

/** The proxy a request to `target` should use, or `undefined` to connect directly. */
export function getMCPDeploymentProxyUrl(
  target: string | URL,
  proxy: MCPDeploymentProxy | undefined = getMCPDeploymentProxy(),
): string | undefined {
  if (!proxy) {
    return undefined;
  }
  const url = target instanceof URL ? target : new URL(target);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return undefined;
  }
  return shouldBypassProxy(url, proxy.noProxy) ? undefined : proxy.url;
}

/**
 * SSRF check for a request the deployment proxy will forward.
 *
 * The proxy resolves the hostname itself, so the connect-time address pinning a direct request
 * gets is unavailable. Instead the hostname is resolved here and refused when any address is
 * private or reserved, the same rule a direct request is held to before it connects. A record that
 * changes between this lookup and the proxy's own is not covered; the proxy should also refuse
 * private destinations.
 */
export async function assertMCPDeploymentProxyTarget(
  target: string | URL,
  allowedAddresses?: string[] | null,
): Promise<void> {
  const url = target instanceof URL ? target : new URL(target);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'http:' ? '80' : '443');
  if (isAddressAllowed(hostname, allowedAddresses, port)) {
    return;
  }
  const blocked = isIP(hostname)
    ? isSSRFTarget(hostname, allowedAddresses, port)
    : await resolveHostnameSSRF(hostname, allowedAddresses, port);
  if (blocked) {
    throw new Error(
      `SSRF protection: proxied MCP request target "${hostname}" resolved to a private/reserved address`,
    );
  }
}
