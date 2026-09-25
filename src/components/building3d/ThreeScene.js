// ThreeScene · 真实 WebGL 场景骨架
// ────────────────────────────────────────────────
// 职责：
//   • 创建 Scene / PerspectiveCamera / WebGLRenderer / OrbitControls
//   • 配置冷调数字孪生灯光（Ambient + Hemisphere + Directional ×2）
//   • 自适应 ResizeObserver（容器尺寸 → renderer / camera.aspect）
//   • 限制 OrbitControls 不让用户把建筑拖没
//   • 暴露 getScene() / getCamera() / getControls() 给上层使用
// ────────────────────────────────────────────────
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { COLORS } from './building3dUtils.js'

export class ThreeScene {
  constructor(container, canvas) {
    this.container = container
    this.canvas = canvas
    this._listeners = new Set() // 暴露给外部的 tick 回调

    // ── Scene ──
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(COLORS.bg)
    this.scene.fog = new THREE.Fog(COLORS.bg, 30, 90)

    // ── Camera（先用占位，模型加载后再 fit）──
    const w = Math.max(container.clientWidth, 1)
    const h = Math.max(container.clientHeight, 1)
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 1000)
    this.camera.position.set(20, 16, 28)
    this.camera.lookAt(0, 4, 0)

    // ── Renderer（antialias + 限制 DPR 防止高 DPI 设备过载）──
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(w, h, false)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15

    // ── 灯光（数字孪生冷调，但保证建筑可见）──
    const amb = new THREE.AmbientLight(0x6a7d97, 0.85)
    this.scene.add(amb)
    const hemi = new THREE.HemisphereLight(0x9fc8ff, 0x1a2235, 0.7)
    this.scene.add(hemi)
    const dir1 = new THREE.DirectionalLight(0xfff4e6, 1.15) // 主光：偏暖
    dir1.position.set(18, 30, 16)
    this.scene.add(dir1)
    const dir2 = new THREE.DirectionalLight(0x4cc9f0, 0.55) // 副光：电弧蓝
    dir2.position.set(-16, 10, -12)
    this.scene.add(dir2)

    // ── OrbitControls（45° 数字孪生斜视角，禁拖没）──
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.target.set(0, 4, 0)
    this.controls.minDistance = 8
    this.controls.maxDistance = 150
    this.controls.minPolarAngle = Math.PI * 0.15   // 不能完全俯视
    this.controls.maxPolarAngle = Math.PI * 0.48   // 不能水平
    this.controls.enablePan = true
    this.controls.screenSpacePanning = false

    // ── ResizeObserver（关键：监听容器本身而非 window）──
    this._resize = this._onResize.bind(this)
    this._ro = new ResizeObserver(this._resize)
    this._ro.observe(container)

    // ── Tick 循环 ──
    this._clock = new THREE.Clock()
    this._raf = null
    this._loop = this._loop.bind(this)
    this._loop()
  }

  _onResize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (!w || !h) return
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  // 公开方法：容器尺寸变化后由上层主动触发一次适配
  // （3D 被放在 v-if 浮层里时，容器从 display:none / 0 尺寸变为真实尺寸，
  //   ResizeObserver 不一定第一时间派发，因此挂载后主动 resize 一次更稳）
  resize() {
    this._onResize()
  }

  _loop() {
    this._raf = requestAnimationFrame(this._loop)
    const dt = this._clock.getDelta()
    const t = this._clock.getElapsedTime()
    this.controls.update()
    this._listeners.forEach((fn) => fn(dt, t))
    this.renderer.render(this.scene, this.camera)
  }

  onTick(fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  // 销毁
  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf)
    if (this._ro) this._ro.disconnect()
    this._listeners.clear()
    this.controls.dispose()
    // 视图按需挂载/卸载时（浮层开关）主动释放 WebGL 上下文，避免上下文数量耗尽
    try { this.renderer.forceContextLoss() } catch (e) { /* 部分环境不支持，忽略 */ }
    this.renderer.dispose()
  }
}