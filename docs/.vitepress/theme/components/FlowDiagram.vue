<script setup lang="ts">
import { computed } from 'vue';
import DiagramIcon from './DiagramIcon.vue';

/**
 * A left-to-right chain of boxes. Each column is one node, or several stacked nodes that the
 * previous column fans out to. `labels[i]` is written on the arrows between column i and i + 1.
 */
type Kind = 'client' | 'pipeline' | 'gate' | 'internal' | 'public' | 'cache' | 'blocked';
interface FlowNode { title: string; lines?: string[]; kind?: Kind; icon?: string }

const props = defineProps<{ columns: (FlowNode | FlowNode[])[]; labels?: string[]; label?: string }>();

const WIDTH = 1000;
const GAP = 104;
const LINE = 18;
const STACK_GAP = 14;
const TOP = 30;

const icons: Record<Kind, string> = {
  client: 'laptop', pipeline: 'pipeline', gate: 'shield', internal: 'building', public: 'globe', cache: 'database', blocked: 'cross',
};
const boxClass: Record<Kind, string> = {
  client: 'dg-box', pipeline: 'dg-box', gate: 'dg-gate', internal: 'dg-internal', public: 'dg-box', cache: 'dg-box', blocked: 'dg-bad',
};

const layout = computed(() => {
  const cols = props.columns.map((c) => (Array.isArray(c) ? c : [c]));
  const n = cols.length;
  const w = Math.min(250, (WIDTH - 32 - (n - 1) * GAP) / n);
  const left = (WIDTH - (n * w + (n - 1) * GAP)) / 2;
  const heightOf = (node: FlowNode) => 78 + (node.lines?.length ?? 0) * LINE;
  const colHeight = (col: FlowNode[]) => col.reduce((sum, node) => sum + heightOf(node), 0) + (col.length - 1) * STACK_GAP;
  const inner = Math.max(...cols.map(colHeight));
  const mid = TOP + inner / 2;
  const boxes = cols.map((col, i) => {
    let y = mid - colHeight(col) / 2;
    return col.map((node) => {
      const kind = node.kind ?? 'client';
      const box = { ...node, kind, x: left + i * (w + GAP), y, w, h: heightOf(node), icon: node.icon ?? icons[kind], cls: boxClass[kind] };
      y += box.h + STACK_GAP;
      return box;
    });
  });
  const edges = [] as { d: string; bad: boolean; end: { x: number; y: number } }[];
  const edgeLabels = [] as { x: number; y: number; text: string }[];
  for (let i = 0; i < boxes.length - 1; i++) {
    const xm = boxes[i][0].x + w + GAP / 2;
    let top = Infinity;
    for (const a of boxes[i]) {
      for (const b of boxes[i + 1]) {
        const y1 = a.y + a.h / 2;
        const y2 = b.y + b.h / 2;
        const x1 = a.x + w;
        const x2 = b.x - 4;
        top = Math.min(top, y1, y2);
        const bad = b.kind === 'blocked';
        // A blocked branch starts at the fork, so it never recolors the shared trunk.
        const d = bad ? `M${xm} ${y1}V${y2}H${x2 - 6}` : y1 === y2 ? `M${x1} ${y1}H${x2}` : `M${x1} ${y1}H${xm}V${y2}H${x2}`;
        edges.push({ d, bad, end: { x: x2 - 6, y: y2 } });
      }
    }
    if (props.labels?.[i]) edgeLabels.push({ x: xm, y: top - 9, text: props.labels[i] });
  }
  return { boxes: boxes.flat(), edges, edgeLabels, height: TOP + inner + 18 };
});
</script>

<template>
  <svg class="dg-svg" :viewBox="`0 0 ${WIDTH} ${layout.height}`" role="img" :aria-label="label">
    <defs>
      <marker id="fd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="dg-arrowhead" d="M0 0L10 5L0 10z" />
      </marker>
    </defs>
    <path v-for="(edge, i) in layout.edges.filter((e) => !e.bad)" :key="`e${i}`" class="dg-line" :d="edge.d" marker-end="url(#fd-arrow)" />
    <g v-for="(edge, i) in layout.edges.filter((e) => e.bad)" :key="`x${i}`">
      <path class="dg-line-bad dg-dashed" :d="edge.d" />
      <circle class="dg-stop" :cx="edge.end.x" :cy="edge.end.y" r="8" />
      <path class="dg-stop-x" :d="`M${edge.end.x - 3.5} ${edge.end.y - 3.5}l7 7m0 -7l-7 7`" />
    </g>
    <text v-for="(l, i) in layout.edgeLabels" :key="`l${i}`" class="dg-small" :x="l.x" :y="l.y" text-anchor="middle">{{ l.text }}</text>
    <g v-for="(box, i) in layout.boxes" :key="`b${i}`">
      <rect :class="box.cls" :x="box.x" :y="box.y" :width="box.w" :height="box.h" rx="12" />
      <DiagramIcon :name="box.icon" :x="box.x + 16" :y="box.y + 14" :size="22"
        :class="{ 'dg-icon-brand': box.kind === 'gate', 'dg-icon-internal': box.kind === 'internal', 'dg-icon-bad': box.kind === 'blocked' }" />
      <text :class="box.kind === 'gate' ? 'dg-gate-title dg-gate-title-sm' : box.kind === 'blocked' ? 'dg-text-bad dg-strong' : 'dg-strong'"
        :x="box.x + 16" :y="box.y + 58">{{ box.title }}</text>
      <text v-for="(line, j) in box.lines ?? []" :key="line" :class="box.kind === 'blocked' ? 'dg-text-bad dg-small' : 'dg-small'"
        :x="box.x + 16" :y="box.y + 80 + j * LINE">{{ line }}</text>
    </g>
  </svg>
</template>
