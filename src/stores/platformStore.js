import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useFireStore } from './fireStore'
import { useDemoStore } from './demoStore'
import { dataSource } from '../api'
import { STAGE_LABELS } from '../api/contract'

// 六阶段演示流程：唯一状态机定义在后端（worker/src/demo/stages.ts）。
// demo 模式下本 store 仅镜像后端阶段；mock 模式下沿用本地既有演示流程。
export const usePlatformStore = defineStore('platform', () => {
  const fireStore = useFireStore()
  const demoStore = useDemoStore()

  const demoFlowActive = ref(false)

  // 展示用步骤：demo 模式取后端状态机的六阶段，mock 模式沿用本地定义
  const demoFlowSteps = computed(() => {
    if (dataSource.isDemo) {
      return demoStore.flowSteps.map((s) => ({ id: s.index + 1, name: s.name, icon: iconOf(s.id), status: s.done ? 'done' : s.active ? 'processing' : 'pending' }))
    }
    return [
      { id: 1, name: '发现火灾', icon: 'fire', status: 'pending' },
      { id: 2, name: '启动应急响应', icon: 'alert', status: 'pending' },
      { id: 3, name: '疏散路径', icon: 'route', status: 'pending' },
      { id: 4, name: '智能疏散', icon: 'evac', status: 'pending' },
      { id: 5, name: '人员疏散完成', icon: 'check', status: 'pending' },
      { id: 6, name: '协同救援', icon: 'rescue', status: 'pending' },
    ]
  })

  // demo 模式：后端阶段索引（0=IDLE … 6=RESCUE_COORDINATION）；mock 模式：本地 emergencyStage
  const demoStepIndex = computed(() => {
    if (dataSource.isDemo) {
      const i = demoStore.stageIndex
      if (i <= 0) return 0
      return Math.min(i - 1, 5)
    }
    const s = fireStore.emergencyStage
    if (!s || s <= 0) return 0
    return Math.min(s - 1, 5)
  })

  const currentStep = computed(() => demoFlowSteps.value[demoStepIndex.value])
  const isLastStep = computed(() => demoStepIndex.value >= demoFlowSteps.value.length - 1)
  const progress = computed(() => (dataSource.isDemo ? demoStore.progress : (demoFlowActive.value ? Math.round((demoStepIndex.value / demoFlowSteps.value.length) * 100) : 0)))

  function iconOf(id) {
    return { FIRE_DETECTED: 'fire', EMERGENCY_RESPONSE: 'alert', ROUTE_PLANNING: 'route', SMART_EVACUATION: 'evac', RETAINED_PERSONS: 'check', RESCUE_COORDINATION: 'rescue' }[id] || 'fire'
  }

  // ① 发现火灾
  function startDemoFlow() {
    demoFlowActive.value = true
    if (dataSource.isDemo) return demoStore.startFire()
    fireStore.startDemoFlow()
    return currentStep.value
  }

  // 推进一步：demo 模式把指令发给后端状态机，由后端广播新状态
  function advanceDemoFlow() {
    if (dataSource.isDemo) return demoStore.advance()
    if (!demoFlowActive.value) return null
    fireStore.advanceDemoStage()
    return currentStep.value
  }

  function resetDemoFlow() {
    demoFlowActive.value = false
    if (dataSource.isDemo) return demoStore.reset()
    fireStore.resetDemoFlow()
  }

  // demo 模式下的阶段说明直接来自后端状态机
  const stageLabel = computed(() => (dataSource.isDemo ? (STAGE_LABELS[demoStore.stage] || demoStore.stageLabel) : ''))

  return {
    demoFlowActive,
    demoStepIndex,
    demoFlowSteps,
    currentStep,
    isLastStep,
    progress,
    startDemoFlow,
    advanceDemoFlow,
    resetDemoFlow,
    stageLabel,
  }
})
