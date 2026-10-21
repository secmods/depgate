import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { ToastService } from '../../services/toast.service';
import { CertificateInfo, SsoProvider, SsoService } from '../../services/sso.service';
import { SsoProviderPageComponent } from './sso-provider-page.component';
import { SsoSettingsComponent } from './sso-settings.component';
import { SsoTestRunner } from './sso-test-runner.service';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

const PEM_A = '-----BEGIN CERTIFICATE-----\nMIIA\n-----END CERTIFICATE-----\n';
const PEM_B = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const PEM_C = '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----\n';
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const info = (subject: string, days = 365): CertificateInfo => ({
  subject,
  issuer: subject,
  fingerprint: 'AB:CD:EF',
  notBefore: inDays(-30),
  notAfter: inDays(days),
  expired: days < 0,
  expiresSoon: days < 30,
});

const URLS = (id: string) => ({
  redirectUri: `https://depgate.acme.com/api/auth/sso/${id}/callback`,
  initiateLoginUri: `https://depgate.acme.com/api/auth/sso/${id}/start`,
  postLogoutRedirectUri: 'https://depgate.acme.com/login',
  spEntityId: `https://depgate.acme.com/api/auth/saml/${id}/metadata`,
  acsUrl: `https://depgate.acme.com/api/auth/saml/${id}/acs`,
  spMetadataUrl: `https://depgate.acme.com/api/auth/saml/${id}/metadata`,
});

const SAVED: SsoProvider = {
  id: 's1',
  type: 'saml',
  name: 'Corporate SAML',
  buttonLabel: 'Sign in with Corporate SAML',
  enabled: true,
  oidc: null,
  saml: {
    metadataUrl: 'https://idp.acme.com/saml/metadata',
    idpEntityId: 'https://idp.acme.com/saml',
    ssoUrl: 'https://idp.acme.com/saml/sso',
    idpCertificates: [PEM_A],
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    emailAttribute: '',
    subjectAttribute: '',
    requiredAttributes: [{ attribute: 'department', value: 'Engineering' }],
    requireSignedAssertion: true,
    signRequests: false,
    acceptEncryptedAssertions: false,
    clockSkewSeconds: 60,
    spCertificate: '',
    idpCertificateInfo: [info('CN=idp.acme.com', 10)],
    spCertificateInfo: null,
    hasSpPrivateKey: false,
    spPrivateKeyUnreadable: false,
  },
  certificateExpiresAt: inDays(10),
  lastError: null,
  lastSuccessAt: null,
  urls: URLS('s1'),
  createdAt: '2026-10-14T00:00:00Z',
  updatedAt: '2026-10-14T00:00:00Z',
};

const SETUP = { id: 'new-id-1', urls: URLS('new-id-1'), publicUrl: 'https://depgate.acme.com', publicUrlSource: 'setting' };

function setValue(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
}

