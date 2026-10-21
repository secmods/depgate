import { defineConfig } from 'vitepress';

// GitHub Pages project sites are served from /<repo>/; CI sets DOCS_BASE accordingly.
const base = process.env.DOCS_BASE || '/';

export default defineConfig({
  base,
  title: 'DepGate',
  description: 'Control what enters your software supply chain: a proxy and policy engine for npm, PyPI, Maven, Go, NuGet, Cargo, Composer and RubyGems.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: false,
  // Internal working files that live in this folder but are not part of the site.
  srcExclude: ['scripts/**', 'README.md'],
  // localhost addresses in the text are for the reader's own machine.
  ignoreDeadLinks: 'localhostLinks',
  head: [
    // head tags are emitted verbatim, so the base has to be added by hand.
    ['link', { rel: 'icon', href: `${base}favicon.ico` }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
  ],
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'DepGate',
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    nav: [
      { text: 'Guide', link: '/guide/what-is-depgate', activeMatch: '/guide/' },
      { text: 'Installation', link: '/install/requirements', activeMatch: '/install/' },
      { text: 'Developers', link: '/developers/connect-package-managers', activeMatch: '/developers/' },
      { text: 'Administration', link: '/admin/dashboard', activeMatch: '/admin/' },
      { text: 'Reference', link: '/reference/configuration', activeMatch: '/reference/' },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'What is DepGate?', link: '/guide/what-is-depgate' },
          { text: 'Architecture', link: '/guide/architecture' },
          { text: 'How DepGate works', link: '/guide/how-it-works' },
          { text: 'Quick start', link: '/guide/quick-start' },
        ],
      },
      {
        text: 'Installation',
        items: [
          { text: 'Requirements', link: '/install/requirements' },
          { text: 'Install with Docker', link: '/install/docker' },
          { text: 'Install on Kubernetes', link: '/install/kubernetes' },
          { text: 'HTTPS and networking', link: '/install/https-and-networking' },
          { text: 'Build from source', link: '/install/build-from-source' },
          { text: 'Database migrations', link: '/install/database-migrations' },
          { text: 'Operate and upgrade', link: '/install/operations' },
        ],
      },
      {
        text: 'For developers',
        items: [
          { text: 'Connect your package manager', link: '/developers/connect-package-managers' },
          { text: 'Check a package', link: '/developers/package-check' },
          { text: 'Request a waiver', link: '/developers/waiver-requests' },
          { text: 'CI/CD pipelines', link: '/developers/ci-pipelines' },
        ],
      },
      {
        text: 'Security policies',
        items: [
          { text: 'Dashboard', link: '/admin/dashboard' },
          { text: 'Policies overview', link: '/admin/policies' },
          { text: 'Create a policy', link: '/admin/create-policy' },
          { text: 'Policy rules', link: '/admin/policy-rules' },
          { text: 'Monitor before enforcing', link: '/admin/monitoring' },
          { text: 'Exceptions and waivers', link: '/admin/exceptions' },
          { text: 'Malware packages', link: '/admin/malware' },
          { text: 'Namespace protection', link: '/admin/namespace-protection' },
          { text: 'Decision Ledger', link: '/admin/decision-ledger' },
          { text: 'Audit Log', link: '/admin/audit-log' },
        ],
      },
      {
        text: 'Administration',
        items: [
          { text: 'Repositories', link: '/admin/repositories' },
          { text: 'Artifact cache', link: '/admin/artifact-cache' },
          { text: 'Access', link: '/admin/users' },
          { text: 'Single sign-on', link: '/admin/sso' },
          { text: 'Email', link: '/admin/email' },
          { text: 'Webhooks', link: '/admin/webhooks' },
          { text: 'Log streaming', link: '/admin/log-streaming' },
          { text: 'Jobs and data feeds', link: '/admin/jobs' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'REST API', link: '/reference/api' },
          { text: 'Troubleshooting', link: '/reference/troubleshooting' },
          { text: 'Glossary', link: '/reference/glossary' },
        ],
      },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'DepGate',
    },
    docFooter: { prev: 'Previous', next: 'Next' },
  },
});
