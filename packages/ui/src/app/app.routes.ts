import { CanDeactivateFn, Routes } from '@angular/router';
import { homeGuard, roleGuard } from './guards/auth.guard';

const security = roleGuard(['Security']);
const user = roleGuard(['User']);
const signedIn = roleGuard(['User', 'Security']);
/** The policy and identity provider forms ask before unsaved changes are lost. */
const leaveForm: CanDeactivateFn<{ canLeave(): boolean | Promise<boolean> }> = (form) => form.canLeave();

export const routes: Routes = [
  { path: '', pathMatch: 'full', canActivate: [homeGuard], children: [] },
  { path: 'login',
    title: 'Sign in · DepGate', loadComponent: () => import('./pages/login/login.component').then((m) => m.LoginComponent) },
  { path: 'login/sso',
    title: 'Signing in · DepGate', loadComponent: () => import('./pages/login/sso-complete.component').then((m) => m.SsoCompleteComponent) },
  { path: 'sso-test-done',
    title: 'Test finished · DepGate', loadComponent: () => import('./pages/login/sso-test-done.component').then((m) => m.SsoTestDoneComponent) },
  { path: 'forgot-password',
    title: 'Reset password · DepGate', loadComponent: () => import('./pages/login/forgot-password.component').then((m) => m.ForgotPasswordComponent) },
  { path: 'set-password',
    title: 'Set password · DepGate', loadComponent: () => import('./pages/login/set-password.component').then((m) => m.SetPasswordComponent) },
  {
    path: 'registry',
    title: 'Registry · DepGate',
    loadComponent: () => import('./pages/settings/settings.component').then((m) => m.SettingsComponent),
    canActivate: [signedIn],
  },
  {
    path: 'package-check',
    title: 'Package check · DepGate',
    loadComponent: () => import('./pages/package-check/package-check.component').then((m) => m.PackageCheckComponent),
    canActivate: [signedIn],
  },
  {
    path: 'waivers',
    title: 'Waiver requests · DepGate',
    loadComponent: () => import('./pages/waivers/waivers.component').then((m) => m.WaiversComponent),
    canActivate: [user],
  },
  {
    path: 'dashboard',
    title: 'Dashboard · DepGate',
    loadComponent: () => import('./pages/dashboard/dashboard.component').then((m) => m.DashboardComponent),
    canActivate: [security],
  },
  {
    path: 'malicious',
    title: 'Malware Packages · DepGate',
    loadComponent: () => import('./pages/malicious/malicious.component').then((m) => m.MaliciousComponent),
    canActivate: [security],
  },
  {
    path: 'policies',
    title: 'Policies · DepGate',
    loadComponent: () => import('./pages/policies/policies.component').then((m) => m.PoliciesComponent),
    canActivate: [security],
  },
  {
    path: 'policies/new',
    title: 'New policy · DepGate',
    loadComponent: () => import('./pages/policies/policy-form.component').then((m) => m.PolicyFormComponent),
    canActivate: [security],
    canDeactivate: [leaveForm],
  },
  {
    path: 'policies/:id/edit',
    title: 'Edit policy · DepGate',
    loadComponent: () => import('./pages/policies/policy-form.component').then((m) => m.PolicyFormComponent),
    canActivate: [security],
    canDeactivate: [leaveForm],
  },
  {
    path: 'monitoring',
    title: 'Monitoring · DepGate',
    loadComponent: () => import('./pages/monitoring/monitoring.component').then((m) => m.MonitoringComponent),
    canActivate: [security],
  },
  {
    path: 'monitoring/:id',
    title: 'Monitoring report · DepGate',
    loadComponent: () => import('./pages/monitoring/monitoring-detail.component').then((m) => m.MonitoringDetailComponent),
    canActivate: [security],
  },
  {
    path: 'audit',
    title: 'Decision Ledger · DepGate',
    loadComponent: () => import('./pages/audit/audit.component').then((m) => m.AuditComponent),
    canActivate: [security],
  },
  {
    path: 'audit/log',
    title: 'Audit Log · DepGate',
    loadComponent: () => import('./pages/audit/audit-log.component').then((m) => m.AuditLogComponent),
    canActivate: [security],
  },
  {
    path: 'audit/jobs',
    title: 'Jobs & Feeds · DepGate',
    loadComponent: () => import('./pages/audit/jobs-feeds.component').then((m) => m.JobsFeedsComponent),
    canActivate: [security],
  },
  {
    path: 'exceptions',
    title: 'Exceptions · DepGate',
    loadComponent: () => import('./pages/exceptions/exceptions.component').then((m) => m.ExceptionsComponent),
    canActivate: [security],
  },
  {
    path: 'access/sso/new',
    title: 'Add identity provider · DepGate',
    loadComponent: () => import('./pages/access/sso-provider-page.component').then((m) => m.SsoProviderPageComponent),
    canActivate: [security],
    canDeactivate: [leaveForm],
  },
  {
    path: 'access/sso/:id/edit',
    title: 'Edit identity provider · DepGate',
    loadComponent: () => import('./pages/access/sso-provider-page.component').then((m) => m.SsoProviderPageComponent),
    canActivate: [security],
    canDeactivate: [leaveForm],
  },
  {
    path: 'access',
    title: 'Access · DepGate',
    loadComponent: () => import('./pages/access/access.component').then((m) => m.AccessComponent),
    canActivate: [security],
  },
  {
    path: 'settings',
    title: 'Settings · DepGate',
    loadComponent: () => import('./pages/settings/settings.component').then((m) => m.SettingsComponent),
    canActivate: [security],
  },
  {
    path: 'settings/log-streaming/new',
    title: 'Add destination · DepGate',
    loadComponent: () => import('./pages/settings/stream-destination-form.component').then((m) => m.StreamDestinationFormComponent),
    canActivate: [security],
    canDeactivate: [leaveForm],
  },
  {
    path: 'settings/log-streaming/:id/edit',
    title: 'Edit destination · DepGate',
    loadComponent: () => import('./pages/settings/stream-destination-form.component').then((m) => m.StreamDestinationFormComponent),
    canActivate: [security],
    canDeactivate: [leaveForm],
  },
  {
    path: 'settings/repositories/new',
    title: 'Add repository · DepGate',
    loadComponent: () => import('./pages/settings/repository-form.component').then((m) => m.RepositoryFormComponent),
    canActivate: [security],
    canDeactivate: [leaveForm],
  },
  {
    path: 'settings/repositories/:id/edit',
    title: 'Edit repository · DepGate',
    loadComponent: () => import('./pages/settings/repository-form.component').then((m) => m.RepositoryFormComponent),
    canActivate: [security],
    canDeactivate: [leaveForm],
  },
  { path: '**', canActivate: [homeGuard], children: [] },
];