describe('SsoProviderPageComponent (SAML)', () => {
  let fixture: ComponentFixture<SsoProviderPageComponent>;
  let sso: Record<string, ReturnType<typeof vi.fn>>;
  let router: { navigate: ReturnType<typeof vi.fn>; navigateByUrl: ReturnType<typeof vi.fn> };
  let toast: Record<string, ReturnType<typeof vi.fn>>;
  let tester: { run: ReturnType<typeof vi.fn> };

  async function open(id: string | null, saved: SsoProvider = SAVED) {
    sso = {
      setup: vi.fn().mockReturnValue(of(id ? { ...SETUP, id, urls: URLS(id) } : SETUP)),
      signinSettings: vi.fn().mockReturnValue(of({ allowedDomains: ['acme.com'], allowUnlistedSso: true, ssoEnabled: false })),
      get: vi.fn().mockReturnValue(of(saved)),
      samlMetadata: vi.fn().mockReturnValue(of({
        entityId: 'https://idp.acme.com/saml',
        ssoUrl: 'https://idp.acme.com/saml/sso',
        certificates: [{ pem: PEM_A, info: info('CN=idp.acme.com') }],
        nameIdFormats: ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
        wantAuthnRequestsSigned: false,
      })),
      certificateInfo: vi.fn().mockImplementation((certs: string[]) =>
        of({ certificates: certs.map((pem) => ({ pem, info: info(`CN=${pem.includes('MIIB') ? 'next' : pem.includes('MIIC') ? 'third' : 'pasted'}`) })) })
      ),
      create: vi.fn().mockReturnValue(of({ provider: { ...SAVED, id: 'new-id-1', urls: URLS('new-id-1') }, validationError: null })),
      update: vi.fn().mockReturnValue(of({ provider: SAVED, validationError: null })),
    };
    router = { navigate: vi.fn().mockResolvedValue(true), navigateByUrl: vi.fn().mockResolvedValue(true) };
    toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
    tester = { run: vi.fn().mockResolvedValue(undefined) };
    await TestBed.configureTestingModule({
      imports: [SsoProviderPageComponent],
      providers: [
        { provide: SsoService, useValue: sso },
        { provide: Router, useValue: router },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap(id ? { id } : {}), queryParamMap: convertToParamMap({}) } } },
        { provide: ToastService, useValue: toast },
        { provide: SsoTestRunner, useValue: tester },
        { provide: ConfirmService, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SsoProviderPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const byId = <T extends HTMLElement = HTMLInputElement>(id: string) => el().querySelector(`#${id}`) as T;
  const q = (testId: string) => el().querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const save = () => q('sso-save') as HTMLButtonElement;
  const page = () => fixture.componentInstance;

  /** ngModel writes values into the inputs a tick after a change. */
  async function settle() {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function chooseSaml() {
    (q('sso-type-saml') as HTMLInputElement).click();
    await settle();
  }

  it('offers SAML 2.0, with the SP entity ID and ACS URL to register before anything is typed', async () => {
    await open(null);
    expect(el().textContent).not.toContain('coming later');
    expect((q('sso-type-saml') as HTMLInputElement).disabled).toBe(false);
    await chooseSaml();
    expect(byId('sso-issuer')).toBeNull();
    expect(q('sso-redirect-uri')).toBeNull();
    expect(q('sso-sp-entity-id')!.textContent).toBe(SETUP.urls.spEntityId);
    expect(q('sso-acs-url')!.textContent).toBe(SETUP.urls.acsUrl);
    expect(q('sso-sp-metadata-later')).not.toBeNull();
    setValue(byId('sso-name'), 'Corporate SAML');
    fixture.detectChanges();
    expect(q('sso-save-blocker')!.textContent).toContain('Enter the IdP entity ID');
    expect(save().disabled).toBe(true);
    expect(el().textContent).not.toMatch(/okta|google|entra|auth0|keycloak/i);
  });

  it('reads the IdP from its metadata URL and shows the certificate', async () => {
    await open(null);
    await chooseSaml();
    setValue(byId('saml-metadata-url'), 'https://idp.acme.com/saml/metadata');
    fixture.detectChanges();
    (q('saml-read-metadata') as HTMLButtonElement).click();
    await settle();
    expect(sso['samlMetadata']).toHaveBeenCalledWith({ url: 'https://idp.acme.com/saml/metadata' });
    expect(byId('saml-entity-id').value).toBe('https://idp.acme.com/saml');
    expect(byId('saml-sso-url').value).toBe('https://idp.acme.com/saml/sso');
    expect(q('saml-idp-certs')!.textContent).toContain('CN=idp.acme.com');
    expect(q('saml-idp-certs')!.textContent).toContain('AB:CD:EF');
    const pemBox = q('saml-cert-pem') as HTMLTextAreaElement;
    expect(pemBox.readOnly).toBe(true);
    expect(pemBox.value).toBe(PEM_A);
    expect(byId('saml-cert-input')).toBeNull();
    expect(q('saml-metadata-note')!.textContent).toContain('1 signing certificate');
    expect(q('sso-summary-certs')!.textContent).toContain('1, first expires');
  });

  it('turns signed requests on when the IdP metadata asks for them', async () => {
    await open(null);
    await chooseSaml();
    sso['samlMetadata'].mockReturnValue(of({
      entityId: 'https://idp.acme.com/saml', ssoUrl: 'https://idp.acme.com/sso', certificates: [{ pem: PEM_A, info: info('CN=x') }],
      nameIdFormats: ['urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'], wantAuthnRequestsSigned: true,
    }));
    setValue(byId('sso-name'), 'Corporate SAML');
    setValue(byId('saml-metadata-url'), 'https://idp.acme.com/saml/metadata');
    fixture.detectChanges();
    (q('saml-read-metadata') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(page().saml.signRequests).toBe(true);
    expect(page().saml.nameIdFormat).toBe('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent');
    expect(q('sso-save-blocker')!.textContent).toContain('Generate or upload an SP certificate');
  });

  it('shows why the metadata could not be read', async () => {
    await open(null);
    await chooseSaml();
    sso['samlMetadata'].mockReturnValue(throwError(() => ({ error: { error: 'The metadata has no signing certificate' } })));
    setValue(byId('saml-metadata-url'), 'https://idp.acme.com/saml/metadata');
    fixture.detectChanges();
    (q('saml-read-metadata') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(q('saml-metadata-error')!.textContent).toContain('no signing certificate');
  });

  it('reads pasted metadata XML and an uploaded metadata file', async () => {
    await open(null);
    await chooseSaml();
    (q('saml-source-xml') as HTMLInputElement).click();
    fixture.detectChanges();
    setValue(byId<HTMLTextAreaElement>('saml-metadata-xml'), '<md:EntityDescriptor/>');
    fixture.detectChanges();
    (q('saml-read-metadata') as HTMLButtonElement).click();
    expect(sso['samlMetadata']).toHaveBeenLastCalledWith({ xml: '<md:EntityDescriptor/>' });

    (q('saml-source-file') as HTMLInputElement).click();
    fixture.detectChanges();
    page().onMetadataFile({ target: { files: [{ text: async () => '<from-file/>' }] } } as unknown as Event);
    await fixture.whenStable();
    expect(sso['samlMetadata']).toHaveBeenLastCalledWith({ xml: '<from-file/>' });
  });

  it('lets Save read the metadata URL itself, and creates with the id the URLs were made for', async () => {
    await open(null);
    await chooseSaml();
    setValue(byId('sso-name'), 'Corporate SAML');
    setValue(byId('saml-metadata-url'), 'https://idp.acme.com/saml/metadata');
    fixture.detectChanges();
    expect(q('sso-save-blocker')).toBeNull();
    expect(q('sso-summary-facts')!.textContent).toContain('From the metadata');
    save().click();
    fixture.detectChanges();
    expect(sso['create'].mock.calls[0][0]).toMatchObject({
      id: 'new-id-1',
      type: 'saml',
      name: 'Corporate SAML',
      saml: { metadataUrl: 'https://idp.acme.com/saml/metadata', requireSignedAssertion: true, signRequests: false },
    });
    expect(sso['create'].mock.calls[0][0].oidc).toBeUndefined();
    expect(sso['create'].mock.calls[0][0].saml.spKey).toBeUndefined();
    expect(router.navigate).toHaveBeenCalledWith(['/access/sso', 'new-id-1', 'edit'], { replaceUrl: true });
  });

  it('takes typed IdP details and pasted certificates, at most two', async () => {
    await open(null);
    await chooseSaml();
    (q('saml-source-xml') as HTMLInputElement).click();
    setValue(byId('sso-name'), 'Typed');
    setValue(byId('saml-entity-id'), 'https://idp.acme.com/saml');
    setValue(byId('saml-sso-url'), 'https://idp.acme.com/saml/sso');
    fixture.detectChanges();
    expect(q('sso-save-blocker')!.textContent).toContain('Add the IdP signing certificate');
    for (const pem of [PEM_A, PEM_B]) {
      if (!byId('saml-cert-input')) {
        (q('saml-add-another') as HTMLButtonElement).click();
        fixture.detectChanges();
      }
      setValue(byId<HTMLTextAreaElement>('saml-cert-input'), pem);
      fixture.detectChanges();
      (q('saml-add-cert') as HTMLButtonElement).click();
      await settle();
    }
    // The server answers with the certificate as it read it; the mock echoes the trimmed paste.
    expect(page().idpCerts.map((c) => c.pem)).toEqual([PEM_A.trim(), PEM_B.trim()]);
    const shown = Array.from(el().querySelectorAll('[data-testid="saml-cert-pem"]')) as HTMLTextAreaElement[];
    expect(shown.map((box) => box.value)).toEqual([PEM_A.trim(), PEM_B.trim()]);
    // Two is the limit: the paste box goes away.
    expect(byId('saml-cert-input')).toBeNull();
    expect(q('saml-add-another')).toBeNull();
    page().addCertificate(PEM_C);
    fixture.detectChanges();
    expect(q('saml-cert-error')!.textContent).toContain('At most 2');
    expect(q('sso-save-blocker')).toBeNull();
    save().click();
    expect(sso['create'].mock.calls[0][0].saml).toMatchObject({ metadataUrl: '', idpCertificates: [PEM_A.trim(), PEM_B.trim()], idpEntityId: 'https://idp.acme.com/saml' });
  });

  it('shows the server error for a pasted certificate it cannot read', async () => {
    await open(null);
    await chooseSaml();
    sso['certificateInfo'].mockReturnValue(throwError(() => ({ error: { error: 'The certificate could not be read.' } })));
    page().addCertificate('garbage');
    fixture.detectChanges();
    expect(q('saml-cert-error')!.textContent).toContain('could not be read');
    expect(page().idpCerts).toEqual([]);
  });

  it('needs an SP certificate to sign requests, and generates one on save', async () => {
    await open('s1');
    (q('saml-sign-requests') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(q('sso-save-blocker')!.textContent).toContain('Generate or upload an SP certificate');
    (q('saml-sp-generate') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(q('saml-sp-pending')!.textContent).toContain('generated when you save');
    expect(q('sso-summary-security')!.textContent).toContain('requests signed');
    save().click();
    expect(sso['update'].mock.calls[0][1].saml).toMatchObject({ signRequests: true, spKey: { action: 'generate' } });
  });

  it('uploads an SP certificate and key', async () => {
    await open('s1');
    (q('saml-encrypted') as HTMLInputElement).click();
    fixture.detectChanges();
    (q('saml-sp-upload-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    const [cert, key] = Array.from(q('saml-sp-key')!.querySelectorAll('textarea'));
    setValue(cert, PEM_B);
    setValue(key, '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----');
    fixture.detectChanges();
    (q('saml-sp-upload') as HTMLButtonElement).click();
    fixture.detectChanges();
    save().click();
    expect(sso['update'].mock.calls[0][1].saml.spKey).toEqual({
      action: 'upload',
      certificate: PEM_B.trim(),
      privateKey: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
    });
  });

  it('warns that a transient NameID needs a subject attribute', async () => {
    await open('s1');
    setValue(byId<HTMLSelectElement>('saml-nameid-format'), 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient');
    fixture.detectChanges();
    expect(q('saml-transient-warning')).not.toBeNull();
    setValue(byId('saml-subject-attr'), 'employeeId');
    fixture.detectChanges();
    expect(q('saml-transient-warning')).toBeNull();
  });

  it('loads a saved SAML provider: protocol fixed, certificate expiry warned, SP metadata downloadable', async () => {
    await open('s1');
    expect((q('sso-type-saml') as HTMLInputElement).checked).toBe(true);
    expect((q('sso-type-oidc') as HTMLInputElement).disabled).toBe(true);
    expect(q('sso-cert-expiring')!.textContent).toMatch(/in (9|10) days/);
    expect((q('sso-sp-metadata') as HTMLAnchorElement).getAttribute('href')).toBe(URLS('s1').spMetadataUrl);
    expect(q('sso-steps')!.textContent).toContain('Entity ID, SSO URL and 1 signing certificate');
    expect(save().textContent).toContain('Update provider');
    save().click();
    const body = sso['update'].mock.calls[0][1];
    expect(body.type).toBe('saml');
    expect(body.saml.spKey).toBeUndefined();
    expect(body.saml.requiredAttributes).toEqual([{ attribute: 'department', value: 'Engineering' }]);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('says when every IdP certificate has expired', async () => {
    const expired: SsoProvider = { ...SAVED, saml: { ...SAVED.saml!, idpCertificateInfo: [info('CN=old', -3)] } };
    await open('s1', expired);
    expect(q('sso-cert-expired')).not.toBeNull();
    expect(q('sso-summary-certs')!.textContent).toContain('expired');
    expect(q('sso-steps')!.textContent).toContain('Every signing certificate has expired');
  });

  it('tests the saved SAML provider from its panel', async () => {
    await open('s1');
    (q('sso-page-test') as HTMLButtonElement).click();
    expect(tester.run).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', type: 'saml' }));
  });
});

describe('SsoSettingsComponent (SAML rows)', () => {
  it('lists a SAML provider with its IdP entity ID and warns before its certificate expires', async () => {
    const expiring = { ...SAVED, name: 'Expiring', certificateExpiresAt: inDays(5) };
    const expired = { ...SAVED, id: 's2', name: 'Expired', certificateExpiresAt: inDays(-2) };
    const sso = {
      list: vi.fn().mockReturnValue(of([expiring, expired])),
      signinSettings: vi.fn().mockReturnValue(of({ allowedDomains: ['acme.com'], allowUnlistedSso: true, ssoEnabled: true })),
    };
    await TestBed.configureTestingModule({
      imports: [SsoSettingsComponent],
      providers: [
        { provide: SsoService, useValue: sso },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: NgbModal, useValue: { open: vi.fn() } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: ConfirmService, useValue: { confirm: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SsoSettingsComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('OpenID Connect and SAML 2.0');
    const row = el.querySelector('[data-testid="sso-row-Expiring"]')!;
    expect(row.textContent).toContain('https://idp.acme.com/saml');
    expect(row.textContent).toContain('SAML');
    expect(el.querySelector('[data-testid="sso-cert-expiring-Expiring"]')!.textContent).toMatch(/expires in [45] days/);
    expect(el.querySelector('[data-testid="sso-cert-expired-Expired"]')).not.toBeNull();
  });
});
