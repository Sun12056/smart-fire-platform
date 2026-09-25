// BuildingModel · GLB 加载 + 自动居中 + 楼层/区域索引
// ────────────────────────────────────────────────
// 职责：
//   • GLTFLoader 加载 BuildingDigitalTwin_FloorPlan_6F_3D_Open.glb
//   • 计算 BoundingBox → 自动居中、落地、标准化高度
//   • 遍历 mesh 建立 floorMap / zoneMap / exits / elMeshes / pickables
//   • 暴露给其它层：getFloorCenterY / getZoneCenter / getExit / applyHighlight
// ────────────────────────────────────────────────
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { COLORS, parseNodeName, snapshotMaterial } from './building3dUtils.js'

const FLOORS = [1, 2, 3, 4, 5, 6]
const ZONES = ['A区', 'B区', 'C区', 'D区']

export class BuildingModel {
  constructor(threeScene, url) {
    this.ts = threeScene
    this.url = url
    this.group = new THREE.Group()
    this.group.name = 'buildingGroup'
    threeScene.scene.add(this.group)

    // ── 索引结构 ──
    this.idx = {
      entries: [],
      floorCenterY: {},
      floorTopY: {},
      zones: {},
      exits: [],
      elMeshes: [],
      pickables: [],
      modelCenter: new THREE.Vector3(),
      modelSize: new THREE.Vector3(),
    }
    // 层级 group（按楼层/区域分组，便于显隐）
    this.floorGroups = {}   // floorId → THREE.Group
    this.zoneGroups = {}    // `${floorId}|${zone}` → THREE.Group
  }

  async load() {
    const loader = new GLTFLoader()
    return new Promise((resolve, reject) => {
      loader.load(
        this.url,
        (gltf) => {
          const model = gltf.scene
          this._normalize(model)
          this.group.add(model)
          this._buildIndex(model)
          this._recolor(model)
          this._hideStaticDeco(model)
          resolve(this)
        },
        undefined,
        (err) => reject(err)
      )
    })
  }

  // ── 归一化：探测真实朝上轴 → 旋转到 +Y → 居中 → 落地 → 高度统一为 13 ──
  _normalize(root) {
    root.updateWorldMatrix(true, true)

    // ── 1. 探测真实朝上：取 Floor_N_* 包围盒中心，看哪个轴的差异最大 ──
    const floorCenters = []
    root.traverse((obj) => {
      if (obj.isMesh && obj.geometry && /Floor_\d+/i.test(obj.name || '')) {
        obj.geometry.computeBoundingBox()
        const bb = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld)
        floorCenters.push({ name: obj.name, c: bb.getCenter(new THREE.Vector3()) })
      }
    })
    let upAxis = 'y'
    if (floorCenters.length >= 2) {
      const ranges = { x: 0, y: 0, z: 0 }
      const base = floorCenters[0].c
      for (let i = 1; i < floorCenters.length; i++) {
        const c = floorCenters[i].c
        for (const k of ['x', 'y', 'z']) ranges[k] = Math.max(ranges[k], Math.abs(c[k] - base[k]))
      }
      upAxis = Object.entries(ranges).sort((a, b) => b[1] - a[1])[0][0]
    }

    // ── 2. 旋转把真实朝上轴对齐到 +Y ──
    if (upAxis === 'z') {
      root.rotation.x = -Math.PI / 2   // Z-up → Y-up
    } else if (upAxis === 'x') {
      root.rotation.z = Math.PI / 2    // X-up → Y-up
    }
    root.updateWorldMatrix(true, true)

