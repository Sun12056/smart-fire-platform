<template>
  <div class="chart-wrapper">
    <div class="chart-header" v-if="title">
      <h4>{{ title }}</h4>
    </div>
    <div ref="chartRef" class="chart-body"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import * as echarts from 'echarts'

const props = defineProps({
  title: String,
  type: { type: String, default: 'doughnut' },
  data: { type: Object, default: () => ({}) },
})

const chartRef = ref(null)
let chart = null

function initChart() {
  if (!chartRef.value) return
  chart = echarts.init(chartRef.value)
  renderChart()
}

function renderChart() {
  if (!chart) return
  const option = getOption()
  chart.setOption(option, true)
}

function getOption() {
  const common = {
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(8,21,37,0.95)',
      borderColor: 'rgba(76,201,240,0.2)',
      textStyle: { color: '#EEF2F8', fontSize: 11 },
    },
  }

  if (props.type === 'doughnut') {
    return {
      ...common,
      legend: {
        bottom: '5%',
        left: 'center',
        textStyle: { color: '#94A3B8', fontSize: 10 },
        itemWidth: 8,
        itemHeight: 8,
      },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: false,
          itemStyle: {
            borderRadius: 2,
            borderColor: '#1B1F2A',
            borderWidth: 2,
          },
          label: { show: false },
          emphasis: {
            label: {
              show: true,
              fontSize: 12,
              fontWeight: 'bold',
              color: '#EEF2F8',
            },
          },
          data: [
            { value: props.data.normal || 0, name: '正常', itemStyle: { color: '#22C55E' } },
            { value: props.data.abnormal || 0, name: '异常', itemStyle: { color: '#EF4444' } },
            { value: props.data.offline || 0, name: '离线', itemStyle: { color: '#475569' } },
          ],
        },
      ],
    }
  } else if (props.type === 'bar') {
    const entries = Object.entries(props.data)
    return {
      ...common,
      grid: { left: '3%', right: '5%', bottom: '3%', top: '10%', containLabel: true },
      xAxis: {
        type: 'value',
        axisLabel: { color: '#475569', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(76,201,240,0.05)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map((e) => e[0]),
        axisLabel: { color: '#94A3B8', fontSize: 10 },
        axisLine: { lineStyle: { color: 'rgba(76,201,240,0.1)' } },
      },
      series: [
        {
          type: 'bar',
          data: entries.map((e) => e[1]),
          barWidth: '50%',
          itemStyle: {
            borderRadius: [0, 2, 2, 0],
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: '#4CC9F0' },
              { offset: 1, color: '#4CC9F0' },
            ]),
          },
          label: {
            show: true,
            position: 'right',
            color: '#94A3B8',
            fontSize: 10,
          },
        },
      ],
    }
  } else if (props.type === 'line') {
    return {
      ...common,
      grid: { left: '3%', right: '5%', bottom: '3%', top: '10%', containLabel: true },
      xAxis: {
        type: 'category',
        data: props.data.hours || [],
        axisLabel: { color: '#475569', fontSize: 10 },
        axisLine: { lineStyle: { color: 'rgba(76,201,240,0.1)' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#475569', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(76,201,240,0.05)' } },
      },
      series: [
        {
          type: 'line',
          data: props.data.values || [],
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          lineStyle: { color: '#F59E0B', width: 1.5 },
          itemStyle: { color: '#F59E0B' },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(245,158,11,0.2)' },
              { offset: 1, color: 'rgba(245,158,11,0)' },
            ]),
          },
        },
      ],
    }
  } else if (props.type === 'battery') {
    return {
      ...common,
      grid: { left: '3%', right: '5%', bottom: '3%', top: '10%', containLabel: true },
      xAxis: {
        type: 'category',
        data: props.data.labels || [],
        axisLabel: { color: '#475569', fontSize: 10 },
        axisLine: { lineStyle: { color: 'rgba(76,201,240,0.1)' } },
      },
      yAxis: {
        type: 'value',
        max: 100,
        axisLabel: { color: '#475569', fontSize: 10, formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(76,201,240,0.05)' } },
      },
      series: [
        {
          type: 'line',
          data: props.data.batteryData || [],
          smooth: true,
          lineStyle: { color: '#22C55E', width: 1.5 },
          itemStyle: { color: '#22C55E' },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(34,197,94,0.2)' },
              { offset: 1, color: 'rgba(34,197,94,0)' },
            ]),
          },
        },
      ],
    }
  } else if (props.type === 'temp') {
    return {
      ...common,
      grid: { left: '3%', right: '5%', bottom: '3%', top: '10%', containLabel: true },
      xAxis: {
        type: 'category',
        data: props.data.labels || [],
        axisLabel: { color: '#475569', fontSize: 10 },
        axisLine: { lineStyle: { color: 'rgba(76,201,240,0.1)' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#475569', fontSize: 10, formatter: '{value}℃' },
        splitLine: { lineStyle: { color: 'rgba(76,201,240,0.05)' } },
      },
      series: [
        {
          type: 'line',
          data: props.data.tempData || [],
          smooth: true,
          lineStyle: { color: '#EF4444', width: 1.5 },
          itemStyle: { color: '#EF4444' },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(239,68,68,0.2)' },
              { offset: 1, color: 'rgba(239,68,68,0)' },
            ]),
          },
        },
      ],
    }
  }
}

function handleResize() {
  chart?.resize()
}

onMounted(() => {
  initChart()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  chart?.dispose()
})

watch(() => props.data, renderChart, { deep: true })
</script>

<style scoped>
.chart-wrapper {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.chart-header h4 {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  padding: 8px 12px;
  border-bottom: 1px solid var(--fire-border);
  letter-spacing: 1.5px;
  text-transform: uppercase;
  font-weight: 500;
}

.chart-body {
  flex: 1;
  min-height: 120px;
}
</style>
