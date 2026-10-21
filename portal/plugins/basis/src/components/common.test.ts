import { grafanaLink } from './common';

describe('grafanaLink', () => {
  it('is undefined without a Grafana URL or dashboard uid', () => {
    expect(grafanaLink(undefined, 'cnpg-abc')).toBeUndefined();
    expect(
      grafanaLink('https://grafana.example.com', undefined),
    ).toBeUndefined();
  });

  it('links the dashboard with the cluster preselected', () => {
    expect(
      grafanaLink('https://grafana.example.com/', 'cnpg-abc', {
        namespace: 'demo',
        cluster: 'orders-db',
        range: '24h',
      }),
    ).toBe(
      'https://grafana.example.com/d/cnpg-abc?var-namespace=demo&var-cluster=orders-db&from=now-24h&to=now',
    );
  });

  it('substitutes {namespace} and adds kiosk flags when embedded', () => {
    const url = grafanaLink(
      'https://grafana-{namespace}.example.com',
      'cnpg-abc',
      {
        namespace: 'payments',
        embed: true,
      },
    )!;
    expect(
      url.startsWith('https://grafana-payments.example.com/d/cnpg-abc?'),
    ).toBe(true);
    expect(url).toContain('theme=dark');
    expect(url).toContain('&kiosk&_dash.hideTimePicker&_dash.hideVariables');
  });
});
