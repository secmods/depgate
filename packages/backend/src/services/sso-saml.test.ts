/**
 * The SAML service provider against a mock IdP: the happy path, and every forgery the response
 * validation must refuse (requirements_sso.md §8.2). No database or Redis.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SamlProviderConfig } from '../db/entities/SsoProvider.js';
import { EMAIL_FORMAT, MockSamlIdp, PERSISTENT_FORMAT, TRANSIENT_FORMAT } from '../test-support/mock-saml.js';
import { generateSpCertificate } from './saml-certs.js';
import { DEFAULT_SAML_CONFIG } from './sso-rules.js';
import {
  beginSamlLogin,
  completeSamlLogin,
  fetchIdpMetadata,
  parseIdpMetadata,
  SamlError,
  spMetadataXml,
  type SamlProviderHandle,
} from './sso-saml.js';

const URLS = {
  spEntityId: 'https://depgate.example.com/api/auth/saml/p1/metadata',
  acsUrl: 'https://depgate.example.com/api/auth/saml/p1/acs',
};

describe('SAML service provider', () => {
  const idp = new MockSamlIdp();
  const sp = generateSpCertificate('DepGate test SP');
  let seen = new Set<string>();
  const remember = async (id: string) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };

  beforeAll(async () => {
    await idp.start();
  });

  afterAll(async () => {
    await idp.stop();
  });

  beforeEach(() => {
    idp.account = { nameId: 'ravi@hayageek.com', attributes: { email: 'ravi@hayageek.com', groups: ['admins', 'devs'] } };
    idp.tamper = {};
    idp.spCertificate = '';
    seen = new Set();
  });

  function provider(overrides: Partial<SamlProviderConfig> = {}, spPrivateKey = ''): SamlProviderHandle {
    return {
      id: 'p1',
      spPrivateKey,
      config: { ...DEFAULT_SAML_CONFIG, idpEntityId: idp.entityId, ssoUrl: idp.ssoUrl, idpCertificates: [idp.certificate], ...overrides },
    };
  }

  async function signIn(handle: SamlProviderHandle) {
    const { url, pending } = await beginSamlLogin(handle, URLS);
    const { form } = await idp.authorize(url);
    expect(form.RelayState).toBe(pending.relayState);
    return completeSamlLogin(handle, URLS, pending, form.SAMLResponse, remember);
  }

  async function refused(handle: SamlProviderHandle, reason: SamlError['reason'] = 'invalid_response'): Promise<SamlError> {
    const err = await signIn(handle).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(SamlError);
    expect((err as SamlError).reason).toBe(reason);
    return err as SamlError;
  }

  it('sends a plain AuthnRequest for this SP and reads a signed answer', async () => {
    const identity = await signIn(provider());
    expect(identity).toMatchObject({
      subject: 'ravi@hayageek.com',
      nameId: 'ravi@hayageek.com',
      nameIdFormat: EMAIL_FORMAT,
      attributes: { email: 'ravi@hayageek.com', groups: ['admins', 'devs'] },
    });
    expect(identity.assertionId).toMatch(/^_/);
    const request = idp.lastRequest!;
    expect(request).toMatchObject({ issuer: URLS.spEntityId, acsUrl: URLS.acsUrl, nameIdFormat: EMAIL_FORMAT, signed: false });
    expect(request.id).toMatch(/^_[0-9a-f]{40}$/);
    // People who sign in with MFA or a passkey would fail a requested PasswordProtectedTransport.
    expect(request.xml).not.toContain('RequestedAuthnContext');
    expect(request.xml).toContain('ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"');
  });

  it('accepts an assertion signed on its own, the response unsigned', async () => {
    idp.tamper = { sign: 'assertion' };
    await expect(signIn(provider())).resolves.toMatchObject({ subject: 'ravi@hayageek.com' });
  });

  it('refuses a signed response around an unsigned assertion while signed assertions are required', async () => {
    idp.tamper = { sign: 'response' };
    expect((await refused(provider())).message).toMatch(/signature/i);
    idp.tamper = { sign: 'response' };
    await expect(signIn(provider({ requireSignedAssertion: false }))).resolves.toMatchObject({ subject: 'ravi@hayageek.com' });
  });

  it('refuses an unsigned response, whatever the setting', async () => {
    idp.tamper = { sign: 'none' };
    expect((await refused(provider())).message).toMatch(/Invalid signature/);
    idp.tamper = { sign: 'none' };
    expect((await refused(provider({ requireSignedAssertion: false }))).message).toMatch(/signature/i);
  });

  it('trusts only the configured certificate, never one in the response', async () => {
    idp.tamper = { otherKey: true };
    expect((await refused(provider())).message).toMatch(/signature/i);
  });

  it('refuses a response changed after signing', async () => {
    idp.tamper = { afterSign: (xml) => xml.replace('>ravi@hayageek.com</saml:NameID>', '>admin@hayageek.com</saml:NameID>') };
    expect((await refused(provider())).message).toMatch(/Invalid signature/);
  });

  it('refuses signature wrapping', async () => {
    for (const tamper of [
      { sign: 'assertion', xsw: 'extensions' },
      { sign: 'both', xsw: 'extensions' },
      { sign: 'assertion', xsw: 'copy-signature' },
    ] as const) {
      idp.tamper = { ...tamper };
      expect((await refused(provider())).message).toMatch(/Invalid signature/);
    }
  });

  it('reads a NameID split by a comment as a whole, so the comment cannot truncate it', async () => {
    idp.account = { nameId: '', rawNameId: 'ravi@hayageek.com<!---->.evil.test' };
    const identity = await signIn(provider());
    expect(identity.subject).toBe('ravi@hayageek.com.evil.test');
  });

  it('refuses another audience, another issuer, and another destination or recipient', async () => {
    idp.tamper = { audience: 'https://other-sp.example.com' };
    expect((await refused(provider())).message).toMatch(/audience/i);
    idp.tamper = { issuer: 'https://evil-idp.example.test' };
    expect((await refused(provider())).message).toMatch(/issued by/);
    idp.tamper = { destination: 'https://other-sp.example.com/acs' };
    expect((await refused(provider())).message).toMatch(/addressed to/);
    idp.tamper = { recipient: 'https://other-sp.example.com/acs' };
    expect((await refused(provider())).message).toMatch(/is for/);
    idp.tamper = { recipient: null };
    expect((await refused(provider())).message).toMatch(/no Recipient/);
  });

  it('accepts a response without a Destination', async () => {
    idp.tamper = { destination: null };
    await expect(signIn(provider())).resolves.toMatchObject({ subject: 'ravi@hayageek.com' });
  });

  it('checks the validity period with the allowed clock skew', async () => {
    // node-saml finds no SubjectConfirmation still valid before it reaches the Conditions.
    idp.tamper = { expiresIn: -120 };
    expect((await refused(provider())).message).toMatch(/expired|no valid subject confirmation/i);
    idp.tamper = { notBefore: 600 };
    expect((await refused(provider())).message).toMatch(/not yet valid/i);
    idp.tamper = { notBefore: 30 };
    await expect(signIn(provider({ clockSkewSeconds: 60 }))).resolves.toBeTruthy();
    idp.tamper = { notBefore: 30 };
    await refused(provider({ clockSkewSeconds: 0 }));
  });

  it('answers only the request it sent: another InResponseTo, or none, is refused', async () => {
    idp.tamper = { inResponseTo: '_someone-elses-request' };
    expect((await refused(provider())).message).toMatch(/InResponseTo/);
    idp.tamper = { inResponseTo: null };
    expect((await refused(provider())).message).toMatch(/InResponseTo/);
  });

  it('refuses a replayed assertion', async () => {
    const handle = provider();
    const { url, pending } = await beginSamlLogin(handle, URLS);
    const { form } = await idp.authorize(url);
    await completeSamlLogin(handle, URLS, pending, form.SAMLResponse, remember);
    const again = await completeSamlLogin(handle, URLS, pending, form.SAMLResponse, remember).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(SamlError);
    expect((again as SamlError).message).toMatch(/already used/);
  });

  it('reports an IdP error status as the provider refusing', async () => {
    idp.tamper = { status: { code: 'urn:oasis:names:tc:SAML:2.0:status:Responder', subcode: 'urn:oasis:names:tc:SAML:2.0:status:AuthnFailed', message: 'User cancelled' } };
    expect((await refused(provider(), 'provider_error')).message).toMatch(/AuthnFailed|cancelled/);
  });

  it('refuses a transient NameID as the subject, and uses a subject attribute instead when set', async () => {
    idp.account = { nameId: '_8f3c', nameIdFormat: TRANSIENT_FORMAT, attributes: { email: 'ravi@hayageek.com', employeeId: 'E-1001' } };
    expect((await refused(provider())).message).toMatch(/transient/);
    idp.account = { nameId: '_9a1d', nameIdFormat: TRANSIENT_FORMAT, attributes: { email: 'ravi@hayageek.com', employeeId: 'E-1001' } };
    await expect(signIn(provider({ subjectAttribute: 'employeeId' }))).resolves.toMatchObject({ subject: 'E-1001' });
    idp.account = { nameId: '_9a1e', nameIdFormat: TRANSIENT_FORMAT, attributes: {} };
    expect((await refused(provider({ subjectAttribute: 'employeeId' }))).message).toMatch(/no employeeId attribute/);
  });

  it('accepts a persistent NameID as the subject', async () => {
    idp.account = { nameId: 'a1b2c3', nameIdFormat: PERSISTENT_FORMAT, attributes: { email: 'ravi@hayageek.com' } };
    await expect(signIn(provider())).resolves.toMatchObject({ subject: 'a1b2c3', nameIdFormat: PERSISTENT_FORMAT });
  });

  it('decrypts an encrypted assertion only when told to, and still requires its signature', async () => {
    idp.tamper = { encryptTo: sp.certificate };
    expect((await refused(provider())).message).toMatch(/decryption key/i);

    const encrypted = provider({ acceptEncryptedAssertions: true, spCertificate: sp.certificate }, sp.privateKey);
    idp.tamper = { encryptTo: sp.certificate };
    await expect(signIn(encrypted)).resolves.toMatchObject({ subject: 'ravi@hayageek.com' });

    // Encrypted but not signed inside, only the outer response signed: still refused.
    idp.tamper = { encryptTo: sp.certificate, sign: 'response' };
    await refused(encrypted);
  });

  it('signs the AuthnRequest with the SP key when asked', async () => {
    idp.spCertificate = sp.certificate;
    await signIn(provider({ signRequests: true, spCertificate: sp.certificate }, sp.privateKey));
    expect(idp.lastRequest).toMatchObject({ signed: true, signatureValid: true });
  });

  it('will not start without the SP key that signing or decryption needs', async () => {
    const err = await beginSamlLogin(provider({ signRequests: true, spCertificate: sp.certificate }, ''), URLS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SamlError);
    expect((err as SamlError).reason).toBe('provider_unavailable');
  });

  it('accepts either of two certificates, so the IdP can rotate', async () => {
    const next = generateSpCertificate('Next IdP key');
    await expect(signIn(provider({ idpCertificates: [next.certificate, idp.certificate] }))).resolves.toBeTruthy();
  });

  it('refuses XML that is not a SAML response, or declares a DOCTYPE', async () => {
    const handle = provider();
    const { pending } = await beginSamlLogin(handle, URLS);
    const attempt = (body: string) => completeSamlLogin(handle, URLS, pending, Buffer.from(body).toString('base64'), remember).catch((e: unknown) => e as SamlError);
    expect((await attempt('<!DOCTYPE x [<!ENTITY a "aaaa">]><samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>')).message).toMatch(/DOCTYPE/);
    expect((await attempt('<foo/>')).message).toMatch(/not a SAML 2.0 Response/);
    expect((await attempt('not xml at all <')).message).toMatch(/not valid XML|not a SAML/);
    expect((await completeSamlLogin(handle, URLS, pending, undefined, remember).catch((e: unknown) => e as SamlError)).message).toMatch(/no SAMLResponse/);
  });
});

describe('SAML metadata', () => {
  const idp = new MockSamlIdp();

  beforeAll(async () => {
    await idp.start();
  });

  afterAll(async () => {
    await idp.stop();
  });

  it('reads the entity ID, the Redirect endpoint and the signing certificates only', () => {
    const found = parseIdpMetadata(idp.metadataXml());
    expect(found.entityId).toBe(idp.entityId);
    expect(found.ssoUrl).toBe(idp.ssoUrl);
    expect(found.certificates).toEqual([idp.certificate.replace(/\r\n/g, '\n')].map((pem) => expect.stringContaining(idp.certificateBody(pem).slice(0, 40))));
    expect(found.certificates).toHaveLength(1);
    expect(found.nameIdFormats).toContain(EMAIL_FORMAT);
  });

  it('reads two signing certificates during a rotation', () => {
    const next = generateSpCertificate('Next');
    expect(parseIdpMetadata(idp.metadataXml({ certificates: [idp.certificate, next.certificate] })).certificates).toHaveLength(2);
  });

  it('refuses metadata it cannot use', () => {
    const xml = idp.metadataXml();
    expect(() => parseIdpMetadata(xml.replace(/<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"[^>]*\/>/, ''))).toThrow(/HTTP-Redirect/);
    expect(() => parseIdpMetadata(xml.replace(/<md:KeyDescriptor use="signing">[\s\S]*?<\/md:KeyDescriptor>/, ''))).toThrow(/no signing certificate/);
    expect(() => parseIdpMetadata(`<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${xml.replace(/<\?xml[^>]*\?>/, '')}${xml.replace(/<\?xml[^>]*\?>/, '').replace(idp.entityId, 'https://second.example')}</md:EntitiesDescriptor>`)).toThrow(/several identity providers/);
    expect(() => parseIdpMetadata(`<!DOCTYPE lolz [<!ENTITY lol "lol">]>${xml.replace(/<\?xml[^>]*\?>/, '')}`)).toThrow(/DOCTYPE/);
    expect(() => parseIdpMetadata('<html><body>Sign in</body></html>')).toThrow(/no SAML identity provider/);
    expect(() => parseIdpMetadata(xml.replace(/<ds:X509Certificate>[^<]+/, '<ds:X509Certificate>bm90IGEgY2VydA=='))).toThrow(/could not be read/);
  });

  it('fetches metadata from a URL, without following redirects', async () => {
    await expect(fetchIdpMetadata(idp.metadataUrl)).resolves.toMatchObject({ entityId: idp.entityId });
    await expect(fetchIdpMetadata(idp.metadataUrl.replace('/metadata', '/redirect'))).rejects.toThrow(/redirects/);
    await expect(fetchIdpMetadata('http://idp.example.com/metadata')).rejects.toThrow(/https/);
    await expect(fetchIdpMetadata('http://127.0.0.1:9/metadata')).rejects.toMatchObject({ reason: 'provider_unavailable' });
  });

  it('describes this SP for the IdP, with its certificate only where it is used and never the key', () => {
    const sp = generateSpCertificate('DepGate');
    const plain = spMetadataXml({ config: DEFAULT_SAML_CONFIG, hasPrivateKey: false }, URLS);
    expect(plain).toContain(`entityID="${URLS.spEntityId}"`);
    expect(plain).toContain(`Location="${URLS.acsUrl}"`);
    expect(plain).toContain('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
    expect(plain).toContain('WantAssertionsSigned="true"');
    expect(plain).not.toContain('KeyDescriptor');

    const body = sp.certificate.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, '');
    const signing = spMetadataXml({ config: { ...DEFAULT_SAML_CONFIG, signRequests: true, spCertificate: sp.certificate }, hasPrivateKey: true }, URLS);
    expect(signing).toContain('AuthnRequestsSigned="true"');
    expect(signing).toContain('use="signing"');
    expect(signing).toContain(body.slice(0, 60));
    expect(signing).not.toContain('PRIVATE KEY');

    const both = spMetadataXml(
      { config: { ...DEFAULT_SAML_CONFIG, signRequests: true, acceptEncryptedAssertions: true, spCertificate: sp.certificate }, hasPrivateKey: true },
      URLS
    );
    expect(both).toContain('use="encryption"');
  });
});
