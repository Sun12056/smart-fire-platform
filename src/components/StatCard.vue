<template>
  <div class="stat-card fire-card" :class="cardClass">
    <div class="card-accent-bar" :style="{ background: valueColor }"></div>
    <div class="card-content">
      <div class="card-header">
        <span class="card-title">{{ title }}</span>
      </div>
      <div class="card-body">
        <span class="card-value num-font" :style="{ color: valueColor }">
          {{ displayValue }}
        </span>
        <span class="card-unit" v-if="unit">{{ unit }}</span>
      </div>
      <div class="card-sub-label" v-if="extra">{{ extra }}</div>
      <div class="card-footer" v-if="trend">
        <span class="card-trend" :class="trendType">
          {{ trendIcon }} {{ trend }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  title: String,
  value: [Number, String],
  unit: String,
  icon: { type: String, default: '📊' },
  type: { type: String, default: 'default' },
  trend: String,
  trendType: { type: String, default: 'up' },
  extra: String,
})

const cardClass = computed(() => `card-${props.type}`)
const valueColor = computed(() => {
  const colors = {
    default: '#4CC9F0',
    blue: '#4CC9F0',
    cyan: '#4CC9F0',
    orange: '#F59E0B',
    red: '#EF4444',
    green: '#22C55E',
  }
  return colors[props.type] || colors.default
})

const displayValue = ref(props.value)
const trendIcon = computed(() => (props.trendType === 'up' ? '↑' : '↓'))

watch(
  () => props.value,
  (newVal, oldVal) => {
    if (typeof newVal === 'number' && typeof oldVal === 'number') {
      const diff = newVal - oldVal
      const steps = 15
      let step = 0
      const interval = setInterval(() => {
        step++
        displayValue.value = Math.round(oldVal + (diff * step) / steps)
        if (step >= steps) {
          displayValue.value = newVal
          clearInterval(interval)
        }
      }, 20)
    } else {
      displayValue.value = newVal
    }
  }
)
</script>

<style scoped>
.stat-card {
  position: relative;
  display: flex;
  transition: transform 0.2s;
  border-radius: 3px;
  overflow: hidden;
}

.card-accent-bar {
  width: 2px;
  flex-shrink: 0;
  transition: box-shadow 0.2s;
}

.stat-card:hover {
  transform: translateY(-1px);
}

.stat-card:hover .card-accent-bar {

}

.card-content {
  flex: 1;
  padding: 12px;
}

.card-header {
  margin-bottom: 6px;
}

.card-title {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  letter-spacing: 1px;
  text-transform: uppercase;
  font-weight: 500;
}

.card-body {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.card-value {
  font-size: var(--fs-hero);
  font-weight: 700;
  line-height: var(--lh-tight);

}

.card-unit {
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
}

.card-sub-label {
  font-size: var(--fs-tiny);
  color: var(--text-tertiary);
  margin-top: 4px;
  letter-spacing: 0.5px;
}

.card-footer {
  display: flex;
  align-items: center;
  margin-top: 4px;
  font-size: var(--fs-tiny);
}

.card-trend.up {
  color: #22C55E;
}

.card-trend.down {
  color: #EF4444;
}
</style>
