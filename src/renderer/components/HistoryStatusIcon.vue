<script setup lang="ts">
import type { TransferStatus } from '@shared/types'

defineProps<{ readonly status: TransferStatus }>()
</script>

<template>
  <span class="status-icon" :class="`is-${status}`" aria-hidden="true">
    <svg viewBox="0 0 20 20" focusable="false">
      <path v-if="status === 'completed' || status === 'accepted'" d="m5.4 10.2 2.9 2.9 6.4-6.4" />
      <template v-else-if="status === 'failed'">
        <path d="M10 5.2v5.8" />
        <circle cx="10" cy="14.3" r="0.8" class="status-icon-dot" />
      </template>
      <path
        v-else-if="status === 'rejected' || status === 'cancelled'"
        d="m6.2 6.2 7.6 7.6m0-7.6-7.6 7.6"
      />
      <path
        v-else-if="status === 'transferring'"
        d="M5 7h8.5m-2.7-2.5L13.5 7l-2.7 2.5M15 13H6.5m2.7 2.5L6.5 13l2.7-2.5"
      />
      <path v-else d="M10 5.2v5l3.1 1.8" />
    </svg>
  </span>
</template>

<style scoped>
.status-icon {
  display: inline-flex;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #ffffff;
  background: #94a3b8;
  vertical-align: middle;
}

.status-icon svg {
  display: block;
  width: 14px;
  height: 14px;
  overflow: visible;
}

.status-icon path {
  fill: none;
  stroke: currentcolor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.9;
}

.status-icon-dot {
  fill: currentcolor;
}

.is-completed,
.is-accepted {
  background: #22a06b;
}

.is-failed,
.is-rejected {
  background: #e5484d;
}

.is-cancelled {
  background: #64748b;
}

.is-transferring {
  background: #3478f6;
}

.is-awaitingAcceptance {
  background: #d97706;
}
</style>
