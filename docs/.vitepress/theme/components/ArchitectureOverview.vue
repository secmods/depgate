<script setup lang="ts">
import DiagramIcon from './DiagramIcon.vue';

const checks = [
  { icon: 'virus', label: 'Malware list' },
  { icon: 'lock', label: 'Namespace protection' },
  { icon: 'shield', label: 'Vulnerabilities', note: 'CVSS · EPSS' },
  { icon: 'ledger', label: 'Licenses' },
  { icon: 'package', label: 'Release age and type' },
  { icon: 'chart', label: 'Project health', note: 'Scorecard' },
];

const feeds = [
  { title: 'OSV', note: 'vulnerabilities' },
  { title: 'EPSS', note: 'exploit likelihood' },
  { title: 'Malware feed', note: 'OpenSSF' },
  { title: 'Scorecard', note: 'project health' },
];

const decisions = [
  { pkg: 'flatmap-stream 0.1.1', verdict: 'Blocked · known malware', ok: false },
  { pkg: 'log4j-core 2.14.1', verdict: 'Blocked · CVSS 10.0 (Log4Shell)', ok: false },
  { pkg: '@acme/billing (public)', verdict: 'Blocked · dependency confusion', ok: false },
  { pkg: 'express 4.21.2', verdict: 'Allowed · passes every check', ok: true },
];

const laneY = (i: number) => 404 + i * 36;
</script>

