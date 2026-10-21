<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';

defineProps<{ caption?: string }>();
const open = ref(false);
const close = (event: KeyboardEvent) => {
  if (event.key === 'Escape') open.value = false;
};
watch(open, (value) => {
  if (typeof window === 'undefined') return;
  if (value) window.addEventListener('keydown', close);
  else window.removeEventListener('keydown', close);
});
onBeforeUnmount(() => typeof window !== 'undefined' && window.removeEventListener('keydown', close));
</script>

<template>
  <figure class="dg-figure">
    <button type="button" class="dg-canvas" aria-label="Enlarge diagram" @click="open = true">
      <slot />
    </button>
    <figcaption v-if="caption">{{ caption }}<span class="dg-hint">Click to enlarge</span></figcaption>
  </figure>
  <Teleport to="body">
    <div v-if="open" class="dg-overlay" role="dialog" aria-modal="true" @click="open = false">
      <div class="dg-overlay-inner"><slot /></div>
    </div>
  </Teleport>
</template>
