import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { vi } from 'vitest';
import { ConfigService } from './config.service';
import { AuthService } from './auth.service';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

describe('ConfigService', () => {
  let service: ConfigService;
  let httpMock: HttpTestingController;
  let authService: { getToken: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    const authMock = {
      getToken: vi.fn().mockReturnValue('test-token'),
    };

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        ConfigService,
        { provide: AuthService, useValue: authMock },
      ],
    });

    service = TestBed.inject(ConfigService);
    httpMock = TestBed.inject(HttpTestingController);
    authService = TestBed.inject(AuthService) as unknown as { getToken: ReturnType<typeof vi.fn> };
  });

  afterEach(() => {
    httpMock?.verify();
  });

  it('getGateway returns the gateway config', () => {
    service.getGateway().subscribe((cfg) => {
      expect(cfg.baseUrl).toBe('http://localhost:3050');
      expect(cfg.sessionTokenDays).toBe(30);
    });

    const req = httpMock.expectOne('/api/admin/config/gateway');
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Authorization')).toBe('Bearer test-token');
    req.flush({
      baseUrl: 'http://localhost:3050',
      sessionTokenDays: 30,
      namespaceCollisionCheck: false,
    });
  });

  it('updateGateway sends the namespace collision toggle payload', () => {
    service.updateGateway({ namespaceCollisionCheck: true }).subscribe((cfg) => {
      expect(cfg.namespaceCollisionCheck).toBe(true);
    });

    const req = httpMock.expectOne('/api/admin/config/gateway');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ namespaceCollisionCheck: true });
    req.flush({
      baseUrl: 'http://localhost:3050',
      sessionTokenDays: 30,
      namespaceCollisionCheck: true,
    });
    expect(authService.getToken).toHaveBeenCalled();
  });
});
