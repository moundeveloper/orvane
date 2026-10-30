<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
type AppId = 'scripts' | 'files' | 'query';
type TrailItem = { app: AppId; environment: string; visitedAt: number };
const props = withDefaults(defineProps<{ preferred: AppId[]; trail: TrailItem[]; environment: string; pinned?: { id: string; title: string }[]; compact?: boolean }>(), { compact: false });
const emit = defineEmits<{ open: [AppId]; toggle: [AppId]; removeRecent: [AppId]; clearRecent: []; openDashboard: [string]; unpinDashboard: [string] }>();
const search = ref('');
const apps: { id: AppId; name: string; icon: string; description: string }[] = [
  { id: 'scripts', name: 'Scripts', icon: 'code', description: 'Scripts and deployments' },
  { id: 'files', name: 'File Cabinet', icon: 'folder', description: 'Browse files and folders' },
  { id: 'query', name: 'SuiteQL', icon: 'list', description: 'Write and run queries' },
];
const matching = computed(() => apps.filter(a => `${a.name} ${a.description}`.toLowerCase().includes(search.value.trim().toLowerCase())));
const preferredApps = computed(() => matching.value.filter(a => props.preferred.includes(a.id)));
const otherApps = computed(() => matching.value.filter(a => !props.preferred.includes(a.id)));
const pinnedMatches = computed(() => (props.pinned || []).filter(d => d.title.toLowerCase().includes(search.value.trim().toLowerCase())));
const recent = computed(() => props.trail.filter(item => item.environment === props.environment && apps.some(a => a.id === item.app)).slice(0, 6));
const account = computed(() => { try { return new URL(props.environment).hostname.split('.')[0]?.toUpperCase().replace(/-/g, '_') || ''; } catch { return ''; } });
const app = (id: AppId) => apps.find(a => a.id === id)!;
function relativeTime(timestamp: number) { const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000); if (minutes < 1) return 'just now'; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; const days = Math.floor(hours / 24); return days === 1 ? 'yesterday' : `${days}d ago`; }
</script>
<template>
  <div class="ns-home" :class="{ compact }">
    <div class="home-search"><Icon name="search" :size="15"/><input v-model="search" aria-label="Search apps" placeholder="Search apps" autocomplete="off"/></div>
    <div class="home-content">
      <section v-if="!compact && pinnedMatches.length" class="home-section"><div class="home-section-head"><h2>Pinned dashboards</h2></div><div class="home-trail"><div v-for="dashboard in pinnedMatches" :key="dashboard.id" class="trail-item"><button class="trail-open" @click="emit('openDashboard', dashboard.id)"><Icon name="app" :size="16"/><span><strong>{{ dashboard.title }}</strong><small>Dashboard</small></span></button><button class="trail-remove pinned" :aria-label="`Unpin ${dashboard.title}`" @click="emit('unpinDashboard', dashboard.id)"><Icon name="star" :size="14"/></button></div></div></section>
      <section v-if="!compact && environment && recent.length && !search.trim()" class="home-section">
        <div class="home-section-head"><div><h2>Workspace Trail</h2><p>Continue in {{ account }}</p></div><button class="home-clear" @click="emit('clearRecent')">Clear</button></div>
        <div class="home-trail"><div v-for="item in recent" :key="item.app" class="trail-item"><button class="trail-open" @click="emit('open', item.app)"><Icon :name="app(item.app).icon" :size="16"/><span><strong>{{ app(item.app).name }}</strong><small>{{ relativeTime(item.visitedAt) }}</small></span></button><button class="trail-remove" :aria-label="`Remove ${app(item.app).name} from trail`" @click="emit('removeRecent', item.app)"><Icon name="close" :size="13"/></button></div></div>
      </section>
      <section v-for="section in [{name:'Preferred', items:preferredApps}, {name:'All Features', items:otherApps}]" :key="section.name" v-show="section.items.length" class="home-section"><div class="home-section-head"><h2>{{ section.name }}</h2></div><div class="home-grid"><article v-for="item in section.items" :key="item.id" class="home-tile"><button class="home-favorite" :class="{ active: preferred.includes(item.id) }" :aria-label="`${preferred.includes(item.id) ? 'Remove' : 'Add'} ${item.name} ${preferred.includes(item.id) ? 'from' : 'to'} preferred`" :aria-pressed="preferred.includes(item.id)" @click="emit('toggle', item.id)"><Icon name="star" :size="16"/></button><button class="home-open" @click="emit('open', item.id)"><Icon :name="item.icon" :size="23"/><strong>{{ item.name }}</strong><span>{{ item.description }}</span></button></article></div></section>
      <p v-if="!matching.length && !pinnedMatches.length" class="home-empty">No apps match “{{ search }}”.</p>
    </div>
  </div>
</template>
<style scoped>
.ns-home{display:flex;flex:1;min-height:0;flex-direction:column;padding:16px;color:#455968}.home-search{display:flex;align-items:center;gap:9px;padding:0 11px;background:#edf3f6;border-radius:6px;color:#728794;min-height:38px}.home-search input{flex:1;min-width:0;border:0;outline:none;background:transparent;color:#344d5b;font:inherit}.home-search:focus-within{box-shadow:inset 0 -2px #728f9f}.home-content{min-height:0;overflow:auto;padding:4px 2px 16px}.home-section{margin-top:22px}.home-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.home-section-head h2{font-size:13px;font-weight:650;margin:0}.home-section-head p{margin:5px 0 0;color:#657b89}.home-clear{border:0;background:none;color:#547589;cursor:pointer}.home-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,180px));gap:16px}.home-tile{position:relative;border:1px solid #d5e1e6;border-radius:7px;background:#f4f8fa;min-height:150px}.home-tile:hover{background:#eaf2f5}.home-open{width:100%;height:100%;min-height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:28px 12px 16px;color:#455968;border:0;background:transparent;cursor:pointer}.home-open span{color:#657b89;font-size:11px;text-align:center}.home-favorite{position:absolute;top:8px;left:8px;z-index:1;border:0;background:none;color:#8195a0;cursor:pointer;padding:4px}.home-favorite.active{color:#ab842b}.home-favorite.active :deep(svg){fill:currentColor}.home-favorite:hover{color:#987626}.home-trail{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.trail-item{display:flex;align-items:center;border:1px solid #dce5e9;border-radius:6px;background:#f9fbfc}.trail-open{flex:1;min-width:0;display:flex;gap:10px;align-items:center;padding:10px;text-align:left;border:0;background:none;color:inherit;cursor:pointer}.trail-open span{display:flex;min-width:0;flex-direction:column;gap:3px}.trail-open small{color:#657b89}.trail-remove.pinned{color:#ab842b}.trail-remove.pinned :deep(svg){fill:currentColor}.trail-remove{border:0;background:none;color:#718894;padding:8px;cursor:pointer}.home-empty{color:#657b89}.compact{padding:12px}.compact .home-section{margin-top:16px}.compact .home-grid{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}.compact .home-tile,.compact .home-open{min-height:110px}.compact .home-open span{display:none}@media(max-width:500px){.home-grid{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}.home-tile,.home-open{min-height:120px}}
</style>
