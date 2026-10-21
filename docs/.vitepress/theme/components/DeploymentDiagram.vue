<script setup lang="ts">
import DiagramIcon from './DiagramIcon.vue';

const outbound = [
  { y: 120, h: 70, icon: 'globe', title: 'Registries', lines: ['Public and internal'] },
  { y: 206, h: 78, icon: 'feed', title: 'Data feeds', lines: ['OSV · EPSS · Scorecard', 'malware feed · deps.dev'] },
  { y: 300, h: 70, icon: 'mail', title: 'Notifications', lines: ['SMTP · webhooks'] },
];
</script>

<template>
  <svg class="dg-svg" viewBox="0 86 880 376" role="img"
    aria-label="Developer laptops and CI runners connect over HTTPS, optionally through a load balancer, to stateless DepGate replicas. The replicas use PostgreSQL and Redis, expose metrics to Prometheus on a private port, and connect out to registries, data feeds and notification targets, optionally through an outbound proxy.">
    <defs>
      <marker id="dd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="dg-arrowhead" d="M0 0L10 5L0 10z" />
      </marker>
    </defs>

    <!-- Your infrastructure -->
    <rect class="dg-zone" x="226" y="110" width="424" height="342" rx="14" />
    <text class="dg-eyebrow" x="242" y="132">YOUR INFRASTRUCTURE</text>

    <!-- Clients -->
    <rect class="dg-box" x="16" y="150" width="172" height="150" rx="12" />
    <text class="dg-title" x="32" y="178">Clients</text>
    <DiagramIcon name="laptop" :x="32" :y="196" :size="22" />
    <text class="dg-body" x="62" y="212">Developer laptops</text>
    <DiagramIcon name="pipeline" :x="32" :y="234" :size="22" />
    <text class="dg-body" x="62" y="250">CI/CD runners</text>
    <text class="dg-small" x="32" y="282">package managers</text>

    <path class="dg-line" d="M188 225H240" marker-end="url(#dd-arrow)" />
    <text class="dg-small" x="215" y="216" text-anchor="middle">HTTPS</text>

    <!-- Load balancer -->
    <rect class="dg-box dg-optional" x="244" y="186" width="140" height="78" rx="10" />
    <DiagramIcon name="balancer" :x="254" :y="200" :size="22" />
    <text class="dg-strong" x="281" y="216">Load balancer</text>
    <text class="dg-small" x="256" y="246">TLS · optional</text>

    <path class="dg-line" d="M384 225H426" marker-end="url(#dd-arrow)" />

    <!-- DepGate replicas -->
    <rect class="dg-gate dg-stack" x="446" y="138" width="180" height="150" rx="12" />
    <rect class="dg-gate dg-stack" x="438" y="144" width="180" height="150" rx="12" />
    <rect class="dg-solid" x="430" y="150" width="180" height="150" rx="12" />
    <rect class="dg-gate" x="430" y="150" width="180" height="150" rx="12" />
    <DiagramIcon name="shield" :x="446" :y="164" :size="26" class="dg-icon-brand" />
    <text class="dg-gate-title" x="480" y="183">DepGate</text>
    <text class="dg-body" x="446" y="214">Web interface</text>
    <text class="dg-body" x="446" y="234">REST API</text>
    <text class="dg-body" x="446" y="254">Package registries</text>
    <text class="dg-small" x="446" y="282">stateless · one or more</text>

    <!-- Data stores -->
    <path class="dg-line" d="M465 300V348" marker-end="url(#dd-arrow)" />
    <path class="dg-line" d="M585 300V348" marker-end="url(#dd-arrow)" />
    <rect class="dg-box" x="410" y="352" width="110" height="84" rx="10" />
    <DiagramIcon name="database" :x="422" :y="364" :size="20" />
    <text class="dg-strong" x="422" y="402">PostgreSQL</text>
    <text class="dg-small" x="422" y="420">policies, ledger</text>
    <rect class="dg-box" x="530" y="352" width="110" height="84" rx="10" />
    <DiagramIcon name="database" :x="542" :y="364" :size="20" />
    <text class="dg-strong" x="542" y="402">Redis</text>
    <text class="dg-small" x="542" y="420">cache, jobs</text>

    <!-- Monitoring -->
    <rect class="dg-box" x="244" y="352" width="140" height="84" rx="10" />
    <DiagramIcon name="chart" :x="256" :y="364" :size="20" />
    <text class="dg-strong" x="256" y="402">Prometheus</text>
    <text class="dg-small" x="256" y="420">metrics · port 9464</text>
    <path class="dg-line dg-dashed" d="M384 380H400V276H426" marker-end="url(#dd-arrow)" />

    <!-- Outbound -->
    <text class="dg-small" x="660" y="100" text-anchor="middle">outbound proxy (optional)</text>
    <path class="dg-line" d="M610 225H660" />
    <path class="dg-line" d="M660 155V335" />
    <g v-for="box in outbound" :key="box.title">
      <path class="dg-line" :d="`M660 ${box.y + box.h / 2}H686`" marker-end="url(#dd-arrow)" />
      <rect class="dg-box" x="690" :y="box.y" width="174" :height="box.h" rx="10" />
      <DiagramIcon :name="box.icon" :x="702" :y="box.y + 12" :size="20" />
      <text class="dg-strong" x="730" :y="box.y + 27">{{ box.title }}</text>
      <text v-for="(line, i) in box.lines" :key="line" class="dg-small" x="702" :y="box.y + 52 + i * 17">{{ line }}</text>
    </g>
  </svg>
</template>
