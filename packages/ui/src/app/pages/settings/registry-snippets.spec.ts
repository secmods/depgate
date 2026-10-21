import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { SettingsComponent } from './settings.component';

type SnippetHost = { snippetFor(ecosystem: string, url: string, host: string, token: string): string };

const snippet = (ecosystem: string, url: string, host: string, token: string) => {
  const proto = SettingsComponent.prototype as unknown as SnippetHost;
  return proto.snippetFor.call(proto, ecosystem, url, host, token);
};

describe('Registry snippets', () => {
  it('Cargo: the token is tied to the registry index and sent through the cargo:token provider', () => {
    const text = snippet('cargo', 'http://localhost:3050/cargo/default/', 'localhost:3050', 'tok');
    expect(text).toContain('global-credential-providers = ["cargo:token"]');
    expect(text).toContain('replace-with = "depgate"');
    expect(text).toContain('registry = "sparse+http://localhost:3050/cargo/default/"');
    expect(text).toMatch(/\[registries\.depgate\]\nindex = "sparse\+http:\/\/localhost:3050\/cargo\/default\/"\ntoken = "tok"/);
  });
});
