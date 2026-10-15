import { parseFqn, buildFqnIndex, groupFqnModels } from '../fqn';

const labelsOf = (ids: string[]) => Object.fromEntries(buildFqnIndex(ids).labels);

describe('parseFqn', () => {
  it('splits exactly three non-empty parts', () => {
    expect(parseFqn('openai:acme-main:gpt-4o')).toEqual({
      provider: 'openai',
      account: 'acme-main',
      model: 'gpt-4o',
    });
  });

  it.each([
    ['gpt-4o'],
    [''],
    ['openai:gpt-4o'],
    ['openai:acme:gpt:4o'],
    [':acme:gpt-4o'],
    ['openai::gpt-4o'],
    ['openai:acme:'],
    ['openai: :gpt-4o'],
    ['::'],
    ['meta-llama/Llama-3-70b'],
  ])('rejects %p', (id) => {
    expect(parseFqn(id)).toBeNull();
  });
});

describe('buildFqnIndex labels', () => {
  it('shows the bare model name when one account serves it', () => {
    expect(labelsOf(['openai:acme-main:gpt-4o', 'anthropic:team-b:claude-sonnet-4'])).toEqual({
      'openai:acme-main:gpt-4o': 'gpt-4o',
      'anthropic:team-b:claude-sonnet-4': 'claude-sonnet-4',
    });
  });

  it('adds the account to every item when a provider has several accounts for one model', () => {
    expect(
      labelsOf([
        'openai:acme-main:gpt-4o',
        'openai:acme-backup:gpt-4o',
        'openai:acme-main:gpt-4o-mini',
      ]),
    ).toEqual({
      'openai:acme-main:gpt-4o': 'gpt-4o (acme-main)',
      'openai:acme-backup:gpt-4o': 'gpt-4o (acme-backup)',
      'openai:acme-main:gpt-4o-mini': 'gpt-4o-mini',
    });
  });

  it('does not qualify a model that two different providers both serve', () => {
    expect(labelsOf(['openai:acme:shared-model', 'anthropic:acme:shared-model'])).toEqual({
      'openai:acme:shared-model': 'shared-model',
      'anthropic:acme:shared-model': 'shared-model',
    });
  });

  it('counts duplicate ids once, so a repeated id is not mistaken for a second account', () => {
    const index = buildFqnIndex(['openai:acme:gpt-4o', 'openai:acme:gpt-4o']);
    expect(index.labels.get('openai:acme:gpt-4o')).toBe('gpt-4o');
    expect(index.groups).toEqual([{ provider: 'openai', models: ['openai:acme:gpt-4o'] }]);
  });

  it('labels an invalid id with itself', () => {
    expect(labelsOf(['gpt-4o', 'a:b'])).toEqual({ 'gpt-4o': 'gpt-4o', 'a:b': 'a:b' });
  });
});

describe('buildFqnIndex groups', () => {
  const ids = [
    'openai:zeta:gpt-4o',
    'plain-model',
    'anthropic:team-b:claude-sonnet-4',
    'openai:acme:gpt-4o',
    'openai:acme:gpt-3',
    'bad:format',
    'anthropic:team-a:claude-sonnet-4',
  ];

  it('orders providers, then model name, then account, with unparsed ids last', () => {
    expect(buildFqnIndex(ids).groups).toEqual([
      {
        provider: 'anthropic',
        models: ['anthropic:team-a:claude-sonnet-4', 'anthropic:team-b:claude-sonnet-4'],
      },
      {
        provider: 'openai',
        models: ['openai:acme:gpt-3', 'openai:acme:gpt-4o', 'openai:zeta:gpt-4o'],
      },
      { provider: null, models: ['bad:format', 'plain-model'] },
    ]);
  });

  it('is independent of input order', () => {
    expect(buildFqnIndex([...ids].reverse()).groups).toEqual(buildFqnIndex(ids).groups);
  });

  it('sorts digits numerically and ignores case differences in the primary order', () => {
    const groups = buildFqnIndex(['p:a:m10', 'p:a:m2', 'p:a:M1']).groups;
    expect(groups[0].models).toEqual(['p:a:M1', 'p:a:m2', 'p:a:m10']);
  });

  it('omits the other group when every id parses', () => {
    expect(buildFqnIndex(['a:b:c']).groups.map((group) => group.provider)).toEqual(['a']);
  });

  it('handles an empty list', () => {
    expect(buildFqnIndex([])).toEqual({ labels: new Map(), groups: [] });
  });
});

describe('groupFqnModels', () => {
  const index = buildFqnIndex([
    'openai:acme-main:gpt-4o',
    'openai:acme-backup:gpt-4o',
    'anthropic:team-b:claude-sonnet-4',
    'raw',
  ]);

  it('keeps index order and drops groups with no matches', () => {
    expect(groupFqnModels(index, ['raw', 'openai:acme-main:gpt-4o'])).toEqual([
      { provider: 'openai', models: ['openai:acme-main:gpt-4o'] },
      { provider: null, models: ['raw'] },
    ]);
  });

  it('keeps labels computed from the full list when the view is filtered', () => {
    groupFqnModels(index, ['openai:acme-main:gpt-4o']);
    expect(index.labels.get('openai:acme-main:gpt-4o')).toBe('gpt-4o (acme-main)');
  });

  it('returns nothing for no ids', () => {
    expect(groupFqnModels(index, [])).toEqual([]);
  });
});
