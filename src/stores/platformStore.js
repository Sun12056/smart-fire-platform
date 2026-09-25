import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useFireStore } from './fireStore'

export const usePlatformStore = defineStore('platform', () => {
  const fireStore = useFireStore()

  const demoFlowActive = ref(false)
  // 演示步骤索引与 fireStore.emergencyStage 统一（阶段1~6 → 索引0~5）；未起火时归零
  const demoStepIndex = computed(() => {
    const s = fireStore.emergencyStage
    if (!s || s <= 0) return 0
    return Math.min(s - 1, 5)
  })

  // 六阶段演示流程（展示用，真实状态由 fireStore.emergencyStage 驱动）
  const demoFlowSteps = ref([
    { id: 1, name: '发现火灾', icon: 'fire', status: 'pending' },
    { id: 2, name: '启动应急响应', icon: 'alert', status: 'pending' },
    { id: 3, name: '疏散路径', icon: 'route', status: 'pending' },
    { id: 4, name: '智能疏散', icon: 'evac', status: 'pending' },
    { id: 5, name: '人员疏散完成', icon: 'check', status: 'pending' },
    { id: 6, name: '协同救援', icon: 'rescue', status: 'pending' },
  ])

  const currentStep = computed(() => demoFlowSteps.value[demoStepIndex.value])
  const isLastStep = computed(() => demoStepIndex.value >= demoFlowSteps.value.length - 1)
  const progress = computed(() => {
    if (!demoFlowActive.value) return 0
    return Math.round(((demoStepIndex.value) / demoFlowSteps.value.length) * 100)
  })

  // ① 发现火灾：复位演示并定位 3号楼 5F A区
  function startDemoFlow() {
    demoFlowActive.value = true
    fireStore.startDemoFlow()
    return currentStep.value
  }

  // 推进一步：调用 fireStore 的真实状态变更（每步都真实改变平台状态）
  function advanceDemoFlow() {
    if (!demoFlowActive.value) return null
    fireStore.advanceDemoStage()
    return currentStep.value
  }

  function resetDemoFlow() {
    demoFlowActive.value = false
    fireStore.resetDemoFlow()
  }

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
  }
})
