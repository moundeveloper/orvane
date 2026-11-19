<script setup>
import { ICONS } from './icons.js';

defineProps({ name: String });
</script>

<template>
  <i class="um-icon" :data-i="name" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
      <path :d="ICONS[name]" />
    </svg>
  </i>
</template>
