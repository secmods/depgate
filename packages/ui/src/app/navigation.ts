export interface NavItem {
  label: string;
  icon: string;
  route: string;
  /** A count shown next to the label, hidden at zero. */
  badge?: 'monitoring';
  /** Leaves the Angular app: Swagger UI at /api/docs and the documentation site. */
  external?: boolean;
  /** Active only on this exact route, not on routes below it (`/audit` vs `/audit/log`). */
  exact?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const SECURITY_NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', icon: 'monitoring', route: '/dashboard' }],
  },
  {
    label: 'Security',
    items: [
      { label: 'Malware Packages', icon: 'bug_report', route: '/malicious' },
      { label: 'Policies', icon: 'policy', route: '/policies' },
      { label: 'Package check', icon: 'fact_check', route: '/package-check' },
      { label: 'Monitoring', icon: 'visibility', route: '/monitoring', badge: 'monitoring' },
      { label: 'Exceptions', icon: 'rule', route: '/exceptions' },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Decision Ledger', icon: 'receipt_long', route: '/audit', exact: true },
      { label: 'Audit Log', icon: 'manage_history', route: '/audit/log' },
      { label: 'Jobs & Feeds', icon: 'schedule', route: '/audit/jobs' },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Registry', icon: 'hub', route: '/registry' },
      { label: 'Access', icon: 'group', route: '/access' },
      { label: 'Settings', icon: 'settings', route: '/settings' },
    ],
  },
];

export const USER_NAV: NavGroup[] = [
  {
    label: 'Packages',
    items: [{ label: 'Package check', icon: 'fact_check', route: '/package-check' }],
  },
  {
    label: 'Setup',
    items: [{ label: 'Registry', icon: 'hub', route: '/registry' }],
  },
  {
    label: 'Access',
    items: [{ label: 'Waiver requests', icon: 'approval', route: '/waivers' }],
  },
];

/** Shown to both roles at the bottom of the sidebar. Documentation is left out when DOCS_URL is unset. */
export function helpNav(docsUrl: string): NavGroup {
  const items: NavItem[] = [];
  if (docsUrl) items.push({ label: 'Documentation', icon: 'menu_book', route: docsUrl, external: true });
  items.push({ label: 'API docs', icon: 'api', route: '/api/docs', external: true });
  return { label: 'Help', items };
}

/** Section, page label and page route for a URL, for the header breadcrumb. */
export function locate(groups: NavGroup[], url: string): { group: string; page: string; route: string } | null {
  const path = url.split(/[?#]/)[0];
  // The longest matching route wins, so /audit/log is the Audit Log, not the Decision Ledger.
  let best: { group: string; page: string; route: string } | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (path === item.route || path.startsWith(item.route + '/')) {
        if (!best || item.route.length > best.route.length) best = { group: group.label, page: item.label, route: item.route };
      }
    }
  }
  return best;
}
