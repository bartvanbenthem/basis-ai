import { providerKeySecretName } from './modelgateway';

describe('providerKeySecretName', () => {
  it('is a valid Secret name, stable, and tells similar models apart', () => {
    const a = providerKeySecretName('tststck', 'openai/gpt-oss-120b');
    expect(a).toMatch(/^tststck-key-openai-gpt-oss-120b-[0-9a-f]{8}$/);
    expect(providerKeySecretName('tststck', 'openai/gpt-oss-120b')).toBe(a);
    expect(providerKeySecretName('tststck', 'GPT.4')).not.toBe(providerKeySecretName('tststck', 'gpt-4'));
    expect(providerKeySecretName('llm', '***')).toMatch(/^llm-key-[0-9a-f]{8}$/);
    expect(providerKeySecretName('x'.repeat(40), 'm'.repeat(300)).length).toBeLessThanOrEqual(253);
  });
});
