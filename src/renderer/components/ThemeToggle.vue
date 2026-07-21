<script setup lang="ts">
import { computed } from 'vue'

import { useTheme } from '../composables/use-theme'

const { theme, toggleTheme } = useTheme()
const label = computed(() => (theme.value === 'light' ? '切换到深色模式' : '切换到浅色模式'))
</script>

<template>
  <button
    class="theme-toggle"
    type="button"
    :aria-label="label"
    :title="label"
    @click="toggleTheme"
  >
    <svg v-if="theme === 'light'" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.4 15.2A8.5 8.5 0 0 1 8.8 3.6 8.5 8.5 0 1 0 20.4 15.2Z" />
    </svg>
    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.8" />
      <path
        d="M12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6m11 11 1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6m11-11 1.6-1.6"
      />
    </svg>
  </button>
</template>

<style scoped>
.theme-toggle {
  display: inline-grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  padding: 0;
  place-items: center;
  border: 1px solid var(--app-border);
  border-radius: 11px;
  color: var(--app-text-muted);
  background: var(--app-surface);
  cursor: pointer;
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    background 0.2s ease;
}

.theme-toggle:hover {
  border-color: var(--app-primary);
  color: var(--app-primary);
  background: var(--app-primary-soft);
}

.theme-toggle:focus-visible {
  outline: 3px solid var(--app-focus-ring);
  outline-offset: 2px;
}

.theme-toggle svg {
  width: 19px;
  height: 19px;
  fill: none;
  stroke: currentcolor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}
</style>
