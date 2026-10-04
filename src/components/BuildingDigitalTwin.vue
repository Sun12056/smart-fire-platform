<template>
  <div ref="containerRef" class="bdt-root">
    <canvas ref="canvasRef" class="bdt-canvas"></canvas>

    <!-- 加载状态 -->
    <div v-if="loading" class="bdt-overlay">
      <div class="bdt-spinner"></div>
      <div class="bdt-overlay-text">正在加载楼宇数字孪生模型…</div>
    </div>

    <!-- 失败友好提示 -->
    <div v-else-if="loadError" class="bdt-overlay bdt-overlay-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="34" height="34">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <div class="bdt-overlay-text">数字孪生模型加载失败</div>
      <div class="bdt-overlay-sub">{{ loadError }}</div>
    </div>

    <!-- 视角控制 -->
    <div v-if="!loading && !loadError" class="bdt-viewport">
      <button class="vp-btn" @click="focusBuilding">总览</button>
      <button v-if="store.dashboardView.selectedFloorId" class="vp-btn" @click="focusFloor">当前楼层</button>
      <button v-if="store.fireEvent" class="vp-btn vp-fire" @click="focusFire">聚焦火区</button>
    </div>

    <!-- 当前视角提示 -->
    <div v-if="!loading && !loadError" class="bdt-hint">
      <span v-if="store.dashboardView.selectedFloorId">{{ store.dashboardView.selectedFloorId }}</span>
      <span v-else>楼栋总览</span>
      <span v-if="store.dashboardView.selectedZone" class="bdt-hint-zone">· {{ store.dashboardView.selectedZone }}</span>
    </div>

    <!-- 图例 -->
    <div v-if="!loading && !loadError" class="bdt-legend">
      <span class="lg-item"><i class="lg-dot" style="background:#4cc9f0"></i>正常人员</span>
      <span class="lg-item"><i class="lg-dot" style="background:#f59e0b"></i>预警</span>
      <span class="lg-item"><i class="lg-dot" style="background:#ef4444"></i>被困</span>
      <span class="lg-item"><i class="lg-dot" style="background:#22c55e"></i>已获救/出口</span>
      <span class="lg-item"><i class="lg-dot" style="background:#39ff88"></i>疏散路线</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import * as THREE from 'three'
import gsap from 'gsap'
import { useFireStore } from '../stores/fireStore'

// 真正的模块化 3D 引擎
import { ThreeScene } from './building3d/ThreeScene.js'
import { BuildingModel } from './building3d/BuildingModel.js'
import { CameraDirector } from './building3d/CameraDirector.js'
import { PersonLayer3D } from './building3d/PersonLayer3D.js'
import { RouteLayer3D } from './building3d/RouteLayer3D.js'
import { FireZone3D } from './building3d/FireZone3D.js'
import { EmergencyLight3D } from './building3d/EmergencyLight3D.js'
import { RescueLayer3D } from './building3d/RescueLayer3D.js'

import modelUrl from '../assets/models/BuildingDigitalTwin_FloorPlan_6F_3D_Open.glb'

const store = useFireStore()
const containerRef = ref(null)
const canvasRef = ref(null)
const loading = ref(true)
const loadError = ref(null)

let scene = null
let model = null
let camera = null
let route = null
let fire = null
let em = null
let rescue = null
let persons = null
let unsubscribeTick = null

onMounted(async () => {
  await nextTick()
  try {
    if (!containerRef.value || !canvasRef.value) return
    // ── 1. 场景骨架（Scene/Camera/Renderer/Controls/Lights/Resize） ──
    scene = new ThreeScene(containerRef.value, canvasRef.value)
    // ── 2. 相机导演（GSAP 平滑） ──
    camera = new CameraDirector(scene, /*model*/ null)
    // ── 3. 模型加载（GLB + 索引 + 归一化，带超时兜底）──
    model = new BuildingModel(scene, modelUrl)
    await Promise.race([
      model.load(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('GLB 加载超时')), 25000)),
    ])
    camera.model = model
    camera.focusBuilding(true)
    // ── 4. 各业务层 ──
    persons = new PersonLayer3D(scene, model)
    route = new RouteLayer3D(scene, model)
    fire = new FireZone3D(scene, model, camera)
    em = new EmergencyLight3D(scene, model)
    rescue = new RescueLayer3D(scene, model)
    // ── 5. 第一次同步 store 状态 ──
    persons.update(store)
    route.update(store)
    em.update(store)
    fire.update(store)
    rescue.update(store)
    applyHighlight()
    // ── 6. 注册每帧回调 ──
    unsubscribeTick = scene.onTick((dt, t) => {
      // 人员每帧从 store（后端权威位置 / routePoints）取目标并做视觉插值
      persons.tick(t, dt, store)
      route.tick(t)
      em.tick(t, store)
      fire.tick(t)
      rescue.tick(t, dt)
    })
    // ── 7. Raycaster 点击 ──
    scene.renderer.domElement.addEventListener('pointerup', onClickPick)
    // 调试句柄（开发排查用）
    if (import.meta.env.DEV) {
      window.__dtwin = { scene, model, camera, persons, route, fire, em, rescue, store }
    }
    loading.value = false
  } catch (err) {
    console.error('[BuildingDigitalTwin] init error:', err)
    loadError.value = '请确认 GLB 模型存在或浏览器支持 WebGL'
    loading.value = false
  }
})

