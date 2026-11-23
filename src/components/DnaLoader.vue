<script setup lang="ts">
// The compact working indicator (session rows, the current tool step): four
// columns of dot pairs pinching shut one after the other, like Agent
// sessions' helix, sized for a 12 px line.
</script>

<template>
  <span class="dna-loader" aria-hidden="true">
    <span v-for="k in 4" :key="k" :style="{ left: `${(k - 1) * 4.2}px`, animationDelay: `${-((5 - k) * 1.74) / 7}s` }"><i /><i /></span>
  </span>
</template>

<style scoped>
.dna-loader {
  position: relative;
  display: inline-block;
  flex: none;
  width: 16px;
  height: 12px;
  overflow: hidden;
}
.dna-loader > span {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
}
.dna-loader i {
  position: absolute;
  left: 0.2px;
  top: 5.2px;
  width: 1.6px;
  height: 1.6px;
  border-radius: 50%;
  background: var(--dna-color, #365f78);
  animation: dna-top 1.74s linear infinite;
  animation-delay: inherit;
}
.dna-loader i + i {
  animation-name: dna-bottom;
}
@keyframes dna-top {
  0% { transform: translateY(-5px) scale(1); }
  10% { transform: translateY(-2.687px) scale(1.0625); }
  15% { transform: translateY(-1.059px) scale(1.185); }
  26% { transform: translateY(-0.44px) scale(1.25); }
  37% { transform: translateY(-0.44px) scale(1.25); }
  49% { transform: translateY(-1.641px) scale(1.133); }
  58% { transform: translateY(-3.747px) scale(1.018); }
  70% { transform: translateY(-4.396px) scale(1.004); }
  100% { transform: translateY(-5px) scale(1); }
}
@keyframes dna-bottom {
  0% { transform: translateY(5px) scale(1); }
  10% { transform: translateY(2.687px) scale(1.0625); }
  15% { transform: translateY(1.059px) scale(1.185); }
  26% { transform: translateY(0.44px) scale(1.25); }
  37% { transform: translateY(0.44px) scale(1.25); }
  49% { transform: translateY(1.641px) scale(1.133); }
  58% { transform: translateY(3.747px) scale(1.018); }
  70% { transform: translateY(4.396px) scale(1.004); }
  100% { transform: translateY(5px) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .dna-loader i {
    animation: none;
    transform: translateY(-3px);
  }
  .dna-loader i + i {
    transform: translateY(3px);
  }
}
</style>
