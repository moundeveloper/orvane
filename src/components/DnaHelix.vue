<script setup lang="ts">
// The approved working indicator (Agent sessions' helix): nine columns of dot
// pairs on rungs; each pinches shut and reopens 1/7 of a cycle behind the
// next, so the pinch travels right. Used below a working trail and on the
// working step itself. Markup and CSS moved unchanged from AgentSessions.vue.
</script>

<template>
  <span class="cs-dna" aria-hidden="true"
    ><span
      v-for="k in 9"
      :key="k"
      :style="{
        left: `${(k - 1) * 4.5}px`,
        animationDelay: `${-((10 - k) * 1.74) / 7}s`,
      }"
      ><b /><i /><i /></span
  ></span>
</template>

<style scoped>
/* Working indicator: dot pairs on rungs pinch shut and reopen, one column
   1/7 of a cycle behind the next, so the pinch travels right like a helix.
   Timing measured from the owner's Pinterest reference. */
.cs-dna {
  position: relative;
  flex: none;
  width: 38px;
  height: 16px;
}
.cs-dna > span {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.6px;
}
.cs-dna i {
  position: absolute;
  left: 0;
  top: 7.2px;
  width: 1.6px;
  height: 1.6px;
  border-radius: 50%;
  background: var(--cs-run, #365f78);
  transform: translateY(-7px);
  animation: cs-dna-top 1.74s linear infinite;
  animation-delay: inherit;
}
.cs-dna i + i {
  transform: translateY(7px);
  animation-name: cs-dna-bottom;
}
.cs-dna b {
  position: absolute;
  left: 0.5px;
  top: 1px;
  width: 0.6px;
  height: 14px;
  background: var(--cs-run, #365f78);
  opacity: 0.35;
  animation: cs-dna-rung 1.74s linear infinite;
  animation-delay: inherit;
}
@keyframes cs-dna-top {
  0% {
    transform: translateY(-7px) scale(1);
  }
  8% {
    transform: translateY(-5.6px) scale(1.01);
  }
  10.3% {
    transform: translateY(-3.75px) scale(1.06);
  }
  12.6% {
    transform: translateY(-1.92px) scale(1.15);
  }
  15% {
    transform: translateY(-1.34px) scale(1.18);
  }
  19.5% {
    transform: translateY(-0.95px) scale(1.21);
  }
  24% {
    transform: translateY(-0.63px) scale(1.24);
  }
  26.4% {
    transform: translateY(-0.44px) scale(1.25);
  }
  37% {
    transform: translateY(-0.44px) scale(1.25);
  }
  40% {
    transform: translateY(-0.76px) scale(1.23);
  }
  45% {
    transform: translateY(-1.34px) scale(1.18);
  }
  49% {
    transform: translateY(-2.18px) scale(1.13);
  }
  52% {
    transform: translateY(-3.23px) scale(1.08);
  }
  54% {
    transform: translateY(-4.21px) scale(1.04);
  }
  58.6% {
    transform: translateY(-5.21px) scale(1.02);
  }
  63% {
    transform: translateY(-5.6px) scale(1.01);
  }
  70% {
    transform: translateY(-6.14px) scale(1);
  }
  79% {
    transform: translateY(-6.4px) scale(1);
  }
  93% {
    transform: translateY(-6.73px) scale(1);
  }
  97.7% {
    transform: translateY(-7px) scale(1);
  }
  100% {
    transform: translateY(-7px) scale(1);
  }
}
@keyframes cs-dna-bottom {
  0% {
    transform: translateY(7px) scale(1);
  }
  8% {
    transform: translateY(5.6px) scale(1.01);
  }
  10.3% {
    transform: translateY(3.75px) scale(1.06);
  }
  12.6% {
    transform: translateY(1.92px) scale(1.15);
  }
  15% {
    transform: translateY(1.34px) scale(1.18);
  }
  19.5% {
    transform: translateY(0.95px) scale(1.21);
  }
  24% {
    transform: translateY(0.63px) scale(1.24);
  }
  26.4% {
    transform: translateY(0.44px) scale(1.25);
  }
  37% {
    transform: translateY(0.44px) scale(1.25);
  }
  40% {
    transform: translateY(0.76px) scale(1.23);
  }
  45% {
    transform: translateY(1.34px) scale(1.18);
  }
  49% {
    transform: translateY(2.18px) scale(1.13);
  }
  52% {
    transform: translateY(3.23px) scale(1.08);
  }
  54% {
    transform: translateY(4.21px) scale(1.04);
  }
  58.6% {
    transform: translateY(5.21px) scale(1.02);
  }
  63% {
    transform: translateY(5.6px) scale(1.01);
  }
  70% {
    transform: translateY(6.14px) scale(1);
  }
  79% {
    transform: translateY(6.4px) scale(1);
  }
  93% {
    transform: translateY(6.73px) scale(1);
  }
  97.7% {
    transform: translateY(7px) scale(1);
  }
  100% {
    transform: translateY(7px) scale(1);
  }
}
@keyframes cs-dna-rung {
  0% {
    transform: scaleY(1);
  }
  8% {
    transform: scaleY(0.801);
  }
  10.3% {
    transform: scaleY(0.536);
  }
  12.6% {
    transform: scaleY(0.274);
  }
  15% {
    transform: scaleY(0.191);
  }
  19.5% {
    transform: scaleY(0.136);
  }
  24% {
    transform: scaleY(0.09);
  }
  26.4% {
    transform: scaleY(0.063);
  }
  37% {
    transform: scaleY(0.063);
  }
  40% {
    transform: scaleY(0.109);
  }
  45% {
    transform: scaleY(0.191);
  }
  49% {
    transform: scaleY(0.312);
  }
  52% {
    transform: scaleY(0.461);
  }
  54% {
    transform: scaleY(0.602);
  }
  58.6% {
    transform: scaleY(0.744);
  }
  63% {
    transform: scaleY(0.801);
  }
  70% {
    transform: scaleY(0.877);
  }
  79% {
    transform: scaleY(0.915);
  }
  93% {
    transform: scaleY(0.962);
  }
  97.7% {
    transform: scaleY(1);
  }
  100% {
    transform: scaleY(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .cs-dna i,
  .cs-dna b {
    animation: none;
  }
}
</style>