<template>
  <svg class="dg-svg" viewBox="0 0 880 618" role="img"
    aria-label="Developer machines and CI runners request packages through DepGate, which checks them against the malware list and your policies before fetching them from internal and public registries. Malicious, vulnerable and look-alike packages are blocked; safe packages are installed.">
    <defs>
      <marker id="ao-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="dg-arrowhead" d="M0 0L10 5L0 10z" />
      </marker>
      <marker id="ao-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="dg-arrowhead-bad" d="M0 0L10 5L0 10z" />
      </marker>
      <marker id="ao-arrow-good" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="dg-arrowhead-good" d="M0 0L10 5L0 10z" />
      </marker>
    </defs>

    <!-- Threat intelligence feeds -->
    <text class="dg-eyebrow" x="440" y="14" text-anchor="middle">THREAT INTELLIGENCE</text>
    <g v-for="(feed, i) in feeds" :key="feed.title">
      <rect class="dg-chip" :x="189 + i * 128" y="22" width="118" height="42" rx="8" />
      <text class="dg-strong" :x="248 + i * 128" y="40" text-anchor="middle">{{ feed.title }}</text>
      <text class="dg-small" :x="248 + i * 128" y="56" text-anchor="middle">{{ feed.note }}</text>
      <path class="dg-line dg-dashed" :d="`M${248 + i * 128} 64V82`" />
    </g>
    <path class="dg-line dg-dashed" d="M248 82H632" />
    <path class="dg-line dg-dashed" d="M440 82V100" marker-end="url(#ao-arrow)" />

    <!-- Your teams -->
    <rect class="dg-box" x="16" y="104" width="190" height="236" rx="12" />
    <text class="dg-title" x="34" y="134">Your teams</text>
    <DiagramIcon name="laptop" :x="34" :y="152" :size="22" />
    <text class="dg-body" x="64" y="168">Developer laptops</text>
    <DiagramIcon name="pipeline" :x="34" :y="188" :size="22" />
    <text class="dg-body" x="64" y="204">CI/CD runners</text>
    <path class="dg-divider" d="M34 228H188" />
    <text class="dg-small" x="34" y="250">npm · Yarn · pnpm · pip</text>
    <text class="dg-small" x="34" y="268">Maven · Gradle · Go</text>
    <text class="dg-small" x="34" y="286">NuGet · Cargo</text>
    <text class="dg-small" x="34" y="304">Composer · Bundler</text>

    <!-- DepGate -->
    <rect class="dg-gate" x="310" y="104" width="260" height="440" rx="14" />
    <DiagramIcon name="shield" :x="328" :y="118" :size="28" class="dg-icon-brand" />
    <text class="dg-gate-title" x="364" y="137">DepGate</text>
    <text class="dg-small" x="364" y="153">Checks every version first</text>
    <g v-for="(check, i) in checks" :key="check.label">
      <rect class="dg-row" x="326" :y="166 + i * 32" width="228" height="26" rx="6" />
      <DiagramIcon :name="check.icon" :x="334" :y="171 + i * 32" :size="16" class="dg-icon-brand" />
      <text class="dg-body" x="358" :y="184 + i * 32">{{ check.label }}</text>
      <text v-if="check.note" class="dg-small" x="546" :y="184 + i * 32" text-anchor="end">{{ check.note }}</text>
    </g>
    <path class="dg-divider" d="M326 370H554" />
    <text class="dg-eyebrow" x="440" y="388" text-anchor="middle">DECISIONS</text>

    <!-- Registries -->
    <rect class="dg-box" x="674" y="104" width="190" height="236" rx="12" />
    <text class="dg-title" x="692" y="134">Registries</text>
    <DiagramIcon name="building" :x="692" :y="146" :size="18" class="dg-icon-internal" />
    <text class="dg-label-internal" x="716" y="160">Internal</text>
    <text class="dg-body" x="716" y="180">JFrog Artifactory</text>
    <text class="dg-body" x="716" y="198">Sonatype Nexus</text>
    <text class="dg-body" x="716" y="216">GitHub Packages</text>
    <DiagramIcon name="globe" :x="692" :y="232" :size="18" />
    <text class="dg-label" x="716" y="246">Public</text>
    <text class="dg-small" x="716" y="266">npmjs · PyPI</text>
    <text class="dg-small" x="716" y="284">Maven Central · Go</text>
    <text class="dg-small" x="716" y="302">NuGet · crates.io</text>
    <text class="dg-small" x="716" y="320">Packagist · RubyGems</text>

    <!-- Request and response arrows -->
    <path class="dg-line" d="M206 186H306" marker-end="url(#ao-arrow)" />
    <text class="dg-small" x="258" y="178" text-anchor="middle">request</text>
    <path class="dg-line" d="M310 246H210" marker-end="url(#ao-arrow)" />
    <text class="dg-small" x="258" y="238" text-anchor="middle">allowed only</text>
    <path class="dg-line" d="M570 186H670" marker-end="url(#ao-arrow)" />
    <text class="dg-small" x="622" y="178" text-anchor="middle">fetch</text>
    <path class="dg-line" d="M674 246H574" marker-end="url(#ao-arrow)" />
    <text class="dg-small" x="622" y="238" text-anchor="middle">packages</text>

    <!-- What happens to each package -->
    <text class="dg-eyebrow" x="16" y="388">WHAT YOUR BUILD GETS</text>
    <text class="dg-eyebrow" x="864" y="388" text-anchor="end">FROM UPSTREAM</text>
    <g v-for="(d, i) in decisions" :key="d.pkg">
      <rect :class="d.ok ? 'dg-good' : 'dg-bad-outline'" x="16" :y="laneY(i) - 14" width="190" height="28" rx="14" />
      <DiagramIcon :name="d.ok ? 'check' : 'cross'" :x="26" :y="laneY(i) - 8" :size="16" :class="d.ok ? 'dg-icon-good' : 'dg-icon-bad'" />
      <text :class="d.ok ? 'dg-text-good' : 'dg-text-bad'" x="48" :y="laneY(i) + 4.5">{{ d.ok ? 'Installed' : 'Fails with a reason' }}</text>
      <path :class="d.ok ? 'dg-line-good' : 'dg-line-bad'" :d="`M310 ${laneY(i)}H210`" :marker-end="d.ok ? 'url(#ao-arrow-good)' : 'url(#ao-arrow-bad)'" />

      <rect :class="d.ok ? 'dg-good' : 'dg-bad'" x="326" :y="laneY(i) - 14" width="228" height="28" rx="6" />
      <text :class="d.ok ? 'dg-text-good' : 'dg-text-bad'" x="440" :y="laneY(i) + 4.5" text-anchor="middle">{{ d.verdict }}</text>

      <path class="dg-line" :d="`M674 ${laneY(i)}H574`" marker-end="url(#ao-arrow)" />
      <rect class="dg-pill" x="674" :y="laneY(i) - 14" width="190" height="28" rx="14" />
      <text class="dg-mono" x="769" :y="laneY(i) + 4.5" text-anchor="middle">{{ d.pkg }}</text>
    </g>

    <!-- Evidence -->
    <path class="dg-line dg-dashed" d="M375 544V566" marker-end="url(#ao-arrow)" />
    <path class="dg-line dg-dashed" d="M520 544V566" marker-end="url(#ao-arrow)" />
    <rect class="dg-chip" x="280" y="570" width="190" height="40" rx="8" />
    <DiagramIcon name="ledger" :x="294" :y="580" :size="20" />
    <text class="dg-body" x="322" y="595">Decision Ledger</text>
    <rect class="dg-chip" x="478" y="570" width="214" height="40" rx="8" />
    <DiagramIcon name="bell" :x="492" :y="580" :size="20" />
    <text class="dg-body" x="520" y="595">Webhooks · SIEM, Slack</text>
  </svg>
</template>