    // ── 3. 水平居中 + 落地 + 统一高度 ──
    const box = new THREE.Box3().setFromObject(root)
    const size = box.getSize(new THREE.Vector3())
    const targetH = 13
    if (size.y > 0.0001) {
      const s = targetH / size.y
      root.scale.multiplyScalar(s)
    }
    root.updateWorldMatrix(true, true)
    const box2 = new THREE.Box3().setFromObject(root)
    const c2 = box2.getCenter(new THREE.Vector3())
    root.position.x -= c2.x
    root.position.z -= c2.z
    root.position.y -= box2.min.y
    root.updateWorldMatrix(true, true)
  }

  // ── 遍历 mesh 建索引（材质克隆避免共享） ──
  _buildIndex(root) {
    const box = new THREE.Box3().setFromObject(root)
    box.getCenter(this.idx.modelCenter)
    box.getSize(this.idx.modelSize)

    root.updateWorldMatrix(true, true)
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return
      // 材质克隆（避免共享材质被统一修改）
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      obj.material = Array.isArray(obj.material)
        ? mats.map((m) => m.clone())
        : mats[0].clone()
      const tag = parseNodeName(obj.name || '')
      obj.geometry.computeBoundingBox()
      const center = new THREE.Vector3()
      obj.getWorldPosition(center)

      const entry = {
        obj,
        name: obj.name || '',
        tag,
        center,
        mats: Array.isArray(obj.material) ? obj.material : [obj.material],
        base: (Array.isArray(obj.material) ? obj.material : [obj.material]).map(snapshotMaterial),
      }
      this.idx.entries.push(entry)

      // 楼层/区域/出口/应急灯
      if (tag.floor) {
        if (tag.kind === 'slab') {
          this.idx.floorCenterY[tag.floor] = center.y
          const bb = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld)
          this.idx.floorTopY[tag.floor] = bb.max.y
        }
        if (tag.zone && (tag.kind === 'zone' || tag.kind === 'wall')) {
          const k = `${tag.floorId}|${tag.zone}`
          if (!this.idx.zones[k]) this.idx.zones[k] = { center: new THREE.Vector3(), box: new THREE.Box3(), meshes: [] }
          const bb = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld)
          this.idx.zones[k].box.union(bb)
          this.idx.zones[k].center.add(center)
          this.idx.zones[k].meshes.push(entry)
        }
        if (tag.kind === 'exit') this.idx.exits.push({ obj, center, floor: tag.floor })
        if (tag.kind === 'el')   this.idx.elMeshes.push(entry)
      }
      if (tag.floor && ['zone', 'slab', 'corridor', 'stair', 'wall'].includes(tag.kind)) {
        this.idx.pickables.push(entry)
      }
    })

    // 区域中心归一
    Object.values(this.idx.zones).forEach((z) => {
      if (z.meshes.length) z.center.multiplyScalar(1 / z.meshes.length)
    })
    // 缺失楼层兜底
    FLOORS.forEach((n) => {
      if (this.idx.floorCenterY[n] == null) this.idx.floorCenterY[n] = this.idx.modelCenter.y + (n - 3.5) * (this.idx.modelSize.y / 6)
      if (this.idx.floorTopY[n]    == null) this.idx.floorTopY[n]    = this.idx.floorCenterY[n] + this.idx.modelSize.y / 12
    })

    // 楼层水平包围盒（用于 SVG 坐标 → 世界坐标线性映射）
    this.floorBounds = {}
    this.idx.entries.forEach((e) => {
      if (!e.tag.floor) return
      const bb = e.obj.geometry.boundingBox.clone().applyMatrix4(e.obj.matrixWorld)
      const k = e.tag.floorId
      if (!this.floorBounds[k]) this.floorBounds[k] = bb.clone()
      else this.floorBounds[k].union(bb)
    })

    // 走廊 / 楼梯中心（供走廊/楼梯间设备定位）
    this.corridorCenter = {}
    this.stairCenters = {}
    this.idx.entries.forEach((e) => {
      if (!e.tag.floor) return
      if (e.tag.kind === 'corridor') {
        this.corridorCenter[e.tag.floorId] = e.center.clone()
      } else if (e.tag.kind === 'stair') {
        const k = e.tag.floorId
        if (!this.stairCenters[k]) this.stairCenters[k] = []
        // 同一楼梯可能由多个 mesh 组成：按 x 去重
        if (!this.stairCenters[k].some((c) => c.distanceTo(e.center) < 0.5)) {
          this.stairCenters[k].push(e.center.clone())
        }
      }
    })
    // 楼梯按 x 排序（东侧 x 大，西侧 x 小），与 mock「东侧楼梯/楼梯1..4」对应
    Object.values(this.stairCenters).forEach((arr) => arr.sort((a, b) => a.x - b.x))
  }

  // ── SVG 平面图坐标（viewBox 560×300）→ GLB 世界坐标 ──
  // 路网/设备 mock 数据与 GLB 模型同源（同一平面图生成），线性映射即可对齐
  svgToWorld(svgX, svgY, floorId) {
    const b = this.floorBounds[floorId]
    if (!b) return null
    const x = b.min.x + (svgX / 560) * (b.max.x - b.min.x)
    const z = b.min.z + (svgY / 300) * (b.max.z - b.min.z)
    return new THREE.Vector3(x, 0, z)
  }

  // ── 整体重塑材质色（更亮更可读） ──
  _recolor(root) {
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      const tag = parseNodeName(obj.name || '')
      mats.forEach((m) => {
        if (!m.color) return
        // 明亮的蓝灰系（从背景 #101827 中明显分离）
        if (tag.kind === 'slab')          m.color.setHex(0x3D5370)
        else if (tag.kind === 'corridor') m.color.setHex(0x354962)
        else if (tag.kind === 'stair')    m.color.setHex(0x46597A)
        else if (tag.kind === 'zone')     m.color.setHex(0x32445E)
        else if (tag.kind === 'wall')     m.color.setHex(0x4A6079)
        else if (tag.kind === 'floormarker') m.color.setHex(0x4CC9F0)
        else m.color.setHex(0x3A4A64)
        if ('roughness' in m) m.roughness = 0.7
        if ('metalness' in m) m.metalness = 0.1
        // 自发光底色，避免暗部死黑
        if (m.emissive && m.emissive.isColor) {
          m.emissive.setHex(0x1A2A44)
          m.emissiveIntensity = 0.55
        }
      })
    })
  }

  // ── 隐藏静态装饰（人员/示例火点/示例路线） ──
  _hideStaticDeco(root) {
    root.traverse((obj) => {
      if (!obj.isMesh) return
      const name = obj.name || ''
      const tag = parseNodeName(name)
      if (tag.kind === 'person' || name === 'Fire_4F_A' || /^Route/.test(name)) {
        obj.visible = false
      }
    })
  }

  // ── 高亮：选中楼层 / 选中区域 / 火区（由调用方传入色 + 强度） ──
  applyHighlight({ selFloorNum, selZone, fireArea }) {
    if (!this.idx.entries.length) return
    this.idx.entries.forEach((e) => {
      // 复位
      e.mats.forEach((m, i) => this._resetMat(m, e.base[i]))
      if (!e.tag.floor) return

      const isSelFloor = selFloorNum && e.tag.floor === selFloorNum
      const isOtherFloor = selFloorNum && e.tag.floor !== selFloorNum
      // 非选中楼层：轻微降透明（仍可见）
      if (isOtherFloor) {
        e.mats.forEach((m) => {
          if (m.transparent !== undefined) {
            m.transparent = true
            m.opacity = 0.25
            m.depthWrite = false
          }
        })
      }
      // 选中区域：发光强调（仅选中楼层内）
      if (selZone && e.tag.zone === selZone && (!selFloorNum || e.tag.floor === selFloorNum) && this._hasEmissive(e)) {
        e.mats.forEach((m) => {
          m.emissive.setHex(COLORS.zoneHi)
          m.emissiveIntensity = 0.7
        })
      }
    })
  }

  applyFireHighlight(fe) {
    if (!fe) return
    const fnum = parseInt(fe.floor)
    this.idx.entries.forEach((e) => {
      if (e.tag.floor === fnum && (e.tag.zone === fe.area || e.tag.kind === 'wall') && this._hasEmissive(e)) {
        e.mats.forEach((m) => {
          m.emissive.setHex(COLORS.fire)
          m.emissiveIntensity = 1.0
        })
      }
    })
  }

  _hasEmissive(e) {
    return e.mats.some((m) => m.emissive && m.emissive.isColor)
  }

  _resetMat(m, base) {
    if (!base || !m) return
    if (m.color && m.color.isColor) m.color.setHex(base.color)
    if (base.hasEmissive && m.emissive && m.emissive.isColor) {
      m.emissive.setHex(base.emissive)
      m.emissiveIntensity = base.emissiveIntensity
    } else if (m.emissive && m.emissive.isColor) {
      m.emissive.setHex(0x000000)
    }
    m.opacity = base.opacity
    m.transparent = base.transparent
    m.depthWrite = base.depthWrite
  }

  // ── 外部查询 ──
  getFloorCenterY(n) { return this.idx.floorCenterY[n] }
  getFloorTopY(n)    { return this.idx.floorTopY[n] }
  getZoneBox(floorId, zone) { return this.idx.zones[`${floorId}|${zone}`] }
  getExits(floor)    { return this.idx.exits.filter((e) => e.floor === floor) }
  getPickables()     { return this.idx.pickables }
  getCenter()        { return this.idx.modelCenter }
  getSize()          { return this.idx.modelSize }
}