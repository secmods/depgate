import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import { onMounted, watch, nextTick } from 'vue';
import { useRoute } from 'vitepress';
import mediumZoom from 'medium-zoom';
import DiagramFrame from './components/DiagramFrame.vue';
import ArchitectureOverview from './components/ArchitectureOverview.vue';
import DeploymentDiagram from './components/DeploymentDiagram.vue';
import FlowDiagram from './components/FlowDiagram.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('DiagramFrame', DiagramFrame);
    app.component('ArchitectureOverview', ArchitectureOverview);
    app.component('DeploymentDiagram', DeploymentDiagram);
    app.component('FlowDiagram', FlowDiagram);
  },
  setup() {
    const route = useRoute();
    // Click a screenshot to see it full size.
    const zoom = () => mediumZoom('.vp-doc img:not(.no-zoom)', { background: 'var(--vp-c-bg)', margin: 24 });
    onMounted(zoom);
    watch(() => route.path, () => nextTick(zoom));
  },
} satisfies Theme;
