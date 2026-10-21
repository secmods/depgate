<script setup lang="ts">
/** 24×24 line icons for the diagrams, drawn at (x, y) with the given size. */
defineProps<{ name: string; x: number; y: number; size?: number }>();
</script>

<template>
  <g class="dg-icon" :transform="`translate(${x} ${y}) scale(${(size ?? 24) / 24})`">
    <template v-if="name === 'laptop'"><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></template>
    <template v-else-if="name === 'pipeline'"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12.5 15H17" /></template>
    <template v-else-if="name === 'shield'"><path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.4-7.5 10-4.4-1.6-7.5-5.4-7.5-10V6z" /><path d="M8.5 12.2l2.4 2.4 4.6-4.8" /></template>
    <template v-else-if="name === 'globe'"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></template>
    <template v-else-if="name === 'building'"><rect x="5" y="3" width="14" height="18" rx="1" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M11 21v-3h2v3" /></template>
    <template v-else-if="name === 'database'"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.5" /><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" /></template>
    <template v-else-if="name === 'package'"><path d="M12 2.5l8.5 4.7v9.6L12 21.5l-8.5-4.7V7.2z" /><path d="M3.5 7.2L12 12l8.5-4.8M12 12v9.5" /></template>
    <template v-else-if="name === 'ledger'"><path d="M6 2.5h8.5l4 4v15H6z" /><path d="M14.5 2.5v4h4M9 11h6M9 14.5h6M9 18h4" /></template>
    <template v-else-if="name === 'bell'"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.8 1.8H4.2z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></template>
    <template v-else-if="name === 'feed'"><circle cx="5.5" cy="18.5" r="1.6" /><path d="M4 11.5a8.5 8.5 0 0 1 8.5 8.5M4 4.5A15.5 15.5 0 0 1 19.5 20" /></template>
    <template v-else-if="name === 'lock'"><rect x="5" y="10.5" width="14" height="10.5" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></template>
    <template v-else-if="name === 'balancer'"><circle cx="5" cy="12" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="19" cy="19" r="2" /><path d="M7 12h4l6-6M11 12l6 6" /></template>
    <template v-else-if="name === 'proxy'"><path d="M4 8h13l-3-3M20 16H7l3 3" /></template>
    <template v-else-if="name === 'chart'"><path d="M3 21h18M6 21v-7M11 21V5M16 21v-10M21 21v-4" /></template>
    <template v-else-if="name === 'mail'"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5l8.5 6.5 8.5-6.5" /></template>
    <template v-else-if="name === 'virus'"><circle cx="12" cy="12" r="5" /><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.9 2.9M15.5 15.5l2.9 2.9M5.6 18.4l2.9-2.9M15.5 8.5l2.9-2.9" /></template>
    <template v-else-if="name === 'check'"><circle cx="12" cy="12" r="9" /><path d="M8 12.3l2.7 2.7 5.3-5.6" /></template>
    <template v-else-if="name === 'cross'"><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></template>
  </g>
</template>
