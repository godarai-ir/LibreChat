import { extractEnvVariable } from 'librechat-data-provider';

/** Placeholder an operator writes in a custom endpoint's `baseURL` to address the caller's tenant. */
export const SLUG_PLACEHOLDER = '{slug}';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The placeholder may only stand for the whole first label of an http(s) host, once. */
const TEMPLATE_PATTERN = /^https?:\/\/\{slug\}(?:\.[a-z0-9-]+)+(?::\d{1,5})?(?:\/\S*)?$/i;

interface UrlEndpoint {
  name?: string;
  baseURL?: string;
}

/** `baseURL` with environment variables expanded, as every reader of it sees the value. */
const expand = (baseURL: string | undefined): string => extractEnvVariable(baseURL ?? '');

export function hasSlugPlaceholder(endpoint: UrlEndpoint): boolean {
  return expand(endpoint.baseURL).includes(SLUG_PLACEHOLDER);
}

const placeholderLists = new WeakMap<object, boolean>();

/** Whether any endpoint of the list carries `{slug}`; memoized per list because config is immutable. */
export function listHasSlugPlaceholder(endpoints: UrlEndpoint[] | undefined): boolean {
  if (!endpoints) {
    return false;
  }
  let found = placeholderLists.get(endpoints);
  if (found === undefined) {
    found = endpoints.some(hasSlugPlaceholder);
    placeholderLists.set(endpoints, found);
  }
  return found;
}

export function isValidSlugTemplate(template: string): boolean {
  return TEMPLATE_PATTERN.test(template) && template.split(SLUG_PLACEHOLDER).length === 2;
}

export type SlugResolution<T> = { endpoints: T[]; rejected: string[] };

/**
 * Gives each endpoint whose `baseURL` carries `{slug}` the tenant's own address. Endpoints that
 * cannot be resolved are dropped rather than left with a literal placeholder: no tenant slug
 * (single-tenant mode or an unknown tenant), a slug that is not a plain DNS label, or a template
 * that lets the placeholder be anything other than the first host label.
 *
 * Returns the input array when nothing changes, so callers can keep reference equality.
 */
export function resolveSlugTemplates<T extends UrlEndpoint>(
  endpoints: T[] | undefined,
  slug: string | undefined | null,
): SlugResolution<T> | undefined {
  if (!endpoints || !listHasSlugPlaceholder(endpoints)) {
    return undefined;
  }

  const validSlug = typeof slug === 'string' && SLUG_PATTERN.test(slug) ? slug : null;
  const rejected: string[] = [];
  const resolved: T[] = [];

  for (const endpoint of endpoints) {
    if (!hasSlugPlaceholder(endpoint)) {
      resolved.push(endpoint);
      continue;
    }
    const template = expand(endpoint.baseURL);
    if (validSlug == null || !isValidSlugTemplate(template)) {
      rejected.push(endpoint.name ?? '');
      continue;
    }
    resolved.push({ ...endpoint, baseURL: template.replace(SLUG_PLACEHOLDER, validSlug) });
  }

  return { endpoints: resolved, rejected };
}