function onClickPick(ev) {
  if (!scene || !model) return
  // 拖拽不触发选中
  if (window.__bdtDown && (Math.hypot(ev.clientX - window.__bdtDown.x, ev.clientY - window.__bdtDown.y) > 6)) return
  const rect = scene.renderer.domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  )
  const ray = new THREE.Raycaster()
  ray.setFromCamera(ndc, scene.camera)
  const pickables = model.getPickables().map((e) => e.obj)
  const hits = ray.intersectObjects(pickables, false)
  if (!hits.length) return
  const entry = model.getPickables().find((e) => e.obj === hits[0].object)
  if (!entry || !entry.tag.floor) return
  store.selectFloor(entry.tag.floorId)
  if (entry.tag.zone) store.selectZone(entry.tag.zone)
  camera.focusFloor(entry.tag.floorId)
}

// ── Store 联动 ──
function applyHighlight() {
  if (!model) return
  const selFloor = store.dashboardView.selectedFloorId
  const selNum = selFloor ? parseInt(selFloor) : null
  model.applyHighlight({
    selFloorNum: selNum,
    selZone: store.dashboardView.selectedZone,
  })
  if (store.fireEvent) model.applyFireHighlight(store.fireEvent)
}

watch(() => store.dashboardView.selectedFloorId, () => {
  applyHighlight()
})
watch(() => store.dashboardView.selectedZone, () => applyHighlight())
watch(() => store.fireEvent, () => { applyHighlight(); fire && fire.update(store) }, { deep: true })
watch(() => store.selectedBuilding, () => {
  // 注意：selectedBuilding 恒为 null（DashboardView 不调 selectBuilding），
  // 真实楼栋变化由 dashboardView.selectedBuildingId 决定（各层内部用 currentBuildingName 解析）
  if (!persons) return
  persons.update(store); route.update(store); fire.update(store); em.update(store)
}, { deep: true })
watch(() => store.persons, () => persons && persons.update(store), { deep: false })
watch(() => store.devices, () => em && em.update(store), { deep: false })
watch(() => store.routePlans, () => { route && route.update(store); persons && persons.update(store) }, { deep: true })
// A/B/C 切换：2D 平面图与 3D 人员跟随同一条路线（activeRoutePlanId 唯一驱动）
watch(() => store.activeRoutePlanId, () => {
  route && route.update(store)
  persons && persons.update(store)
})
watch(() => [store.rescueState, store.emergencyStage], () => rescue && rescue.update(store))
// 阶段 ≥ 4：人员开始沿当前方案疏散（错峰重新计时）
watch(() => store.emergencyStage, (s) => {
  if (!persons || !route) return
  if (s >= 4 && store.emergencyMode) persons.startEvacuation()
  else persons.stopEvacuation()
})

// ── 视角控制 ──
function focusBuilding() { camera.focusBuilding(false) }
function focusFloor()    { camera.focusFloor(store.dashboardView.selectedFloorId) }
function focusFire()     { fire && fire.camera.focusFire(store.fireEvent, false) }

// ── 对外暴露：容器尺寸变化（如从浮层打开）后主动适配一次 ──
function resize() {
  if (scene && typeof scene.resize === 'function') scene.resize()
}
defineExpose({ resize, focusBuilding })

// ── 拖拽检测 ──
function onPointerDown(ev) { window.__bdtDown = { x: ev.clientX, y: ev.clientY } }
onMounted(() => {
  if (canvasRef.value) canvasRef.value.addEventListener('pointerdown', onPointerDown)
})
onBeforeUnmount(() => {
  if (canvasRef.value) canvasRef.value.removeEventListener('pointerdown', onPointerDown)
  if (scene && scene.renderer && scene.renderer.domElement) {
    scene.renderer.domElement.removeEventListener('pointerup', onClickPick)
  }
  if (unsubscribeTick) unsubscribeTick()
  if (scene) scene.dispose()
})
</script>

<style scoped>
.bdt-root {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #101827;
}
.bdt-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.bdt-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #94A3B8;
  font-size: 13px;
  background: rgba(16, 24, 39, 0.6);
}
.bdt-overlay-error { color: #F87171; }
.bdt-overlay-text { font-weight: 600; }
.bdt-overlay-sub  { font-size: 12px; opacity: 0.7; }
.bdt-spinner {
  width: 28px;
  height: 28px;
  border: 2px solid rgba(76, 201, 240, 0.25);
  border-top-color: #4CC9F0;
  border-radius: 50%;
  animation: bdt-rot 0.9s linear infinite;
}
@keyframes bdt-rot { to { transform: rotate(360deg); } }

.bdt-hint {
  position: absolute;
  top: 14px;
  left: 16px;
  padding: 6px 14px;
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(76, 201, 240, 0.25);
  border-radius: 6px;
  color: #E2E8F0;
  font-size: 13px;
  font-weight: 600;
  backdrop-filter: blur(4px);
  pointer-events: none;
}
.bdt-hint-zone { color: #4CC9F0; margin-left: 4px; }

.bdt-legend {
  position: absolute;
  left: 16px;
  bottom: 14px;
  display: flex;
  gap: 12px;
  padding: 8px 14px;
  background: rgba(15, 23, 42, 0.7);
  border: 1px solid rgba(76, 201, 240, 0.18);
  border-radius: 6px;
  font-size: 11.5px;
  color: #CBD5E1;
  backdrop-filter: blur(4px);
}
.lg-item { display: inline-flex; align-items: center; gap: 5px; }
.lg-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

.bdt-viewport {
  position: absolute;
  right: 14px;
  top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.vp-btn {
  background: rgba(15, 23, 42, 0.78);
  color: #E2E8F0;
  border: 1px solid rgba(76, 201, 240, 0.3);
  padding: 6px 12px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.18s;
  backdrop-filter: blur(4px);
}
.vp-btn:hover { background: rgba(76, 201, 240, 0.15); border-color: #4CC9F0; }
.vp-btn.vp-fire { border-color: rgba(255, 77, 79, 0.4); color: #FF7875; }
.vp-btn.vp-fire:hover { background: rgba(255, 77, 79, 0.15); }
</style>