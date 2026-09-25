<template>
  <!-- 轻量 SVG 楼宇缩略图（用于仪表盘楼栋卡片，避免每个卡片都挂载 WebGL 画布） -->
  <svg class="mini-building" viewBox="0 0 80 80" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" :stop-color="active ? '#4CC9F0' : '#1B2A3A'" />
        <stop offset="100%" :stop-color="active ? '#4361EE' : '#0B1626'" />
      </linearGradient>
    </defs>
    <!-- 楼体 -->
    <rect
      x="20" y="8" width="40" height="64" rx="2"
      :fill="`url(#${gid})`"
      :stroke="statusColor"
      stroke-width="1.5"
      :class="{ 'mini-pulse': building && building.status === 'warning' }"
    />
    <!-- 楼层窗格 -->
    <g>
      <rect v-for="f in 6" :key="f" :x="24" :y="8 + (f - 1) * 10" width="32" height="7" rx="1"
            :fill="active ? 'rgba(255,255,255,0.10)' : 'rgba(76,201,240,0.06)'" />
      <circle
        v-for="w in 12" :key="'w' + w"
        :cx="28 + ((w - 1) % 3) * 10" :cy="11 + Math.floor((w - 1) / 3) * 20"
        r="1.6" :fill="windowColor(w)"
      />
    </g>
    <!-- 顶部天线 -->
    <line x1="40" y1="8" x2="40" y2="3" :stroke="statusColor" stroke-width="1" />
    <circle cx="40" cy="3" r="1.6" :fill="statusColor" />
    <!-- 楼栋编号 -->
    <text x="40" y="76" text-anchor="middle" font-size="7" fill="rgba(255,255,255,0.55)">{{ shortId }}</text>
  </svg>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  building: { type: Object, default: null },
  active: { type: Boolean, default: false },
})

const gid = computed(() => 'mg' + (props.building ? props.building.id : 'x') + (props.active ? 'a' : ''))

const statusColor = computed(() => {
  const s = props.building ? props.building.status : 'normal'
  if (s === 'warning') return '#EF4444'
  if (s === 'emergency') return '#EF4444'
  return props.active ? '#4CC9F0' : '#4361EE'
})

const shortId = computed(() => {
  const id = props.building ? props.building.id : ''
  return id ? id.replace(/^B0*/, '') : ''
})

// 稳定的窗格点亮（按楼栋 id 哈希）
function windowColor(w) {
  const id = props.building ? props.building.id : ''
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const lit = (h >> w) & 1
  return lit ? (props.active ? '#A5E8FF' : '#4CC9F0') : 'rgba(76,201,240,0.18)'
}
</script>

<style scoped>
.mini-building {
  width: 100%;
  height: 100%;
  display: block;
}
.mini-pulse {
  animation: miniPulse 1.5s ease-in-out infinite;
}
@keyframes miniPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
</style>
