import { parseSizes, sizeLabel } from './sizes';

describe('parseSizes', () => {
  it('reads the catalog in order', () => {
    const sizes = parseSizes({
      sizes: [
        {
          name: 'xs',
          displayName: 'XS',
          description: 'Development and tests',
          resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '1Gi' } },
          parameters: { max_connections: '100', shared_buffers: '256MB' },
          storage: { size: '10Gi' },
        },
        {
          name: 'm',
          resources: { requests: { cpu: 2, memory: '8Gi' } },
          parameters: { max_connections: 200 },
          storage: { size: '50Gi', walSize: '10Gi' },
        },
      ],
    });
    expect(sizes).toEqual([
      {
        name: 'xs',
        displayName: 'XS',
        description: 'Development and tests',
        resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '1Gi' } },
        parameters: { max_connections: '100', shared_buffers: '256MB' },
        storage: { size: '10Gi' },
      },
      {
        name: 'm',
        displayName: 'M',
        resources: { requests: { cpu: '2', memory: '8Gi' } },
        parameters: { max_connections: '200' },
        storage: { size: '50Gi', walSize: '10Gi' },
      },
    ]);
  });

  it('skips entries spec.size could not name, and repeats', () => {
    expect(
      parseSizes({ sizes: [{ name: 'Big' }, { displayName: 'none' }, { name: 's' }, { name: 's' }] }).map(s => s.name),
    ).toEqual(['s']);
  });

  it('drops volume suggestions that are not quantities', () => {
    expect(parseSizes({ sizes: [{ name: 's', storage: { size: 'lots' } }] })[0].storage).toBeUndefined();
  });

  it('is empty without a catalog', () => {
    expect(parseSizes(undefined)).toEqual([]);
    expect(parseSizes({ sizes: 'xs' })).toEqual([]);
  });
});

describe('sizeLabel', () => {
  it('names the size and what each instance gets', () => {
    const [m] = parseSizes({ sizes: [{ name: 'm', resources: { requests: { cpu: '2', memory: '8Gi' } } }] });
    expect(sizeLabel(m)).toBe('M — 2 vCPU · 8Gi memory');
    const [xs] = parseSizes({ sizes: [{ name: 'xs', resources: { requests: { cpu: '500m' } } }] });
    expect(sizeLabel(xs)).toBe('XS — 500m CPU');
  });
});
