import { hasSlugPlaceholder, isValidSlugTemplate, resolveSlugTemplates } from './slug';

const gateway = (baseURL: string, name = 'Godar') => ({ name, baseURL, apiKey: 'user_provided' });

describe('isValidSlugTemplate', () => {
  it.each([
    'https://{slug}.godarai.ir/v1',
    'https://{slug}.localhost/v1',
    'http://{slug}.localhost:8080',
    'https://{slug}.api.godarai.ir',
  ])('accepts %s', (template) => {
    expect(isValidSlugTemplate(template)).toBe(true);
  });

  it.each([
    'https://godarai.ir/{slug}/v1',
    'https://api.{slug}.godarai.ir/v1',
    'https://x{slug}.godarai.ir',
    'https://{slug}',
    'https://{slug}.godarai.ir/{slug}',
    'https://evil.example/@{slug}.godarai.ir',
    'ftp://{slug}.godarai.ir',
    'https://user@{slug}.godarai.ir',
  ])('rejects %s', (template) => {
    expect(isValidSlugTemplate(template)).toBe(false);
  });
});

describe('resolveSlugTemplates', () => {
  it('returns undefined when no endpoint carries the placeholder', () => {
    const endpoints = [gateway('https://static.example/v1')];
    expect(resolveSlugTemplates(endpoints, 'tenant1')).toBeUndefined();
  });

  it('puts the slug into the first host label and leaves other endpoints alone', () => {
    const plain = gateway('https://static.example/v1', 'Plain');
    const result = resolveSlugTemplates(
      [plain, gateway('https://{slug}.godarai.ir/v1')],
      'tenant1',
    );
    expect(result?.rejected).toEqual([]);
    expect(result?.endpoints[0]).toBe(plain);
    expect(result?.endpoints[1].baseURL).toBe('https://tenant1.godarai.ir/v1');
  });

  it('does not mutate the configured endpoint', () => {
    const endpoint = gateway('https://{slug}.godarai.ir/v1');
    resolveSlugTemplates([endpoint], 'tenant1');
    expect(endpoint.baseURL).toBe('https://{slug}.godarai.ir/v1');
  });

  it('expands an environment variable before looking for the placeholder', () => {
    process.env.TEST_GODAR_GATEWAY = 'https://{slug}.godarai.ir/v1';
    try {
      const endpoint = gateway('${TEST_GODAR_GATEWAY}');
      expect(hasSlugPlaceholder(endpoint)).toBe(true);
      const result = resolveSlugTemplates([endpoint], 'tenant2');
      expect(result?.endpoints[0].baseURL).toBe('https://tenant2.godarai.ir/v1');
    } finally {
      delete process.env.TEST_GODAR_GATEWAY;
    }
  });

  it.each([undefined, null, '', 'Tenant1', 'a.b', 'a/b', '-x', 'x'.repeat(64), 'xx@evil.com'])(
    'drops the endpoint instead of guessing when the slug is %p',
    (slug) => {
      const result = resolveSlugTemplates([gateway('https://{slug}.godarai.ir/v1')], slug);
      expect(result).toEqual({ endpoints: [], rejected: ['Godar'] });
    },
  );

  it('drops an endpoint whose template would let the slug be anything but the first label', () => {
    const result = resolveSlugTemplates(
      [gateway('https://evil.example/{slug}', 'Bad'), gateway('https://{slug}.godarai.ir/v1')],
      'tenant1',
    );
    expect(result?.rejected).toEqual(['Bad']);
    expect(result?.endpoints.map((endpoint) => endpoint.baseURL)).toEqual([
      'https://tenant1.godarai.ir/v1',
    ]);
  });
});
