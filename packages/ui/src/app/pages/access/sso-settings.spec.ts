import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { ToastService } from '../../services/toast.service';
import { SsoProvider, SsoService } from '../../services/sso.service';
import { SsoProviderPageComponent } from './sso-provider-page.component';
import { SsoTestRunner } from './sso-test-runner.service';
import { SigninSettingsComponent } from './signin-settings.component';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

const SAVED: SsoProvider = {
  id: 'p1',
  type: 'oidc',
  name: 'Corporate SSO',
  buttonLabel: 'Sign in with Company SSO',
  enabled: true,
  oidc: {
    issuer: 'https://idp.example.com/realms/acme',
    clientId: 'depgate',
    scopes: 'openid email profile',
    emailClaim: 'email',
    requireVerifiedEmail: true,
    requiredClaims: [{ claim: 'hd', value: 'acme.com' }],
    useDiscovery: true,
    authorizationEndpoint: '',
    tokenEndpoint: '',
    jwksUri: '',
    userinfoEndpoint: '',
    clientAuthMethod: 'client_secret_basic',
    clockSkewSeconds: 60,
    extraAuthParams: [],
    hasClientSecret: true,
    clientSecretUnreadable: false,
  },
  saml: null,
  certificateExpiresAt: null,
  lastError: null,
  lastSuccessAt: null,
  urls: {
    redirectUri: 'https://depgate.acme.com/api/auth/sso/p1/callback',
    initiateLoginUri: 'https://depgate.acme.com/api/auth/sso/p1/start',
    postLogoutRedirectUri: 'https://depgate.acme.com/login',
    spEntityId: 'https://depgate.acme.com/api/auth/saml/p1/metadata',
    acsUrl: 'https://depgate.acme.com/api/auth/saml/p1/acs',
    spMetadataUrl: 'https://depgate.acme.com/api/auth/saml/p1/metadata',
  },
  createdAt: '2026-10-14T00:00:00Z',
  updatedAt: '2026-10-14T00:00:00Z',
};

function setValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('SsoProviderPageComponent', () => {
  let fixture: ComponentFixture<SsoProviderPageComponent>;
  let sso: Record<string, ReturnType<typeof vi.fn>>;
  let router: { navigate: ReturnType<typeof vi.fn>; navigateByUrl: ReturnType<typeof vi.fn> };
  let toast: Record<string, ReturnType<typeof vi.fn>>;
  let tester: { run: ReturnType<typeof vi.fn> };
  let confirm: { confirm: ReturnType<typeof vi.fn> };

  const SETUP = {
    id: 'new-id-1',
    urls: {
      redirectUri: 'https://depgate.acme.com/api/auth/sso/new-id-1/callback',
      initiateLoginUri: 'https://depgate.acme.com/api/auth/sso/new-id-1/start',
      postLogoutRedirectUri: 'https://depgate.acme.com/login',
      spEntityId: 'https://depgate.acme.com/api/auth/saml/new-id-1/metadata',
      acsUrl: 'https://depgate.acme.com/api/auth/saml/new-id-1/acs',
      spMetadataUrl: 'https://depgate.acme.com/api/auth/saml/new-id-1/metadata',
    },
    publicUrl: 'https://depgate.acme.com',
    publicUrlSource: 'setting',
  };

  async function open(id: string | null, domains: string[] = ['acme.com']) {
    sso = {
      setup: vi.fn().mockReturnValue(of(SETUP)),
      signinSettings: vi.fn().mockReturnValue(of({ allowedDomains: domains, allowUnlistedSso: true, ssoEnabled: false })),
      get: vi.fn().mockReturnValue(of(SAVED)),
      discover: vi.fn().mockReturnValue(of({
        issuer: 'https://idp.example.com/realms/acme',
        authorizationEndpoint: 'https://idp.example.com/auth',
        tokenEndpoint: 'https://idp.example.com/token',
        jwksUri: 'https://idp.example.com/jwks',
        userinfoEndpoint: 'https://idp.example.com/userinfo',
        signingAlgs: ['RS256'],
        tokenEndpointAuthMethods: ['client_secret_post'],
        scopesSupported: [],
        claimsSupported: [],
      })),
      create: vi.fn().mockReturnValue(of({ provider: { ...SAVED, enabled: false }, validationError: null })),
      update: vi.fn().mockReturnValue(of({ provider: SAVED, validationError: null })),
    };
    router = { navigate: vi.fn().mockResolvedValue(true), navigateByUrl: vi.fn().mockResolvedValue(true) };
    toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
    tester = { run: vi.fn().mockResolvedValue(undefined) };
    confirm = { confirm: vi.fn().mockResolvedValue(true) };
    await TestBed.configureTestingModule({
      imports: [SsoProviderPageComponent],
      providers: [
        { provide: SsoService, useValue: sso },
        { provide: Router, useValue: router },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap(id ? { id } : {}) } } },
        { provide: ToastService, useValue: toast },
        { provide: SsoTestRunner, useValue: tester },
        { provide: ConfirmService, useValue: confirm },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SsoProviderPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const input = (id: string) => el().querySelector(`#${id}`) as HTMLInputElement;
  const q = (testId: string) => el().querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const save = () => q('sso-save') as HTMLButtonElement;

  function fillNew() {
    setValue(input('sso-name'), 'Corporate SSO');
    setValue(input('sso-issuer'), 'https://idp.example.com/realms/acme');
    setValue(input('sso-client-id'), 'depgate');
    setValue(input('sso-client-secret'), 'the-secret');
    fixture.detectChanges();
  }

  it('shows the redirect URI before anything is typed, and says what Save still needs', async () => {
    await open(null);
    expect(sso['setup']).toHaveBeenCalledWith(undefined);
    expect(q('sso-redirect-uri')!.textContent).toBe(SETUP.urls.redirectUri);
    expect(save().disabled).toBe(true);
    expect(save().textContent).toContain('Create provider');
    expect(q('sso-save-blocker')!.textContent).toContain('Enter a name');
    setValue(input('sso-name'), 'Corporate SSO');
    setValue(input('sso-issuer'), 'https://idp.example.com/realms/acme');
    setValue(input('sso-client-id'), 'depgate');
    fixture.detectChanges();
    expect(q('sso-save-blocker')!.textContent).toContain('Enter the client secret');
    // Like the policy form: the step is a link to the field.
    (q('sso-save-blocker') as HTMLButtonElement).click();
    expect(document.activeElement).toBe(input('sso-client-secret'));
    setValue(input('sso-client-secret'), 'the-secret');
    fixture.detectChanges();
    expect(save().disabled).toBe(false);
    expect(q('sso-save-blocker')).toBeNull();
    // A new provider cannot be tested until it is saved; vendor names stay out of the form.
    expect(q('sso-page-test')).toBeNull();
    expect(q('sso-test-panel')).toBeNull();
    expect(el().textContent).not.toMatch(/okta|google|entra|auth0|keycloak/i);
  });

  it('summarises what will be saved as it is typed', async () => {
    await open(null);
    fillNew();
    const facts = q('sso-summary-facts')!.textContent!;
    expect(facts).toContain('Corporate SSO');
    expect(facts).toContain('https://idp.example.com/realms/acme');
    expect(facts).toContain('depgate');
    expect(q('sso-summary-secret')!.textContent).toContain('Saved when you create');
    expect(facts).not.toContain('the-secret');
    const steps = q('sso-steps')!.textContent!;
    expect(steps).toContain('Allowed sign-in domain');
    expect(steps).toContain('acme.com');
  });

  it('points to Who may sign in when no domain is allowed yet', async () => {
    await open(null, []);
    expect(q('sso-steps')!.textContent).toContain('Add one under Who may sign in');
  });

  it('links to the discovery document as the issuer is typed', async () => {
    await open(null);
    expect(q('sso-discovery-link')).toBeNull();
    expect(q('sso-discovery-hint')!.textContent).toContain('<issuer>/.well-known/openid-configuration');
    expect(input('sso-issuer').placeholder).toBe('https://accounts.google.com');
    setValue(input('sso-issuer'), 'https://yourtenant.auth0.com/');
    fixture.detectChanges();
    const link = q('sso-discovery-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://yourtenant.auth0.com/.well-known/openid-configuration');
    expect(link.target).toBe('_blank');
  });

  it('discovers the provider, takes the published issuer and a client authentication it supports', async () => {
    await open(null);
    sso['discover'].mockReturnValue(of({
      issuer: 'https://testravi.auth0.com/', authorizationEndpoint: 'https://testravi.auth0.com/authorize', tokenEndpoint: 'https://testravi.auth0.com/oauth/token',
      jwksUri: 'https://testravi.auth0.com/.well-known/jwks.json', userinfoEndpoint: '', signingAlgs: ['RS256'], tokenEndpointAuthMethods: ['client_secret_post'], scopesSupported: [], claimsSupported: [],
    }));
    setValue(input('sso-issuer'), 'https://testravi.auth0.com');
    fixture.detectChanges();
    (q('sso-discover') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(q('sso-discovered')!.textContent).toContain('RS256');
    expect(fixture.componentInstance.oidc.issuer).toBe('https://testravi.auth0.com/');
    expect(fixture.componentInstance.oidc.clientAuthMethod).toBe('client_secret_post');
    expect(q('sso-issuer-note')!.textContent).toContain('exactly as the provider publishes it');
  });

  it('shows a discovery error from the server', async () => {
    await open(null);
    sso['discover'].mockReturnValue(throwError(() => ({ error: { error: 'The discovery document names issuer "x"' } })));
    setValue(input('sso-issuer'), 'https://idp.example.com/');
    fixture.detectChanges();
    (q('sso-discover') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el().textContent).toContain('The discovery document names issuer "x"');
  });

  it('creates with the id the URLs were made for, then opens the provider\'s edit page', async () => {
    await open(null);
    fillNew();
    save().click();
    fixture.detectChanges();
    expect(sso['create'].mock.calls[0][0]).toMatchObject({
      id: 'new-id-1', type: 'oidc', name: 'Corporate SSO', enabled: false,
      oidc: { clientSecret: 'the-secret', useDiscovery: true, tokenEndpoint: '' },
    });
    expect(router.navigate).toHaveBeenCalledWith(['/access/sso', 'p1', 'edit'], { replaceUrl: true });
    expect(fixture.componentInstance.canLeave()).toBe(true);
  });

  it('loads a saved provider, keeps its secret when left blank, and stays to test it', async () => {
    await open('p1');
    expect(sso['get']).toHaveBeenCalledWith('p1');
    expect(sso['setup']).toHaveBeenCalledWith('p1');
    expect(input('sso-client-secret').placeholder).toContain('saved');
    expect(save().textContent).toContain('Update provider');
    save().click();
    const body = sso['update'].mock.calls[0][1];
    expect(body.id).toBeUndefined();
    expect(body.oidc.clientSecret).toBeUndefined();
    expect(body.oidc.requiredClaims).toEqual([{ claim: 'hd', value: 'acme.com' }]);
    fixture.detectChanges();
    expect(toast['success']).toHaveBeenCalledWith('Provider updated');
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    expect(q('sso-cancel')!.textContent).toContain('Done');
    expect((q('sso-page-test') as HTMLButtonElement).disabled).toBe(false);
  });

  it('stays and says why when the provider was saved turned off', async () => {
    await open('p1');
    sso['update'].mockReturnValue(of({ provider: { ...SAVED, enabled: false }, validationError: 'Add at least one allowed sign-in domain' }));
    save().click();
    fixture.detectChanges();
    expect(q('sso-validation-error')!.textContent).toContain('Add at least one allowed sign-in domain');
    expect(toast['warning']).toHaveBeenCalled();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('tests the saved provider from its own panel, but not while there are unsaved changes', async () => {
    await open('p1');
    expect(q('sso-test-panel')!.textContent).toContain('Not tested yet');
    expect(q('sso-summary')!.textContent).not.toContain('Test sign-in');
    const test = q('sso-page-test') as HTMLButtonElement;
    expect(test.disabled).toBe(false);
    test.click();
    expect(tester.run).toHaveBeenCalledWith(SAVED);
    setValue(input('sso-name'), 'Renamed');
    fixture.detectChanges();
    expect((q('sso-page-test') as HTMLButtonElement).disabled).toBe(true);
    expect(q('sso-test-panel')!.textContent).toContain('Save your changes first');
  });

  it('asks before leaving with unsaved changes, and not otherwise', async () => {
    await open('p1');
    expect(fixture.componentInstance.canLeave()).toBe(true);
    setValue(input('sso-name'), 'Renamed');
    fixture.detectChanges();
    await expect(fixture.componentInstance.canLeave()).resolves.toBe(true);
    expect(confirm.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discard changes?' }));
  });

  it('says when the provider no longer exists', async () => {
    TestBed.resetTestingModule();
    await open('gone');
    sso['get'].mockReturnValue(throwError(() => ({ status: 404 })));
    fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    expect(el().textContent).toContain('Identity provider not found');
  });
});

describe('SigninSettingsComponent', () => {
  let fixture: ComponentFixture<SigninSettingsComponent>;
  let sso: Record<string, ReturnType<typeof vi.fn>>;

  async function setup() {
    sso = {
      signinSettings: vi.fn().mockReturnValue(of({ allowedDomains: ['hayageek.com'], allowUnlistedSso: true, ssoEnabled: true })),
      saveSigninSettings: vi.fn().mockReturnValue(of({ allowedDomains: ['hayageek.com', 'acme.io'], allowUnlistedSso: false, ssoEnabled: true })),
    };
    await TestBed.configureTestingModule({
      imports: [SigninSettingsComponent],
      providers: [
        { provide: SsoService, useValue: sso },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SigninSettingsComponent);
    fixture.detectChanges();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const saveButton = () => el().querySelector('[data-testid="signin-save"]') as HTMLButtonElement;

  it('shows the domains and saves a change', async () => {
    await setup();
    expect(el().textContent).toContain('hayageek.com');
    expect(saveButton().disabled).toBe(true);
    fixture.componentInstance.domains = ['hayageek.com', 'acme.io'];
    (el().querySelector('[data-testid="signin-unlisted"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(saveButton().disabled).toBe(false);
    saveButton().click();
    expect(sso['saveSigninSettings']).toHaveBeenCalledWith({ allowedDomains: ['hayageek.com', 'acme.io'], allowUnlistedSso: false });
  });

  it('will not save something that is not a domain', async () => {
    await setup();
    fixture.componentInstance.domains = ['hayageek.com', 'gmail'];
    fixture.detectChanges();
    expect(saveButton().disabled).toBe(true);
    expect(fixture.componentInstance.domainError('gmail')).toContain('Not a domain');
    expect(fixture.componentInstance.domainError('acme.io')).toBe('');
  });
});
