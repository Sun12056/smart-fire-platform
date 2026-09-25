<template>
  <div class="dashboard">
    <!-- ══════════════════════════════════════
         顶部工具栏：楼栋选择 + 功能按钮
         ══════════════════════════════════════ -->
    <div class="top-bar">
      <!-- 楼栋选择 -->
      <div class="building-selector" v-if="viewMode !== 'buildings'">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
          <polyline points="9,22 9,12 15,12 15,22"/>
        </svg>
        <select v-model="selectedBuildingId" class="building-select" @change="onBuildingChange">
          <option v-for="b in store.buildings" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6,9 12,15 18,9"/></svg>
      </div>

      <!-- 当前楼栋副标题（楼栋名称由左侧选择器唯一显示，避免重复） -->
      <div class="building-title">
        <span class="building-subtitle">{{ viewMode === 'buildings' ? '消防数字孪生 · 建筑总览' : '消防数字孪生 · 6 层平面图' }}</span>
      </div>

      <!-- 右侧工具 -->
      <div class="top-actions">
        <!-- 疏散路线规划 -->
        <button class="action-btn route" @click="router.push('/route-plan')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="6" cy="6" r="2.5"/>
            <circle cx="18" cy="18" r="2.5"/>
            <path d="M6 8.5V14a2 2 0 0 0 2 2h6.5"/>
            <path d="M16 4.5h2.5V11"/>
          </svg>
          疏散路线规划
        </button>
        <!-- 应急联动 -->
        <button class="action-btn emergency" :class="{ active: showEmergencyPanel }" @click="showEmergencyPanel = !showEmergencyPanel">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
          应急联动
        </button>
        <!-- 模拟火灾 -->
        <button class="action-btn fire" @click="handleSimulateFire">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 2C8 6 6 9 6 13a6 6 0 0012 0c0-2-1-4-2-5 0 2-1 3-2 3 0-3-2-6-2-9z"/>
          </svg>
          模拟火灾
        </button>
        <!-- 模拟告警 -->
        <button class="action-btn warning" @click="store.simulateAlarm()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
          模拟告警
        </button>
        <!-- 路网调试 -->
        <button class="action-btn debug" :class="{ active: store.routeDebug }" @click="store.toggleRouteDebug()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/>
            <path d="M7.5 7.5L11 16M16.5 7.5L13 16M8 6h8"/>
          </svg>
          路网调试 {{ store.routeDebug ? '开' : '关' }}
        </button>
      </div>
    </div>

    <!-- 顶部人员感知横条已按六阶段闭环流程移除 -->

    <!-- ══════════════════════════════════════
         火灾重要消息提醒（fireStore.fireEvent 驱动；同一事件仅提醒一次，管理员确认后关闭）
         ══════════════════════════════════════ -->
    <!-- ══════════ 应急处置流程进度条（六阶段；仅火情存在时展示） ══════════ -->
    <div v-if="store.fireEvent && store.emergencyStage > 0" class="emg-stepper">
      <div
        v-for="(st, i) in emgSteps" :key="st.key"
        class="emg-step"
        :class="{ done: store.emergencyStage > st.n, cur: store.emergencyStage === st.n }"
      >
        <span class="emg-ico">{{ store.emergencyStage > st.n ? '✓' : store.emergencyStage === st.n ? '●' : '○' }}</span>
        <span class="emg-name">{{ st.label }}</span>
        <span v-if="i < emgSteps.length - 1" class="emg-line"></span>
      </div>
      <button class="emg-reset" @click="resetEmergencyDemo" title="解除火情：关闭火灾/危险区/路线/应急照明，人员与疏散灯复位">✨ 解除火情</button>
    </div>

    <!-- 「重要消防事件」大模块已删除：火情通过顶部流程状态、平面图红色危险区、右侧信息栏与业务弹窗表达 -->


    <!-- ══════════════════════════════════════
         主区：左楼层卡片网格 + 右侧信息栏
         ══════════════════════════════════════ -->
    <div class="dash-main">
      <!-- ═══ 楼栋总览 / 楼层网格 / 平面图：三级视图切换 ═══ -->
      <transition name="view-fade" mode="out-in">
        <div :key="viewMode" class="dash-view">
          <!-- 楼栋总览：3D 主体 + 楼栋卡片（数字孪生作为视觉中心） -->
          <div v-if="viewMode === 'buildings'" class="building-overview">
            <div class="bo-head">
              <span class="bo-title">数字孪生建筑总览</span>
              <span class="bo-sub">点击右侧楼栋卡片可切换目标建筑 · 进入楼层查看 1F~6F 平面图</span>
            </div>
            <div class="bo-body">
              <!-- 左侧：3D 主体 -->
              <div class="bo-3d">
                <BuildingDigitalTwin />
                <div class="bo-3d-actions">
                  <button class="bo-action" @click="enterBuilding(selectedBuildingId || 'B003')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                    进入楼层平面图
                  </button>
                </div>
              </div>
              <!-- 右侧：楼栋卡片列表 -->
              <div class="bo-side">
                <div class="bo-side-title">建筑群（{{ store.buildings.length }} 栋）</div>
                <div class="bo-card-list">
                  <div
                    v-for="b in store.buildings" :key="b.id"
                    class="bo-card" :class="{ cur: selectedBuildingId === b.id, [b.status]: true }"
                    @click="selectBuilding(b.id)"
                  >
                    <div class="bo-card-head">
                      <span class="bo-card-name">{{ b.name }}</span>
                      <span class="bo-card-no num-font">{{ b.id }}</span>
                    </div>
                    <div class="bo-card-type">{{ b.type }}</div>
                    <div class="bo-card-foot">
                      <span class="bo-dot" :style="{ background: buildingStatusColor(b.status) }"></span>
                      <span class="bo-status" :style="{ color: buildingStatusColor(b.status) }">{{ buildingStatusText(b.status) }}</span>
                      <span class="bo-stat"><b class="num-font">{{ buildingPersonCount(b.name) }}</b>人</span>
                      <span class="bo-stat"><b class="num-font">{{ buildingDeviceCount(b.name) }}</b>设备</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 楼层网格 / 平面图（viewMode = 'floors' | 'floorplan'，按 expandedFloor 二选一） -->
          <div v-else class="main-zone">
            <!-- 楼层快捷选择 + 3D 模型入口（3D 默认不显示，点击后浮层查看）+ 返回楼栋总览 -->
            <div class="floor-tabs">
              <button v-if="viewMode === 'floors'" class="back-to-buildings" @click="backToBuildings">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                返回楼栋总览
              </button>
              <button class="open-3d-btn" :class="{ active: show3DViewer }" @click="open3DViewer" title="打开 3D 楼栋模型查看器（浮层展示，不占用平面图空间）">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M12 2l9 5v10l-9 5-9-5V7z"/>
                  <path d="M3 7l9 5 9-5M12 12v10"/>
                </svg>
                3D 模型
              </button>
              <div v-if="currentBuilding" class="ft-tabs">
                <span class="ft-label">楼层</span>
                <button
                  v-for="f in currentFloorData" :key="f.id"
                  class="ft-tab" :class="{ cur: store.dashboardView.selectedFloorId === f.id, fire: isFloorOnFire(f.id) }"
                  @click="store.selectFloor(f.id)"
                >{{ f.id }}</button>
                <button class="ft-tab all" :class="{ cur: !store.dashboardView.selectedFloorId }" @click="store.selectFloor(null)">全楼</button>
              </div>
            </div>
    <div class="floor-grid" v-if="currentBuilding && !expandedFloor">
      <div
        v-for="floor in currentFloorData"
        :key="floor.id"
        class="floor-card"
        :class="{ 'fire-floor': isFloorOnFire(floor.id) }"
        @click="openFloorZoom(floor)"
      >
        <!-- 楼层名称标签 -->
        <div class="floor-label">
          <span class="floor-num">{{ floor.id }}</span>
          <span v-if="isFloorOnFire(floor.id)" class="fire-tag">🔥 火警</span>
              <span class="stage-chip" v-if="store.fireEvent && isFloorOnFire(floor.id) && store.emergencyStage > 0">
                {{ emgStages[store.emergencyStage] }}
              </span>
          <span v-else class="floor-note">{{ floorNote(floor.id) }}</span>
        </div>

        <!-- SVG 平面图 -->
        <svg :viewBox="`0 0 ${SVG_W} ${SVG_H}`" class="floor-svg" @click="deselectDevice">
          <!-- 背景 -->
          <rect width="100%" height="100%" :fill="isFloorOnFire(floor.id) ? 'rgba(40,15,15,0.7)' : 'rgba(10,14,26,0.6)'" rx="4"/>

          <!-- 建筑主体轮廓 -->
          <rect x="40" y="20" width="480" height="280" :fill="isFloorOnFire(floor.id) ? 'rgba(60,20,20,0.6)' : 'rgba(20,30,50,0.6)'" stroke="rgba(76,201,240,0.3)" stroke-width="1.5" rx="3"/>

          <!-- 墙体（v-for WALLS） -->
          <rect
            v-for="(w, i) in WALLS"
            :key="'w' + i"
            :x="w.x" :y="w.y" :width="w.w" :height="w.h"
            :fill="w.type === 'room' ? 'rgba(180,210,240,0.4)' : 'rgba(148,163,184,0.55)'"
            :stroke="w.type === 'room' ? '#94A3B8' : '#64748B'"
            :stroke-width="w.type === 'room' ? 0.8 : 1"
            rx="2"
          />

          <!-- 走廊（CORRIDOR 数据） -->
          <rect :x="CORRIDOR.x" :y="CORRIDOR.y" :width="CORRIDOR.w" :height="CORRIDOR.h" fill="rgba(30,40,60,0.5)" rx="1"/>

          <!-- 房间（v-for ROOMS，label 来自 FLOOR_CONFIG） -->
          <g v-for="room in roomDefsForFloor(floor.id)" :key="'r' + room.id">
            <rect :x="room.x" :y="room.y" :width="room.w" :height="room.h" fill="none" :stroke="'rgba(76,201,240,0.3)'" stroke-width="0.8" rx="2"/>
            <text :x="room.x + room.w / 2" :y="room.y + room.h / 2 - 4" text-anchor="middle" font-size="13" fill="#94A3B8" font-weight="700">{{ room.name }}</text>
            <text :x="room.x + room.w / 2" :y="room.y + room.h / 2 + 10" text-anchor="middle" font-size="9.5" fill="#64748B">{{ room.label }}</text>
          </g>

          <!-- 楼梯（v-for STAIRS） -->
          <g v-for="stair in STAIRS" :key="'s' + stair.id">
            <rect :x="stair.x" :y="stair.y" :width="stair.w" :height="stair.h" fill="rgba(30,40,60,0.5)" stroke="rgba(76,201,240,0.3)" stroke-width="1" rx="2"/>
            <text :x="stair.x + stair.w / 2" :y="stair.y - 4" text-anchor="middle" font-size="9.5" fill="#94A3B8">{{ stair.name }}</text>
          </g>

          <!-- 门（v-for DOORS） -->
          <rect
            v-for="door in DOORS"
            :key="'d' + door.id"
            :x="door.x - 4" :y="door.y - 2" width="8" height="4"
            fill="#64748B" rx="1"
          />

          <!-- 安全出口（仅 1F：绿色 EXIT 标识 + 完整“安全出口”文字） -->
          <g v-if="floor.id === '1F'">
            <g v-for="exit in EXITS" :key="'e' + exit.id">
              <rect :x="exit.x - exit.w / 2" :y="exit.y - exit.h / 2" :width="exit.w" :height="exit.h" fill="#22C55E" rx="2"/>
              <text :x="exit.x" :y="exit.y + 5" text-anchor="middle" font-size="10.5" font-weight="700" fill="rgba(30,40,60,0.5)">安全出口</text>
            </g>
          </g>
          <!-- 其他楼层：楼梯口标“↓ 安全出口”（仅可用楼梯；y 贴底 clamp 防越界裁切） -->
          <g v-else>
            <text
              v-for="stair in activeStairsForFloor(floor.id)"
              :key="'se' + stair.id"
              :x="stair.x + stair.w / 2"
              :y="Math.min(stair.y + stair.h + 11, 296)"
              text-anchor="middle"
              font-size="9.5"
              fill="#22C55E"
              font-weight="700"
            >↓ 安全出口</text>
          </g>
          <!-- 火灾热区（动态匹配 fireEvent.area：仅危险房间标红，其余区域保持白蓝对比） -->
          <g v-if="floorFireRoom(floor.id)">
            <rect :x="floorFireRoom(floor.id).x" :y="floorFireRoom(floor.id).y" :width="floorFireRoom(floor.id).w" :height="floorFireRoom(floor.id).h" fill="rgba(239,68,68,0.25)" stroke="#EF4444" stroke-width="2" rx="2" class="fire-zone-pulse" />
            <text :x="floorFireRoom(floor.id).x + floorFireRoom(floor.id).w / 2" :y="floorFireRoom(floor.id).y + 30" text-anchor="middle" font-size="24">🔥</text>
            <text :x="floorFireRoom(floor.id).x + floorFireRoom(floor.id).w / 2" :y="floorFireRoom(floor.id).y + floorFireRoom(floor.id).h - 12" text-anchor="middle" font-size="10" fill="#EF4444" font-weight="700">{{ floorFireRoom(floor.id).name }} 危险区</text>
          </g>


          <!-- 疏散路线（规划楼层：store.getAllZoneRoutes() 推荐 + 备用 + 火灾路线） -->
          <g v-if="floor.id === store.routeFloorId" class="route-layer">
            <g v-for="zr in allZoneRoutes" :key="'dr-' + zr.zone">
              <!-- 备用路线：虚线 -->
              <polyline
                v-if="backupSegments[zr.zone] && backupSegments[zr.zone].length"
                :points="backupSegments[zr.zone].map(p => p.x + ',' + p.y).join(' ')"
                class="route-backup"
                :style="{ stroke: zr.color }"
              />
              <!-- 推荐路线：实线 / 火灾路线：红色虚线 -->
              <polyline
                v-if="zr.segment.length"
                :points="zr.segment.map(p => p.x + ',' + p.y).join(' ')"
                :class="recStatusMap[zr.zone] === 'BLOCKED' ? 'route-fire' : 'route-active'"
                :style="{
                  stroke: recStatusMap[zr.zone] === 'BLOCKED' ? '#EF4444' : zr.color,
                  opacity: store.selectedZone === zr.zone ? 1 : 0.5,
                  filter: store.selectedZone === zr.zone ? 'drop-shadow(0 0 4px ' + zr.color + ')' : 'none'
                }"
              />
              <circle v-if="zr.segment.length" :cx="zr.segment[0].x" :cy="zr.segment[0].y" r="5" :fill="zr.color" class="route-start" />
            </g>
          </g>

          <!-- 路网调试层 -->
          <g v-if="netTopo" class="net-debug" pointer-events="none">
            <rect v-for="(w, i) in netTopo.walls" :key="'dw' + i" :x="w.x" :y="w.y" :width="w.w" :height="w.h" fill="rgba(239,68,68,0.1)" stroke="rgba(239,68,68,0.4)" stroke-width="1" stroke-dasharray="4 3" />
            <line v-for="(e, i) in netEdges" :key="'de' + i" :x1="e.x1" :y1="e.y1" :x2="e.x2" :y2="e.y2" stroke="rgba(34,197,94,0.4)" stroke-width="1" />
            <circle v-for="(n, i) in netTopo.nodes" :key="'dn' + i" :cx="n.x" :cy="n.y" r="3" :fill="netNodeColor(n.type)" stroke="rgba(255,255,255,0.2)" stroke-width="0.5" />
            <text v-for="(n, i) in netTopo.nodes" :key="'dt' + i" :x="n.x + 4" :y="n.y + 3" font-size="7" fill="#94A3B8">{{ netTypeShort(n.type) }}</text>
          </g>

          <!-- 疏散设备节点（v-for store 同源设备，floorPlanData 布点） -->
          <g
            v-for="dev in getDevicesForFloor(floor.id)"
            :key="dev.id"
            :class="nodeClass(dev)"
            @click.stop="selectDevice(dev)"
            @mouseenter="onDeviceHover(dev, $event)"
            @mousemove="onDeviceMove($event)"
            @mouseleave="onDeviceLeave()"
          >
            <circle v-if="dev.type !== 'exit_sign'" :cx="dev.x" :cy="dev.y" :r="haloR(dev)" :fill="haloFill(dev)" fill-opacity="0.15" />
            <!-- 疏散指示灯：指示牌（深色底 + 绿色箭头，箭头永远为绿色，应急时绿色强闪） -->
            <template v-if="dev.type === 'evacuation_light'">
              <rect :x="dev.x - 8.5" :y="dev.y - 6" width="17" height="12" rx="3" :fill="shapeFill(dev)" :stroke="boardStroke(dev)" stroke-width="1" />
              <text :x="dev.x" :y="dev.y + 3.5" text-anchor="middle" font-size="11" font-weight="900" fill="#39FF88">{{ dirArrow(dev) }}</text>
            </template>
            <!-- 应急照明灯：暖白照明圆（应急时白光强闪呼吸） -->
            <template v-else-if="dev.type === 'emergency_light'">
              <circle :cx="dev.x" :cy="dev.y" :r="dev.status === 'emergency' ? 7 : 6" :fill="shapeFill(dev)" :class="dev.status === 'emergency' ? 'emg-pulse' : ''" />
            </template>
            <!-- 烟感探测器：小方形 -->
            <template v-else-if="dev.type === 'smoke_detector'">
              <rect :x="dev.x - 3" :y="dev.y - 3" width="6" height="6" rx="1" :fill="shapeFill(dev)" />
            </template>
            <!-- 毫米波雷达：小菱形 -->
            <template v-else-if="dev.type === 'radar_sensor'">
              <rect :x="dev.x - 3.5" :y="dev.y - 3.5" width="7" height="7" :fill="shapeFill(dev)" :transform="`rotate(45 ${dev.x} ${dev.y})`" />
            </template>
            <!-- 安全出口：由 1F 绿色出口框统一表现（不再叠加 EXIT 小矩形） -->
          </g>

          <!-- 人员感知节点 -->
          <g
            v-for="p in getPersonsForFloor(floor.id)"
            :key="p.id"
            class="person-node"
            :class="getPersonStatus(p)"
            @click.stop="selectPerson(p)"
          >
            <!-- 疏散中人员：带路径动画 -->
            <g :class="'person-evac-' + (p.zone || p.area)">
              <!-- 正常人员：静态圆 -->
              <circle v-if="!store.evacRun || p.status !== 'evacuating'"
                :cx="p.x" :cy="p.y" r="6" :fill="personStatusColor(p)" stroke="rgba(255,255,255,0.3)" stroke-width="1" opacity="0.85"/>
              <!-- 疏散中人员：闪烁移动 -->
              <circle v-else
                :cx="p.x" :cy="p.y" r="7" :fill="personStatusColor(p)" opacity="0.9">
                <animate attributeName="opacity" values="0.9;0.4;0.9" :dur="0.6 + (p.x%5)*0.1 + 's'" repeatCount="indefinite"/>
                <animate attributeName="r" values="7;5;7" :dur="0.5 + (p.y%4)*0.12 + 's'" repeatCount="indefinite"/>
              </circle>
              <!-- 危险区人员：红色警告 -->
              <circle v-if="p.status === 'warning'" :cx="p.x" :cy="p.y" r="10" fill="none" stroke="#FF3B30" stroke-width="1.5" opacity="0.7">
                <animate attributeName="r" values="10;14;10" dur="1s" repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0.7;0.2;0.7" dur="1s" repeatCount="indefinite"/>
              </circle>
            </g>
          </g>

          <!-- 选中设备高亮外圈（在设备之上） -->
          <circle
            v-if="selectedDevice && selectedDevice.floorId === floor.id"
            :cx="selectedDevice.x" :cy="selectedDevice.y" r="14"
            fill="none" stroke="rgba(76,201,240,0.3)" stroke-width="3" class="sel-ring"
          />

          <!-- 设备统计角标已移除：计数并入卡片底部信息条 -->
        </svg>

        <!-- 楼层底部信息 -->
        <div class="floor-footer">
          <span class="floor-stat">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
            {{ getPersonCount(floor.id) }} 人
          </span>
          <span class="floor-stat">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
            {{ getDeviceCount(floor.id) }} 台设备
          </span>
          <span class="st-chip" :class="floorStatusClass(floor.id)">{{ floorStatusText(floor.id) }}</span>
          <button class="zoom-btn" @click.stop="openFloorZoom(floor)">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35M11 8v6M8 11h6"/></svg>
            放大
          </button>
        </div>
      </div>
    </div>

    <!-- 无楼栋提示 -->
    <div v-else-if="!currentBuilding" class="empty-hint">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#E2E8F0" stroke-width="1.5">
        <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
        <polyline points="9,22 9,12 15,12 15,22"/>
      </svg>
      <p>请从上方选择楼栋开始数字孪生巡检</p>
    </div>
        <!-- ══════════════════════════════════════
             楼层放大视图（内联展开替代楼层卡片网格：点击卡片放大 → 返回六层总览，无弹窗/无路由）
             ══════════════════════════════════════ -->
        <div v-else class="expanded-view">
          <!-- 放大视图头部：返回 + 楼层快速切换 + 缩放控制 -->
          <div class="expanded-head">
            <button class="back-btn" @click="backToOverview" title="返回六层总览">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
              返回楼层总览
            </button>
            <div class="expanded-title">
              <span class="expanded-floor-name num-font">{{ expandedFloor.id }}</span>
              <span class="expanded-sub">{{ floorNote(expandedFloor.id) }}</span>
              <span v-if="isFloorOnFire(expandedFloor.id)" class="fire-tag">🔥 火警</span>
            </div>
            <div class="floor-chips">
              <button
                v-for="f in currentFloorData" :key="'chip' + f.id"
                class="floor-chip" :class="{ active: f.id === expandedFloor.id, fire: isFloorOnFire(f.id) }"
                @click="openFloorZoom(f)"
              >{{ f.id }}</button>
            </div>
            <div class="zoom-controls">
              <button class="zoom-ctrl-btn" @click="zoomScale = Math.max(0.5, zoomScale - 0.25)" title="缩小">−</button>
              <span class="zoom-pct num-font">{{ Math.round(zoomScale * 100) }}%</span>
              <button class="zoom-ctrl-btn" @click="zoomScale = Math.min(3, zoomScale + 0.25)" title="放大">+</button>
              <button class="zoom-ctrl-btn fit" @click="zoomScale = 1; zoomPanX = 0; zoomPanY = 0">适应</button>
            </div>
          </div>

          <div class="expanded-body">
            <!-- 左：完整楼层平面图（viewBox 0 0 560 300 + preserveAspectRatio meet，完整显示不裁切） -->
            <div
              class="expanded-canvas"
              ref="zoomCanvas"
              @wheel.prevent="onWheel"
              @mousedown="onPanStart"
              @mousemove="onPanMove"
              @mouseup="onPanEnd"
              @mouseleave="onPanEnd"
              :style="{ cursor: isPanning ? 'grabbing' : 'grab' }"
            >
              <svg
                :viewBox="`0 0 ${SVG_W} ${SVG_H}`"
                preserveAspectRatio="xMidYMid meet"
                class="expanded-svg"
                :style="{
                  transform: `scale(${zoomScale}) translate(${zoomPanX}px, ${zoomPanY}px)`,
                  transformOrigin: 'center center'
                }"
                @click="deselectDevice"
              >
                <!-- 背景 -->
                <rect width="100%" height="100%" :fill="isFloorOnFire(expandedFloor.id) ? 'rgba(40,15,15,0.7)' : 'rgba(10,14,26,0.6)'" rx="4"/>

                <!-- 建筑主体 -->
                <rect x="40" y="20" width="480" height="280" :fill="isFloorOnFire(expandedFloor.id) ? 'rgba(60,20,20,0.6)' : 'rgba(20,30,50,0.6)'" stroke="rgba(76,201,240,0.3)" stroke-width="1.5" rx="3"/>

                <!-- 墙体 -->
                <rect
                  v-for="(w, i) in WALLS"
                  :key="'zw' + i"
                  :x="w.x" :y="w.y" :width="w.w" :height="w.h"
                  :fill="w.type === 'room' ? 'rgba(180,210,240,0.4)' : 'rgba(148,163,184,0.55)'"
                  :stroke="w.type === 'room' ? '#94A3B8' : '#64748B'"
                  :stroke-width="w.type === 'room' ? 0.8 : 1"
                  rx="2"
                />

                <!-- 走廊 -->
                <rect :x="CORRIDOR.x" :y="CORRIDOR.y" :width="CORRIDOR.w" :height="CORRIDOR.h" fill="rgba(30,40,60,0.5)" rx="1"/>

                <!-- 房间 -->
                <g v-for="room in roomDefsForFloor(expandedFloor.id)" :key="'zr' + room.id">
                  <rect :x="room.x" :y="room.y" :width="room.w" :height="room.h" fill="none" :stroke="'rgba(76,201,240,0.3)'" stroke-width="0.8" rx="2"/>
                  <text :x="room.x + room.w / 2" :y="room.y + room.h / 2 - 6" text-anchor="middle" font-size="17" fill="#94A3B8" font-weight="700">{{ room.name }}</text>
                  <text :x="room.x + room.w / 2" :y="room.y + room.h / 2 + 12" text-anchor="middle" font-size="12" fill="#64748B">{{ room.label }}</text>
                </g>

                <!-- 楼梯 -->
                <g v-for="stair in STAIRS" :key="'zs' + stair.id">
                  <rect :x="stair.x" :y="stair.y" :width="stair.w" :height="stair.h" fill="rgba(30,40,60,0.5)" stroke="rgba(76,201,240,0.3)" stroke-width="1" rx="2"/>
                  <text :x="stair.x + stair.w / 2" :y="stair.y - 5" text-anchor="middle" font-size="11.5" fill="#94A3B8">{{ stair.name }}</text>
                </g>

                <!-- 门 -->
                <rect
                  v-for="door in DOORS"
                  :key="'zd' + door.id"
                  :x="door.x - 4" :y="door.y - 2" width="8" height="4"
                  fill="#64748B" rx="1"
                />

                <!-- 安全出口：1F 绿底标识；其余楼层楼梯口标 ↓（仅可用楼梯；贴底 clamp 防越界裁切） -->
                <g v-if="expandedFloor.id === '1F'">
                  <g v-for="exit in EXITS" :key="'ze' + exit.id">
                    <rect :x="exit.x - exit.w / 2" :y="exit.y - exit.h / 2" :width="exit.w" :height="exit.h" fill="#22C55E" rx="2"/>
                    <text :x="exit.x" :y="exit.y + 4" text-anchor="middle" font-size="11" font-weight="700" fill="rgba(30,40,60,0.5)">安全出口</text>
                  </g>
                </g>
                <g v-else>
                  <text
                    v-for="stair in activeStairsForFloor(expandedFloor.id)"
                    :key="'zse' + stair.id"
                    :x="stair.x + stair.w / 2"
                    :y="Math.min(stair.y + stair.h + 14, 296)"
                    text-anchor="middle"
                    font-size="12"
                    fill="#22C55E"
                    font-weight="700"
                  >↓ 安全出口</text>
                </g>

                <!-- 火灾热区（fireEvent 动态驱动，不写死区域） -->
                <g v-if="fireRoomDef">
                  <rect
                    :x="fireRoomDef.x" :y="fireRoomDef.y" :width="fireRoomDef.w" :height="fireRoomDef.h"
                    fill="rgba(239,68,68,0.25)" stroke="#EF4444" stroke-width="2" rx="2" class="fire-zone-pulse"
                  />
                  <text :x="fireRoomDef.x + fireRoomDef.w / 2" :y="fireRoomDef.y + 36" text-anchor="middle" font-size="30">🔥</text>
                  <text :x="fireRoomDef.x + fireRoomDef.w / 2" :y="fireRoomDef.y + fireRoomDef.h - 16" text-anchor="middle" font-size="12" fill="#EF4444" font-weight="700">{{ store.fireEvent.area }} 火灾危险区</text>
                </g>

                <!-- 疏散路线：确认方案高亮执行线（stage5 流动）+ 其余区域推荐/备用线 -->
                <g v-if="expandedFloor.id === store.routeFloorId" class="route-layer">
                  <polyline
                    v-if="activeRouteSegment.length && activePlan && activePlan.status !== 'BLOCKED'"
                    :points="activeRouteSegment.map(p => p.x + ',' + p.y).join(' ')"
                    :class="store.emergencyStage >= 4 ? 'route-execute' : 'route-active'"
                    :style="{ stroke: store.emergencyStage >= 4 ? '#4CC9F0' : '#4361EE' }"
                  />
                  <g v-for="zr in allZoneRoutes" :key="'zdr-' + zr.zone">
                    <template v-if="!(store.fireEvent && zr.zone === store.fireEvent.area)">
                      <polyline
                        v-if="backupSegments[zr.zone] && backupSegments[zr.zone].length"
                        :points="backupSegments[zr.zone].map(p => p.x + ',' + p.y).join(' ')"
                        class="route-backup"
                        :style="{ stroke: zr.color }"
                      />
                      <polyline
                        v-if="zr.segment.length"
                        :points="zr.segment.map(p => p.x + ',' + p.y).join(' ')"
                        :class="recStatusMap[zr.zone] === 'BLOCKED' ? 'route-fire' : 'route-backup'"
                        :style="{ stroke: recStatusMap[zr.zone] === 'BLOCKED' ? '#EF4444' : zr.color, opacity: store.selectedZone === zr.zone ? 1 : 0.35 }"
                      />
                    </template>
                  </g>
                </g>

                <!-- 路网调试层 -->
                <g v-if="netTopo" class="net-debug" pointer-events="none">
                  <rect v-for="(w, i) in netTopo.walls" :key="'zdw' + i" :x="w.x" :y="w.y" :width="w.w" :height="w.h" fill="rgba(239,68,68,0.1)" stroke="rgba(239,68,68,0.4)" stroke-width="1" stroke-dasharray="4 3" />
                  <line v-for="(e, i) in netEdges" :key="'zde' + i" :x1="e.x1" :y1="e.y1" :x2="e.x2" :y2="e.y2" stroke="rgba(34,197,94,0.4)" stroke-width="1" />
                  <circle v-for="(n, i) in netTopo.nodes" :key="'zdn' + i" :cx="n.x" :cy="n.y" r="4" :fill="netNodeColor(n.type)" stroke="rgba(255,255,255,0.2)" stroke-width="0.5" />
                  <text v-for="(n, i) in netTopo.nodes" :key="'zdt' + i" :x="n.x + 5" :y="n.y + 4" font-size="9" fill="#94A3B8">{{ netTypeShort(n.type) }}</text>
                </g>

                <!-- 设备节点（store 同源） -->
                <g
                  v-for="dev in getDevicesForFloor(expandedFloor.id)"
                  :key="'zd-' + dev.id"
                  :class="nodeClass(dev)"
                  @click.stop="selectDevice(dev)"
                  @mouseenter="onDeviceHover(dev, $event)"
                  @mousemove="onDeviceMove($event)"
                  @mouseleave="onDeviceLeave()"
                >
                  <circle v-if="dev.type !== 'exit_sign'" :cx="dev.x" :cy="dev.y" :r="haloR(dev)" :fill="haloFill(dev)" fill-opacity="0.15" />
                  <template v-if="dev.type === 'evacuation_light'">
                    <rect :x="dev.x - 10.5" :y="dev.y - 7.5" width="21" height="15" rx="3.5" :fill="shapeFill(dev)" :stroke="boardStroke(dev)" stroke-width="1.2" />
                    <text :x="dev.x" :y="dev.y + 4.5" text-anchor="middle" font-size="13" font-weight="900" fill="#39FF88">{{ dirArrow(dev) }}</text>
                  </template>
                  <template v-else-if="dev.type === 'emergency_light'">
                    <circle :cx="dev.x" :cy="dev.y" :r="dev.status === 'emergency' ? 7.5 : 6.5" :fill="shapeFill(dev)" :class="dev.status === 'emergency' ? 'emg-pulse' : ''" />
                  </template>
                  <template v-else-if="dev.type === 'smoke_detector'">
                    <rect :x="dev.x - 4" :y="dev.y - 4" width="8" height="8" rx="1" :fill="shapeFill(dev)" />
                  </template>
                  <template v-else-if="dev.type === 'radar_sensor'">
                    <rect :x="dev.x - 4.5" :y="dev.y - 4.5" width="9" height="9" :fill="shapeFill(dev)" :transform="`rotate(45 ${dev.x} ${dev.y})`" />
                  </template>
                  <!-- 安全出口：由 1F 绿色出口框统一表现（不再叠加 EXIT 小矩形） -->
                  <!-- 设备编号不再显示在平面图上（按要求移至设备信息面板） -->
                </g>

                <!-- 人员感知节点 -->
                <g
                  v-for="p in getPersonsForFloor(expandedFloor.id, 14)"
                  :key="'zp-' + p.id"
                  class="person-node"
                  :class="getPersonStatus(p)"
                  @click.stop="selectPerson(p)"
                >
                  <!-- 疏散中人员：带路径动画 -->
                  <g :class="'person-evac-' + (p.zone || p.area)">
                    <!-- 正常人员：静态圆 -->
                    <circle v-if="!store.evacRun || p.status !== 'evacuating'"
                      :cx="p.x" :cy="p.y" r="7" :fill="personStatusColor(p)" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" opacity="0.85"/>
                    <!-- 疏散中人员：闪烁移动 -->
                    <circle v-else
                      :cx="p.x" :cy="p.y" r="8" :fill="personStatusColor(p)" opacity="0.9">
                      <animate attributeName="opacity" values="0.9;0.4;0.9" :dur="0.6 + (p.x%5)*0.1 + 's'" repeatCount="indefinite"/>
                      <animate attributeName="r" values="8;5;8" :dur="0.5 + (p.y%4)*0.12 + 's'" repeatCount="indefinite"/>
                    </circle>
                    <!-- 危险区人员：红色警告 -->
                    <circle v-if="p.status === 'warning'" :cx="p.x" :cy="p.y" r="11" fill="none" stroke="#FF3B30" stroke-width="2" opacity="0.7">
                      <animate attributeName="r" values="11;15;11" dur="1s" repeatCount="indefinite"/>
                      <animate attributeName="opacity" values="0.7;0.2;0.7" dur="1s" repeatCount="indefinite"/>
                    </circle>
                  </g>
                </g>

                <!-- 选中设备高亮外圈 -->
                <circle
                  v-if="selectedDevice && selectedDevice.floorId === expandedFloor.id"
                  :cx="selectedDevice.x" :cy="selectedDevice.y" r="16"
                  fill="none" stroke="rgba(76,201,240,0.3)" stroke-width="3" class="sel-ring"
                />
              </svg>
              <div class="canvas-hint">{{ canvasHint }}</div>
            </div>

            <!-- 右：本层态势信息卡（数据读自 store 同源，火灾行由 fireEvent 驱动） -->
            <aside class="floor-info-panel">
              <div class="fip-head">
                <span class="rail-title">本层态势</span>
                <span v-if="isFloorOnFire(expandedFloor.id)" class="fip-fire-chip">🔥 火警</span>
                <span v-else class="fip-ok-chip">正常</span>
              </div>

              <!-- 火灾处置面板（按六阶段 emergencyStage 分态：决策 / 执行 / 识别 / 救援 / 摘要） -->
              <div v-if="isFloorOnFire(expandedFloor.id)" class="fip-alert">
                <!-- 阶段3：疏散方案决策（A/B/C/D 四区分组方案，点选实时联动平面图路线） -->
                <template v-if="store.emergencyStage === 3 && store.fireEvent">
                  <div class="fip-alert-title plan-title">🧭 疏散方案决策</div>
                  <div class="fip-sub">A/B/C/D 四区共 {{ totalPlanCount }} 套合法疏散方案，点击方案实时联动平面图路线与疏散灯方向</div>
                  <div v-if="zonePlanGroups.length" class="fip-zone-list">
                    <div v-for="g in zonePlanGroups" :key="g.zone" class="fip-zone-group">
                      <div class="fip-zone-head" :class="{ 'is-fire': g.isFire }">
                        <span class="fip-zone-name">{{ g.zone }}</span>
                        <span v-if="g.isFire" class="fip-zone-fire">🔥 火源区</span>
                        <span class="fip-zone-exit">推荐出口 {{ g.recommendedExit }}</span>
                      </div>
                      <div v-if="g.plans.length" class="fip-plan-list">
                        <button
                          v-for="(p, pi) in g.plans" :key="p.id"
                          type="button"
                          class="fip-plan"
                          :class="{ active: p.id === store.activeRoutePlanId }"
                          @click="pickPlan(p)"
                        >
                          <div class="fip-plan-head">
                            <span class="plan-badge">{{ g.zone.slice(0, 1) }}{{ pi + 1 }}</span>
                            <span class="plan-name">{{ p.name }}</span>
                            <span v-if="p.id === g.recommendedId" class="plan-rec">推荐</span>
                            <span v-if="p.id === store.activeRoutePlanId" class="plan-sel">已选</span>
                          </div>
                          <div class="fip-plan-meta">
                            <span class="em-chip num-font">{{ p.distance }}m</span>
                            <span class="em-chip num-font">{{ p.estimatedTime }}s</span>
                            <span class="em-chip">出口 {{ p.exitLabel }}</span>
                            <span class="em-chip">风险 {{ p.riskLevel }}</span>
                          </div>
                        </button>
                      </div>
                      <div v-else class="fip-warn-text">该区域无可通行疏散路线</div>
                    </div>
                  </div>
                  <button v-else class="fip-warn-text">各区域暂无可通行疏散路线</button>
                  <button v-if="store.activeRoutePlanId" class="fip-clear-btn" @click="handleConfirmExec">确认执行疏散</button>
                </template>
                <!-- 阶段4：智能疏散进行中（实时进度） -->
                <template v-else-if="store.emergencyStage === 4 && store.fireEvent">
                  <div class="fip-alert-title run-title"><span class="blink-dot"></span> 应急疏散进行中</div>
                  <div class="fip-row"><span>执行方案</span><b class="ok-text">{{ activePlan ? activePlan.name : '—' }}</b></div>
                  <div class="fip-row"><span>危险区域</span><b class="danger-text num-font">{{ store.fireEvent.floor }}-{{ store.fireEvent.area }}</b></div>
                  <div class="evac-run-grid">
                    <div class="evac-cell"><span>待疏散</span><b class="num-font warn-text">{{ store.evacStats.remaining }}</b></div>
                    <div class="evac-cell"><span>已疏散</span><b class="num-font ok-text">{{ store.evacStats.evacuated }}</b></div>
                    <div class="evac-cell"><span>总数</span><b class="num-font">{{ store.evacStats.total }}</b></div>
                  </div>
                  <div class="evac-bar"><div class="evac-bar-fill" :style="{ width: store.evacStats.pct + '%' }"></div></div>
                  <div class="fip-row"><span>疏散进度</span><b class="num-font">{{ store.evacStats.pct }}%</b></div>
                </template>
                <!-- 阶段5：滞留人员识别（正常疏散基本完成后系统自动检查） -->
                <template v-else-if="store.emergencyStage === 5 && store.fireEvent">
                  <div class="fip-alert-title warn-title"><span class="blink-dot"></span> 发现滞留人员：{{ store.strandedPersons.length }} 人</div>
                  <div class="fip-row"><span>已疏散</span><b class="ok-text">{{ store.evacStats.evacuated }} 人</b></div>
                  <div class="fip-row"><span>疏散进度</span><b class="num-font">{{ store.evacStats.pct }}%</b></div>
                  <div class="fip-stranded-list" v-if="store.strandedPersons.length">
                    <div v-for="(sp, si) in store.strandedPersons" :key="sp.id" class="fip-stranded-item">
                      <span class="fs-badge">🧍</span>
                      <span class="fs-name">人员{{ String(si + 1).padStart(2, '0') }}</span>
                      <span class="fs-loc num-font">{{ sp.building }}/{{ sp.floor }}/{{ sp.zone }}</span>
                      <span class="fs-status">{{ sp.located ? '人员位置已确认' : '待确认' }}</span>
                    </div>
                  </div>
                  <div class="fip-wait-note" v-else>全部人员已安全撤离，无滞留</div>
                  <button v-if="store.strandedPersons.length" class="fip-clear-btn" @click="confirmStranded">确认人员位置</button>
                </template>
                <!-- 阶段6：协同消防救援（启动救援协同 → 救援进行中 → 救援完成） -->
                <template v-else-if="store.emergencyStage === 6 && store.fireEvent">
                  <div class="fip-alert-title rescue-title"><span class="blink-dot"></span> 协同消防救援</div>
                  <div class="fip-row"><span>救援任务</span><b class="ok-text num-font">{{ store.rescueTask ? store.rescueTask.id : '—' }}</b></div>
                  <div class="fip-row"><span>任务状态</span><b :class="store.rescueCompleted ? 'ok-text' : 'warning-text'">{{ store.rescueTask ? store.rescueTask.status : '—' }}</b></div>
                  <div class="fip-row"><span>救援对象</span><b class="danger-text num-font">{{ store.strandedPersons.length }} 人</b></div>
                  <div class="fip-row"><span>人员位置</span><b class="num-font">{{ strandedZoneText }}</b></div>
                  <div class="fip-stranded-list">
                    <div v-for="(sp, si) in store.strandedPersons" :key="sp.id" class="fip-stranded-item">
                      <span class="fs-badge">🧍</span>
                      <span class="fs-name">人员{{ String(si + 1).padStart(2, '0') }}</span>
                      <span class="fs-loc num-font">{{ sp.building }}/{{ sp.floor }}/{{ sp.zone }}</span>
                      <span class="fs-status" :class="sp.status === 'rescued' ? 'ok-text' : ''">{{ sp.status === 'rescued' ? '已救出' : (sp.located ? '位置已确认' : '待确认') }}</span>
                    </div>
                  </div>
                  <div class="fip-wait-note">✓ 已确认人员位置 · ✓ 已生成救援任务 · ✓ 已协调消防救援力量</div>
                  <button v-if="!store.rescueCompleted" class="fip-clear-btn" @click="dispatchRescue">启动消防救援协同</button>
                  <div v-else class="fip-rescue-done">✓ 救援完成：滞留人员已全部救出</div>
                </template>
                <!-- 阶段1/2/0：常规摘要（紧急处置中） -->
                <template v-else>
                  <div class="fip-alert-title">🔥 火灾处置中</div>
                  <div class="fip-row"><span>火源区域</span><b class="danger-text num-font">{{ store.fireEvent ? store.fireEvent.floor + '-' + store.fireEvent.area : '—' }}</b></div>
                  <div class="fip-row"><span>风险人员</span><b class="danger-text num-font">{{ expandedMotion.risk }} 人</b></div>
                  <div class="fip-row"><span>应急疏散灯</span><b class="num-font">{{ expandedSummary.evacEmergency }} 台</b></div>
                  <div class="fip-row"><span>应急照明强闪</span><b class="num-font">{{ expandedSummary.emEmergency }} 台</b></div>
                  <div class="fip-row"><span>疏散路线</span><b class="ok-text">已自动重新规划</b></div>
                  <div class="fip-wait-note" v-if="store.emergencyStage === 1">请确认火情并启动应急响应</div>
                </template>
              </div>

              <!-- 人员统计 -->
              <div class="fip-block">
                <div class="fip-main-stat">
                  <span class="fip-label">本层人员</span>
                  <span class="fip-big num-font">{{ getPersonCount(expandedFloor.id) }}<i>人</i></span>
                </div>
                <div class="fip-mini-rows">
                  <span class="fip-mini"><i class="fip-dot moving"></i>移动 {{ expandedMotion.moving }}</span>
                  <span class="fip-mini"><i class="fip-dot static"></i>静止 {{ expandedMotion.static }}</span>
                  <span v-if="expandedMotion.risk" class="fip-mini risk"><i class="fip-dot risk"></i>风险 {{ expandedMotion.risk }}</span>
                </div>
              </div>

              <!-- 设备统计 -->
              <div class="fip-block">
                <div class="fip-sec-title">设备 · 共 {{ expandedSummary.total }} 台</div>
                <div class="fip-grid">
                  <div class="fip-cell">
                    <span class="fc-val num-font">{{ expandedSummary.evac }}</span>
                    <span class="fc-lbl">疏散灯</span>
                    <span class="fc-sub num-font">{{ expandedSummary.evacEmergency }} 应急</span>
                  </div>
                  <div class="fip-cell">
                    <span class="fc-val num-font">{{ expandedSummary.emLights }}</span>
                    <span class="fc-lbl">应急灯</span>
                    <span class="fc-sub num-font">{{ expandedSummary.emEmergency }} 强闪</span>
                  </div>
                  <div class="fip-cell">
                    <span class="fc-val num-font">{{ expandedSummary.smoke }}</span>
                    <span class="fc-lbl">烟感</span>
                    <span class="fc-sub">—</span>
                  </div>
                  <div class="fip-cell">
                    <span class="fc-val num-font">{{ expandedSummary.radar }}</span>
                    <span class="fc-lbl">雷达</span>
                    <span class="fc-sub">—</span>
                  </div>
                </div>
                <div class="fip-warn-row" v-if="expandedSummary.warning > 0 || expandedSummary.fault > 0">
                  <span v-if="expandedSummary.warning > 0" class="warn-chip">⚠ 告警 {{ expandedSummary.warning }}</span>
                  <span v-if="expandedSummary.fault > 0" class="fault-chip">✖ 故障 {{ expandedSummary.fault }}</span>
                  <span v-else-if="expandedSummary.warning === 0" class="ok-chip">设备状态正常</span>
                </div>
              </div>
            </aside>
          </div>
        </div>

      </div><!-- /main-zone -->
      </div><!-- /dash-view -->
      </transition>

      <!-- ══════════════════════════════════════
           右侧信息栏：楼宇态势 / 人员态势 / 应急状态+实时事件（三卡制）
           ══════════════════════════════════════ -->
      <div v-if="currentBuilding || viewMode === 'buildings'" class="right-rail">
        <!-- 卡 1：楼宇实时状态 -->
        <div class="rail-card">
          <div class="rail-head">
            <span class="rail-title">楼宇态势</span>
            <span class="rail-live"><span class="live-dot"></span>实时</span>
          </div>
          <div class="bldg-rows">
            <div v-for="b in store.buildings" :key="b.id" class="bldg-row" :class="{ cur: b.name === currentBuilding.name }">
              <span class="bldg-dot" :class="b.status"></span>
              <span class="bldg-name">{{ b.name }}</span>
              <span v-if="store.fireEvent && store.fireEvent.building === b.name" class="bldg-fire">🔥 火警</span>
              <span class="bldg-num num-font">{{ b.deviceCount }}</span>
            </div>
          </div>
        </div>

        <!-- 卡 2：人员分布 -->
        <div class="rail-card">
          <div class="rail-head">
            <span class="rail-title">人员态势</span>
            <span class="rail-sub num-font">{{ personTotal }} 人</span>
          </div>
          <div class="pp-rows">
            <div v-for="b in store.buildings" :key="'p' + b.id" class="pp-row" :class="{ cur: b.name === currentBuilding.name }">
              <span class="pp-name">{{ b.name }}</span>
              <div class="pp-track"><div class="pp-fill" :style="{ width: personPct(b.name) }"></div></div>
              <span class="pp-num num-font">{{ personOf(b.name) }}</span>
            </div>
          </div>
          <div class="pp-foot">
            <span class="pp-leg"><i class="pp-ic moving"></i>移动 {{ personMoving }}</span>
            <span class="pp-leg"><i class="pp-ic static"></i>静止 {{ personStatic }}</span>
            <span v-if="personRisk > 0" class="risk-chip">⚠ 风险区 {{ personRisk }}</span>
          </div>
        </div>

        <!-- 卡 3：应急状态 + 实时事件（统一读 fireStore 通知，无本地模拟） -->
        <div class="rail-card rail-events">
          <div class="rail-head">
            <span class="rail-title">应急状态</span>
            <span class="em-badge" :class="store.emergencyMode ? 'on' : 'off'">{{ store.emergencyMode ? '应急中' : '正常' }}</span>
          </div>
          <div class="em-fire-row">
            <template v-if="store.fireEvent">
              <span class="em-fire-dot"></span>
              <span class="em-fire-text">{{ store.fireEvent.building }} {{ store.fireEvent.floor }} {{ store.fireEvent.area }} 火情处置中</span>
            </template>
            <template v-else>
              <span class="em-ok-dot"></span>
              <span class="em-ok-text">无火警 · 园区运行正常</span>
            </template>
          </div>
          <div class="em-btns">
            <button class="em-btn danger" :disabled="store.emergencyMode" @click="store.setEmergencyMode(true)">启动应急联动</button>
            <button class="em-btn fire" @click="handleSimulateFire">模拟火灾</button>
            <button class="em-btn clear" :disabled="!store.fireEvent && !store.emergencyMode" @click="doClearFire">解除火情</button>
          </div>
          <div class="evt-divider"></div>
          <div class="evt-head">
            <span class="rail-title">实时事件</span>
            <span class="rail-sub num-font">{{ recentNotifications.length }} 条</span>
          </div>
          <div class="evt-scroll">
            <div v-if="recentNotifications.length === 0" class="evt-empty">暂无事件</div>
            <div v-for="n in recentNotifications" :key="n.id" class="evt-row">
              <span class="evt-dot" :class="n.level || 'info'"></span>
              <div class="evt-body">
                <div class="evt-title">{{ n.title }}</div>
                <div class="evt-msg">{{ n.message }}</div>
              </div>
              <span class="evt-time num-font">{{ fmtTime(n.createdAt) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div><!-- /dash-main -->

    <!-- ══════════════════════════════════════
         3D 数字孪生查看器（按需挂载：默认不存在于 DOM；点击「3D 模型」按钮才创建 WebGL 场景）
         拖拽旋转 / 滚轮缩放 / 点击楼层与区域可联动定位；关闭即销毁，避免常驻占用
         ══════════════════════════════════════ -->
    <transition name="view-fade">
      <div v-if="show3DViewer" class="dtwin-modal" @click.self="close3DViewer">
        <div class="dtwin-modal-panel">
          <div class="dtwin-modal-head">
            <span class="dtwin-modal-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M12 2l9 5v10l-9 5-9-5V7z"/>
                <path d="M3 7l9 5 9-5M12 12v10"/>
              </svg>
              数字孪生 · 3D 楼栋模型
            </span>
            <span class="dtwin-modal-sub">
              {{ currentBuilding ? currentBuilding.name : '楼栋总览' }} ·
              {{ expandedFloor ? expandedFloor.id + ' 平面图' : '6 层平面图' }}
            </span>
            <span class="dtwin-modal-tip">拖拽旋转 · 滚轮缩放 · 点击楼层/区域定位</span>
            <button class="dtwin-modal-close" @click="close3DViewer">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              关闭
            </button>
          </div>
          <div class="dtwin-modal-body">
            <BuildingDigitalTwin ref="dtwinRef" />
          </div>
        </div>
      </div>
    </transition>

    <!-- ══════════════════════════════════════
         设备悬浮 Tooltip
         ══════════════════════════════════════ -->
    <div v-if="hoveredDevice" class="device-tooltip" :style="{ left: tooltipX + 'px', top: tooltipY + 'px' }">
      <div class="tt-name">{{ devName(hoveredDevice) }}</div>
      <div class="tt-row"><span class="tt-label">编号</span><span class="num-font">{{ hoveredDevice.id }}</span></div>
      <div class="tt-row"><span class="tt-label">状态</span><span :class="['tt-status', getDeviceStatus(hoveredDevice)]"><span class="tt-dot"></span>{{ statusLabel(getDeviceStatus(hoveredDevice)) }}</span></div>
      <div class="tt-row"><span class="tt-label">类型</span><span>{{ typeLabel(hoveredDevice.type) }}</span></div>
      <div class="tt-row"><span class="tt-label">区域</span><span>{{ hoveredDevice.area }}</span></div>
      <div v-if="hoveredDevice.type === 'evacuation_light'" class="tt-row"><span class="tt-label">方向</span><span class="num-font">{{ directionLabel(getDeviceDirection(hoveredDevice)) }}</span></div>
      <div class="tt-row"><span class="tt-label">区域人数</span><span class="num-font">{{ getPersonCountInArea(hoveredDevice) }} 人</span></div>
    </div>

    <!-- ══════════════════════════════════════
         设备详情面板（右侧 Drawer）
         ══════════════════════════════════════ -->
    <transition name="slide-in">
      <div v-if="selectedDeviceView" class="device-panel">
        <div class="panel-header">
          <span class="panel-title">设备详情</span>
          <button class="close-btn" @click="selectedDevice = null">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="device-identity">
          <div class="device-icon" :class="selectedDeviceView.status">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="5"/>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
          </div>
          <div>
            <div class="device-name">{{ selectedDeviceView.name }}</div>
            <div class="device-id num-font">{{ selectedDeviceView.id }}</div>
          </div>
        </div>

        <div class="status-row">
          <span class="status-badge" :class="selectedDeviceView.status">
            <span class="status-dot"></span>
            {{ statusLabel(selectedDeviceView.status) }}
          </span>
          <span class="mode-badge">{{ modeLabel(selectedDeviceView.currentMode) }}</span>
        </div>

        <div class="info-grid">
          <div class="info-item"><span class="i-label">楼栋</span><span class="i-value">{{ selectedDeviceView.buildingId }}</span></div>
          <div class="info-item"><span class="i-label">楼层</span><span class="i-value">{{ selectedDeviceView.floorId }}</span></div>
          <div class="info-item"><span class="i-label">区域</span><span class="i-value">{{ selectedDeviceView.area }}</span></div>
          <div v-if="selectedDeviceView.type === 'evacuation_light'" class="info-item"><span class="i-label">方向</span><span class="i-value blue num-font">{{ directionLabel(selectedDeviceView.direction) }}</span></div>
          <div class="info-item"><span class="i-label">电量</span><span class="i-value num-font">{{ selectedDeviceView.battery }}%</span></div>
          <div class="info-item"><span class="i-label">通信</span><span class="i-value" :class="selectedDeviceView.communication === 'online' ? 'green' : 'red'">{{ selectedDeviceView.communication === 'online' ? '在线' : '离线' }}</span></div>
          <div class="info-item full"><span class="i-label">所在区域人数</span><span class="i-value num-font">{{ selectedDeviceView.areaPersons }} 人</span></div>
        </div>

        <!-- 控制按钮：调整方向 ←/→（仅疏散指示灯）、应急高亮（灯类）、查看感知 -->
        <div class="ctrl-section" v-if="selectedDeviceView.type !== 'exit_sign'">
          <template v-if="selectedDeviceView.type === 'evacuation_light'">
            <div class="ctrl-label">调整方向</div>
            <div class="dir-pad">
              <button class="dir-btn" :class="{ active: selectedDeviceView.direction === 'left' }" @click="switchDir('left')">
                <span class="dir-arrow">←</span>
                <span class="dir-label">向左</span>
              </button>
              <button class="dir-btn" :class="{ active: selectedDeviceView.direction === 'right' }" @click="switchDir('right')">
                <span class="dir-arrow">→</span>
                <span class="dir-label">向右</span>
              </button>
            </div>
          </template>
          <div class="action-btns">
            <button v-if="selectedDeviceView.type === 'evacuation_light' || selectedDeviceView.type === 'emergency_light'" class="act-btn emergency" @click="emergencyHighlight(selectedDevice)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              应急高亮
            </button>
            <button class="act-btn perception" @click="showPerception(selectedDevice)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
              查看感知
            </button>
          </div>
        </div>
      </div>
    </transition>

    <!-- ══════════════════════════════════════
         人员感知详情（毫米波雷达）
         ══════════════════════════════════════ -->
    <transition name="slide-in">
      <div v-if="selectedPerson" class="person-detail-panel">
        <div class="panel-header">
          <span class="panel-title">毫米波雷达感知</span>
          <button class="close-btn" @click="selectedPerson = null">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="radar-title">{{ selectedPerson.floor }} · {{ selectedPerson.zone || selectedPerson.area }}</div>

        <div class="radar-count">
          <span class="rc-num num-font">{{ radarPersonList.length }}</span>
          <span class="rc-label">个目标</span>
        </div>

        <div class="radar-list">
          <div v-for="(p, idx) in radarPersonList" :key="p.id" class="radar-item">
            <div class="ri-head">
              <span class="ri-id">目标{{ String(idx + 1).padStart(2, '0') }}</span>
              <span class="ri-status" :class="p.status === 'warning' ? 'warn' : 'normal'">{{ p.status === 'warning' ? '风险' : '正常' }}</span>
            </div>
            <div class="ri-rows">
              <div class="ri-row"><span class="ri-label">距离</span><span class="num-font">{{ (p.distance || (1 + idx * 1.3)).toFixed(1) }}m</span></div>
              <div class="ri-row"><span class="ri-label">方位</span><span>{{ p.direction || '东侧' }}</span></div>
              <div class="ri-row"><span class="ri-label">速度</span><span class="num-font">{{ (p.speed || 0.5).toFixed(1) }}m/s</span></div>
              <div class="ri-row"><span class="ri-label">编号</span><span class="num-font">{{ p.id }}</span></div>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- ══════════════════════════════════════
         应急联动面板
         ══════════════════════════════════════ -->
    <transition name="fade">
      <div v-if="showEmergencyPanel" class="emergency-overlay" @click.self="showEmergencyPanel = false">
        <div class="emergency-panel fire-card">
          <div class="panel-header">
            <span class="panel-title">应急联动控制</span>
            <button class="close-btn" @click="showEmergencyPanel = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>

          <div class="em-section">
            <div class="em-section-title">选择楼层</div>
            <div class="em-check-row">
              <label v-for="f in currentFloorData" :key="f.id" class="em-check-item">
                <input type="checkbox" :value="f.id" v-model="emFloors"/>
                <span>{{ f.id }}</span>
              </label>
            </div>
          </div>

          <div class="em-section">
            <div class="em-section-title">控制类型</div>
            <div class="em-actions">
              <button class="em-action-btn emergency" @click="doEmergencyHighlight">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                应急高亮
              </button>
              <button class="em-action-btn dir-left" @click="doBatchDir('left')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                全部向左
              </button>
              <button class="em-action-btn dir-right" @click="doBatchDir('right')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                全部向右
              </button>
            </div>
          </div>

          <div class="em-preview" v-if="emFloors.length > 0">
            将控制 <strong>{{ emFloors.join(' / ') }}</strong> 共 <strong>{{ emPreviewCount }}</strong> 台设备
          </div>
        </div>
      </div>
    </transition>

    <!-- ══════════════════════════════════════
         关键业务确认弹窗（全流程仅 3 个，禁止 ElMessage/Notification/Toast）
         ① 发现火灾（模拟火灾触发） ② 是否启动应急预案（查看火情后自动弹出） ③ 启动应急协同救援（确认人员位置后）
         ══════════════════════════════════════ -->
    <!-- ① 发现火灾 -->
    <transition name="biz-fade">
      <div v-if="store.fireAlertVisible && store.fireEvent" class="biz-dialog-mask">
        <div class="biz-dialog danger">
          <div class="biz-dialog-icon fire">🔥</div>
          <div class="biz-dialog-title">发现火灾</div>
          <div class="biz-dialog-sub num-font">{{ store.fireEvent.building }} · {{ store.fireEvent.floor }} · {{ store.fireEvent.area }}</div>
          <div class="biz-dialog-body">
            <div class="biz-row"><span>事件位置</span><b class="danger-text num-font">{{ store.fireEvent.building }} {{ store.fireEvent.floor }} {{ store.fireEvent.area }}</b></div>
            <div class="biz-row"><span>事件类型</span><b>建筑火灾模拟事件</b></div>
            <div class="biz-row"><span>涉及人员</span><b class="danger-text num-font">{{ fireAlertZonePeople }} 人</b></div>
            <div class="biz-row"><span>发现时间</span><b class="num-font">{{ store.fireEvent.time }}</b></div>
            <div class="biz-row"><span>当前状态</span><b class="warning-text">已发现，等待查看火情</b></div>
          </div>
          <div class="biz-dialog-actions">
            <button class="biz-btn danger" @click="handleViewFire">查看火情</button>
          </div>
        </div>
      </div>
    </transition>

    <!-- ② 是否启动应急预案 -->
    <transition name="biz-fade">
      <div v-if="showResponseDialog" class="biz-dialog-mask">
        <div class="biz-dialog warning">
          <div class="biz-dialog-icon warn">🚨</div>
          <div class="biz-dialog-title">是否启动应急预案</div>
          <div class="biz-dialog-sub num-font">{{ store.fireEvent ? store.fireEvent.building + ' · ' + store.fireEvent.floor + ' · ' + store.fireEvent.area : '' }}</div>
          <div class="biz-dialog-body">
            <div class="biz-row"><span>建议措施</span><b>启动应急响应，联动应急照明并自动生成疏散路线</b></div>
            <div class="biz-row"><span>危险区域</span><b class="danger-text num-font">{{ store.fireEvent ? store.fireEvent.floor + '-' + store.fireEvent.area : '—' }}</b></div>
            <div class="biz-row"><span>涉及人员</span><b class="danger-text num-font">{{ fireAlertZonePeople }} 人</b></div>
          </div>
          <div class="biz-dialog-actions">
            <button class="biz-btn ghost" @click="showResponseDialog = false">暂不启动</button>
            <button class="biz-btn primary" @click="handleStartEmergencyResponse">启动应急预案</button>
          </div>
        </div>
      </div>
    </transition>

    <!-- ③ 启动应急协同救援 -->
    <transition name="biz-fade">
      <div v-if="showRescueDialog" class="biz-dialog-mask">
        <div class="biz-dialog rescue">
          <div class="biz-dialog-icon resc">🚒</div>
          <div class="biz-dialog-title">启动应急协同救援</div>
          <div class="biz-dialog-sub num-font">滞留人员 {{ store.strandedPersons.length }} 人 · {{ strandedZoneText }}</div>
          <div class="biz-dialog-body">
            <div class="biz-row"><span>救援对象</span><b class="danger-text num-font">{{ store.strandedPersons.length }} 名滞留人员</b></div>
            <div class="biz-row"><span>协同单位</span><b>消防救援力量（模拟联动）</b></div>
            <div class="biz-row"><span>执行动作</span><b>确认人员位置 → 生成救援任务 → 派出救援力量</b></div>
          </div>
          <div class="biz-dialog-actions">
            <button class="biz-btn ghost" @click="showRescueDialog = false">返回检查</button>
            <button class="biz-btn danger" @click="handleStartRescue">启动应急协同救援</button>
          </div>
        </div>
      </div>
    </transition>

  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useFireStore } from '../stores/fireStore'
import BuildingDigitalTwin from '../components/BuildingDigitalTwin.vue'
import {
  SVG_W, SVG_H, WALLS, ROOMS, CORRIDOR, STAIRS, EXITS, DOORS,
  FLOOR_CONFIG, getFloorTopology, activeStairsForFloor,
} from '../mock/floorPlanData'

const store = useFireStore()
const router = useRouter()
const route = useRoute()

// ============ 楼栋选择 ============
const selectedBuildingId = ref('B003') // 默认 3号楼
const selectedDevice = ref(null)
const selectedPerson = ref(null)
const showEmergencyPanel = ref(false)
const emFloors = ref([])

// 侧边导航「应急联动」入口：/dashboard?panel=emergency → 自动打开应急联动面板
watch(
  () => route.query.panel,
  (v) => {
    if (v === 'emergency') showEmergencyPanel.value = true
  },
  { immediate: true }
)

// ============ 视图模式：buildings 楼栋总览 / floors 楼层网格 / floorplan 平面图展开 ============
const viewMode = ref('buildings')

// ============ 悬浮 Tooltip ============
const hoveredDevice = ref(null)
const tooltipX = ref(0)
const tooltipY = ref(0)

// ============ 放大查看（首页内联展开：expandedFloor 非空时主区切换为该楼层大图，无弹窗/无路由跳转） ============
const expandedFloor = ref(null)
const zoomScale = ref(1)
const zoomPanX = ref(0)
const zoomPanY = ref(0)
const isPanning = ref(false)
let panStartX = 0, panStartY = 0

// ============ 3D 数字孪生查看器（楼层平面图页不直接显示 3D，改为点击上方「3D 模型」按钮按需浮层查看） ============
// 采用 v-if 按需挂载：未点击时不存在任何 canvas / WebGL 上下文 / GLB 请求；关闭时销毁释放
const show3DViewer = ref(false)
const dtwinRef = ref(null)

function open3DViewer() {
  show3DViewer.value = true
  // 浮层首次展示时容器由 0 尺寸变为真实尺寸，等 DOM 更新后让 Three.js 重新适配一次
  nextTick(() => {
    requestAnimationFrame(() => {
      if (dtwinRef.value && typeof dtwinRef.value.resize === 'function') dtwinRef.value.resize()
    })
  })
}
function close3DViewer() {
  show3DViewer.value = false
}
function onEscClose3D(e) {
  if (e.key === 'Escape' && show3DViewer.value) close3DViewer()
}

// ============ 计算属性 ============
const currentBuilding = computed(() =>
  store.buildings.find(b => b && b.id === selectedBuildingId.value)
)

// 火情发现弹层：detectFireScenario 置 fireAlertVisible；外部页面触发（triggerFireScenario）回首页时同步为方案决策
const lastHandledFireId = ref(null)
watch(
  () => (store.fireEvent ? store.fireEvent.id : null),
  (nid) => {
    if (!nid || lastHandledFireId.value === nid) return
    if (store.emergencyStage === 0 || store.emergencyStage === 5) {
      // 外部直接触发（联动物已由 triggerFireScenario 完成）→ 同步到疏散方案决策阶段
      store.syncStageAfterExternalFire()
    }
  },
  { immediate: true }
)
// 阶段推进联动：2 → 自动切火警楼并内联展开火警楼层；4/5 → 确保展开方案楼层
watch(
  () => store.emergencyStage,
  (s) => {
    // 火情进入处置阶段（emergencyStage > 0）：自动从楼栋总览跳转到对应楼栋楼层视图
    if (s > 0 && store.fireEvent) {
      const fb = store.buildings.find((b) => b && b.name === store.fireEvent.building)
      if (fb) selectedBuildingId.value = fb.id
      if (viewMode.value === 'buildings') viewMode.value = 'floors'
    }
    if (s === 2) {
      const fe = store.fireEvent
      if (!fe || !currentBuilding.value) return
      if (currentBuilding.value.name !== fe.building) {
        const fb = store.buildings.find((b) => b && b.name === fe.building)
        if (fb) selectedBuildingId.value = fb.id
      }
      zoomToFloorId(fe.floor)
    } else if (s === 4 || s === 5) {
      if (store.fireEvent && store.fireEvent.building === (currentBuilding.value ? currentBuilding.value.name : '')) {
        zoomToFloorId(store.fireEvent.floor)
      }
    }
  }
)
function pickPlan(p) {
  if (!p) return
  // 直接使用 activeRoutePlanId 确保预览方案切换即时生效
  store.activeRoutePlanId = p.id
  store.applyRouteToDevices(p)
}
function handleConfirmExec() {
  // ③ 确认疏散路径 → ④ 智能疏散：confirmEvacuationPlan 内部启动人员移动与应急灯强闪，保持在首页面板
  store.confirmEvacuationPlan()
}
// ①→② 启动应急响应：由「是否启动应急预案」业务弹窗的「启动应急预案」按钮触发（handleStartEmergencyResponse）

// ============ 三个关键业务确认弹窗（发现火灾 / 是否启动应急预案 / 启动应急协同救援） ============
const showResponseDialog = ref(false)   // ② 是否启动应急预案
const showRescueDialog = ref(false)     // ③ 启动应急协同救援
let responseDialogTimer = null

// ① 查看火情：关闭「发现火灾」弹窗 → 高亮火源楼层平面图 → 自动弹出「是否启动应急预案」
function handleViewFire() {
  const fe = store.fireEvent
  if (!fe) return
  store.fireAlertVisible = false
  store.fireConfirmed = true
  // 自动切换至火警楼栋并内联展开火警楼层（平面图火灾危险区高亮）
  const fb = store.buildings.find((b) => b && b.name === fe.building)
  if (fb) selectedBuildingId.value = fb.id
  if (viewMode.value === 'buildings') viewMode.value = 'floors'
  zoomToFloorId(fe.floor)
  if (responseDialogTimer) clearTimeout(responseDialogTimer)
  responseDialogTimer = setTimeout(() => { showResponseDialog.value = true }, 800)
}

// ② 启动应急预案：进入应急响应并自动生成疏散方案（阶段 2 → 3 疏散路径）
function handleStartEmergencyResponse() {
  showResponseDialog.value = false
  store.activateEmergencyResponse()
}
// 阶段4 的「调整指示方向 / 脉冲强闪 / 人员疏散动画」已在 confirmEvacuationPlan 内自动执行（fireStore.startPulseFlash）
// 阶段6：确认滞留人员位置 → 弹出「启动应急协同救援」确认弹窗（第 3 个业务弹窗）
function confirmStranded() {
  if (!store.strandedPersons.length) return
  showRescueDialog.value = true
}
// 弹窗确认：确认人员位置（生成救援任务、进入协同救援阶段）并派出救援力量（模拟 5s 后救援完成）
function handleStartRescue() {
  showRescueDialog.value = false
  const ok = store.confirmStrandedLocation()
  if (ok) store.dispatchRescueTeam()
}
// 阶段6：启动消防救援协同（模拟救援完成后滞留人员 rescued）
function dispatchRescue() {
  store.dispatchRescueTeam()
}
// 滞留人员所在区域汇总（如 "5F A区 + C区"）
const strandedZoneText = computed(() => {
  const zones = store.strandedPersons.map((p) => `${p.floor} ${p.zone}`)
  return zones.length ? zones.join(' + ') : '—'
})
// 顶层流程文案（供 stepper / 徽标使用）— 六阶段模型
const emgStages = ['正常', '发现火灾', '启动应急响应', '疏散路径', '智能疏散', '滞留人员识别', '协同救援']
const emgSteps = [
  { n: 1, key: 'discover', label: '发现火灾', icon: '🔥' },
  { n: 2, key: 'response', label: '启动应急响应', icon: '🚨' },
  { n: 3, key: 'plan', label: '疏散路径', icon: '🗺' },
  { n: 4, key: 'evacuate', label: '智能疏散', icon: '🏃' },
  { n: 5, key: 'stranded', label: '滞留人员识别', icon: '🧍' },
  { n: 6, key: 'rescue', label: '协同救援', icon: '🚒' },
]
// 页面内火情指挥区已删除：火情信息由顶部流程、平面图、右侧信息栏、业务弹窗表达

// 火警楼层房间矩形（按 fireEvent.area 匹配房间 name，动态危险区）
const fireRoomDef = computed(() => {
  const fe = store.fireEvent
  if (!fe || !expandedFloor.value || !currentBuilding.value) return null
  if (fe.building !== currentBuilding.value.name || fe.floor !== expandedFloor.value.id) return null
  const room = roomDefsForFloor(fe.floor).find((r) => r && r.name === fe.area)
  return room || null
})
// 火源区域人员数（riskZone 口径，同 fireStore 联动判定）
const fireAlertZonePeople = computed(() => {
  const fe = store.fireEvent
  if (!fe || !currentBuilding.value || fe.building !== currentBuilding.value.name) return 0
  return store.persons.filter((p) => p && p.floor === fe.floor && (p.zone || p.area) === fe.area).length
})
// 火源区域可用疏散方案（routeMatrix 同源，绝不为凑数造假）
const fireZoneInfo = computed(() => {
  const fe = store.fireEvent
  if (!fe || !store.routeMatrix || !store.routeMatrix.perZone) return null
  return store.routeMatrix.perZone[fe.area] || null
})
// A/B/C/D 四区方案分组（阶段3 右侧决策面板）：每个区域一组，含推荐位与当前选中态
const zonePlanGroups = computed(() => {
  const m = store.routeMatrix
  if (!m || !m.areas || !m.perZone) return []
  const fe = store.fireEvent
  return m.areas.map((zone) => {
    const info = m.perZone[zone] || { plans: [], recommendedId: null }
    const plans = (Array.isArray(info.plans) ? info.plans : []).filter((p) => p && p.status !== 'BLOCKED')
    const rec = plans.find((p) => p.id === info.recommendedId) || null
    return {
      zone,
      isFire: !!(fe && fe.area === zone),
      plans,
      recommendedId: info.recommendedId,
      recommendedExit: rec ? rec.exitLabel : '—',
    }
  })
})
const totalPlanCount = computed(() => zonePlanGroups.value.reduce((s, g) => s + g.plans.length, 0))
// 当前执行/预览方案 + 本层路径段（路线渲染与疏散灯联动共用同一数据源）
const activePlan = computed(() => {
  const id = store.activeRoutePlanId
  if (!id) return null
  return store.getRoutePlanById(id)
})
const activeRouteSegment = computed(() => {
  const p = activePlan.value
  if (!p || !Array.isArray(p.path) || !expandedFloor.value) return []
  return p.path.filter((n) => n && n.floorId === expandedFloor.value.id)
})
// 展开画布底部提示随阶段变化
const canvasHint = computed(() => {
  if (store.emergencyStage === 5 && store.fireEvent) return '人员疏散完成 · 系统识别滞留人员，请确认位置并启动协同救援'
  if (store.emergencyStage === 4) return '智能疏散进行中 · 疏散灯脉冲强闪，人员沿路线动态撤离'
  if (store.emergencyStage === 3) return '点击右侧方案卡片查看完整路线与疏散灯方向'
  if (store.emergencyStage === 2) return '应急联动已启动 · 系统正在计算疏散方案'
  if (store.emergencyStage === 1) return '已发现火灾 · 请启动应急响应'
  return '滚轮缩放 · 按住拖拽平移 · 点击设备 / 人员查看详情'
})

// 固定生成 1F~6F（6 层）
const currentFloorData = computed(() => {
  const arr = []
  for (let i = 1; i <= 6; i++) arr.push({ id: `${i}F`, num: i })
  return arr
})

// ============ 设备（与 Pinia store 同源） ============
// store.devices 由 buildSeedDevices() 生成：4 栋 × 6F，全部按 floorPlanData 平面坐标布点
function getDevicesForFloor(floorId) {
  const b = currentBuilding.value
  if (!b) return []
  return store.devices.filter(d =>
    d && d.buildingId === b.id && d.floorId === floorId && typeof d.x === 'number'
  )
}
function getDeviceCount(floorId) {
  return getDevicesForFloor(floorId).length
}

// ============ 房间定义（label 取自 FLOOR_CONFIG） ============
function roomDefsForFloor(floorId) {
  const cfg = FLOOR_CONFIG[floorId] || {}
  const labelMap = {}
  ;(cfg.rooms || []).forEach(r => { labelMap[r.id] = r })
  return ROOMS.map(r => {
    const c = labelMap[r.id]
    return { ...r, name: c ? c.name : r.name, label: c ? c.label : r.label }
  })
}
function floorNote(floorId) {
  const cfg = FLOOR_CONFIG[floorId]
  return cfg ? cfg.note : ''
}

// ============ 人员感知 ============
function buildingPersonCount(bname) {
  if (!bname) return 0
  return (store.persons || []).filter(p => p && p.building === bname).length
}
const riskCount = computed(() =>
  (store.riskAreas || []).filter(r => r && r.building === currentBuilding.value?.name).length
)
const focusFloor = computed(() => {
  if (store.fireEvent && store.fireEvent.building === currentBuilding.value?.name) return store.fireEvent.floor
  const counts = {}
  ;(store.persons || []).forEach(p => {
    if (p && p.building === currentBuilding.value?.name) counts[p.floor] = (counts[p.floor] || 0) + 1
  })
  let max = 0, f = '-'
  Object.entries(counts).forEach(([k, v]) => { if (v > max) { max = v; f = k } })
  return f
})
const focusArea = computed(() => {
  if (store.fireEvent && store.fireEvent.building === currentBuilding.value?.name) return store.fireEvent.area
  return 'A区'
})

const radarPersonList = computed(() => {
  if (!selectedPerson.value) return []
  const p = selectedPerson.value
  const zone = p.zone || p.area
  return (store.persons || []).filter(x =>
    x && x.building === currentBuilding.value?.name &&
    x.floor === p.floor &&
    (x.zone || x.area) === zone
  )
})

function getPersonsForFloor(floorId, limit = 10) {
  const fe = store.fireEvent
  const list = store.persons.filter((p) => p && !p._hide && p.floor === floorId && p.building === (currentBuilding.value ? currentBuilding.value.name : p.building))
  const fireZone = fe && currentBuilding.value && fe.building === currentBuilding.value.name ? fe.floor : null
  if (fireZone === floorId) return list.slice(0, 14)
  return list.slice(0, limit)
}
function getPersonCount(floorId) {
  return store.persons.filter((p) => p && !p._hide && p.floor === floorId && p.building === (currentBuilding.value ? currentBuilding.value.name : p.building)).length
}
function getPersonCountInArea(dev) {
  if (!dev) return 0
  return store.persons.filter((p) => p && !p._hide && p.building === dev.building && p.floor === dev.floorId && (p.zone || p.area) === dev.area).length
}
function getPersonStatus(p) {
  return p.status === 'warning' ? 'person-warning' : 'person-normal'
}

// ============ 设备状态/方向/颜色 ============
function isFloorOnFire(floorId) {
  const b = currentBuilding.value
  return !!(store.fireEvent && b && store.fireEvent.building === b.name && store.fireEvent.floor === floorId)
}

// 总览卡片火警房间：动态匹配 fireEvent.area（不写死区域，配合 isFloorOnFire 使用）
function floorFireRoom(floorId) {
  const b = currentBuilding.value
  const fe = store.fireEvent
  if (!fe || !b || fe.building !== b.name || fe.floor !== floorId) return null
  return roomDefsForFloor(floorId).find((r) => r && r.name === fe.area) || null
}

// 楼层运行状态文案（与 floorStatusClass 同一统计口径）
function floorStatusText(floorId) {
  const devs = getDevicesForFloor(floorId)
  if (devs.length === 0) return '—'
  const emerg = devs.filter((d) => d && getDeviceStatus(d) === 'emergency').length
  const warn = devs.filter((d) => d && (getDeviceStatus(d) === 'warning' || getDeviceStatus(d) === 'fault')).length
  if (emerg > 0) return '应急疏散中'
  if (warn > 0) return warn + ' 处告警'
  return '运行正常'
}

function getDeviceStatus(dev) {
  // 视觉状态与 store 完全一致：triggerFireScenario / setEmergencyMode / simulateAlarm
  // 已直接改写设备 status，本地不再维护覆盖层
  return dev.status || 'normal'
}
function getDeviceDirection(dev) {
  return dev.direction || 'right'
}

function statusColor(s) {
  return { normal: '#4361EE', warning: '#F59E0B', emergency: '#EF4444', fault: '#94A3B8' }[s] || '#4361EE'
}
// 形状填充（硬性视觉规范：疏散指示灯箭头/边框恒为绿色，应急照明灯为暖白光，安全出口恒为绿色）
function shapeFill(dev) {
  if (dev.type === 'exit_sign') return '#22C55E'
  // 疏散指示灯：深色指示牌底（箭头绿色由模板指定，不随状态变红）
  if (dev.type === 'evacuation_light') return '#0B1F14'
  // 应急照明灯：暖白照明色（应急时仍为白光强闪）
  if (dev.type === 'emergency_light') {
    const s = getDeviceStatus(dev)
    if (s === 'fault') return '#94A3B8'
    return '#F8F3E4'
  }
  return statusColor(getDeviceStatus(dev))
}
// 指示牌描边：正常绿色，故障灰，其余状态仍保持绿色（应急=更亮的绿色发光）
function boardStroke(dev) {
  if (getDeviceStatus(dev) === 'fault') return '#94A3B8'
  return 'rgba(57,255,136,0.75)'
}
// 光晕颜色：指示灯/出口=绿色，应急照明=暖白，其余按状态
function haloFill(dev) {
  if (dev.type === 'exit_sign') return '#22C55E'
  if (dev.type === 'evacuation_light') return '#39FF88'
  if (dev.type === 'emergency_light') return '#F8F3E4'
  return statusColor(getDeviceStatus(dev))
}
function dirArrow(dev) {
  return getDeviceDirection(dev) === 'left' ? '←' : '→'
}
function haloR(dev) {
  const s = getDeviceStatus(dev)
  return { emergency: 14, warning: 12, normal: 10, fault: 9 }[s] || 10
}

// 节点 class：选中设备强制 normal（不闪烁），仅 emergency 触发脉冲；t-* 类型类用于区分灯具动画语义
function nodeClass(dev) {
  const isSel = selectedDevice.value && selectedDevice.value.id === dev.id
  const status = isSel ? 'normal' : getDeviceStatus(dev)
  const isFlash = dev.emergencyFlash === true
  const flashDelay = isFlash ? `delay-${(dev.x % 5) + 1}` : ''
  return ['light-node', `t-${dev.type}`, status, isSel ? 'selected' : '', isFlash ? 'emergency-flash' : '', flashDelay].filter(Boolean)
}

// 人员疏散状态颜色（滞留=红色，获救=救援橙，撤离中=橙，安全=绿）
function personStatusColor(p) {
  if (p.status === 'stranded' || p.status === 'located') return '#FF4D4D'
  if (p.status === 'rescued') return '#F59E0B'
  if (p.status === 'warning' || p.status === 'evacuating') return '#FF6B35'
  if (p.status === 'safe') return '#00E676'
  return '#4CC9F0'
}

function floorStatusClass(floorId) {
  const devs = getDevicesForFloor(floorId)
  const emerg = devs.filter(d => d && getDeviceStatus(d) === 'emergency').length
  const warn = devs.filter(d => d && (getDeviceStatus(d) === 'warning' || getDeviceStatus(d) === 'fault')).length
  if (emerg > 0) return 'emergency-count'
  if (warn > 0) return 'warning-count'
  return 'normal-count'
}

// 设备类型中文
function typeLabel(t) {
  return {
    evacuation_light: '疏散指示灯', emergency_light: '应急照明灯',
    smoke_detector: '烟感探测器', radar_sensor: '毫米波雷达', exit_sign: '安全出口标识',
  }[t] || t
}
function devName(dev) {
  return `${typeLabel(dev.type)} ${dev.id}`
}

// ============ 路线渲染辅助 ============
// 推荐路线：store.getAllZoneRoutes()（规划楼层全区域）
const allZoneRoutes = computed(() => store.getAllZoneRoutes())
// 备用路线 + 推荐路线状态
const backupSegments = computed(() => {
  const m = store.routeMatrix
  const map = {}
  if (m) {
    m.areas.forEach(zone => {
      const info = m.perZone[zone] || {}
      const bak = store.routePlans.find(p => p.id === info.backupId)
      map[zone] = bak ? store.getRouteSegmentForFloor(bak, m.floorId) : []
    })
  }
  return map
})
const recStatusMap = computed(() => {
  const m = store.routeMatrix
  const map = {}
  if (m) {
    m.areas.forEach(zone => {
      const info = m.perZone[zone] || {}
      const rec = store.routePlans.find(p => p.id === info.recommendedId)
      map[zone] = rec ? rec.status : 'NORMAL'
    })
  }
  return map
})

// ============ 路网调试层 ============
const netTopo = computed(() => (store.routeDebug ? getFloorTopology() : null))
const netEdges = computed(() => {
  if (!netTopo.value) return []
  const map = {}
  netTopo.value.nodes.forEach(n => { map[n.id] = n })
  return netTopo.value.edges.map(e => ({ x1: map[e.from].x, y1: map[e.from].y, x2: map[e.to].x, y2: map[e.to].y }))
})
function netNodeColor(t) {
  return { room: '#4361EE', corridor: '#F59E0B', stair: '#4CC9F0', exit: '#22C55E' }[t] || '#64748B'
}
function netTypeShort(t) {
  return { room: '门', corridor: '廊', stair: '梯', exit: '出' }[t] || t
}

// ============ 选中设备视图（合并状态/方向/区域人数） ============
const selectedDeviceView = computed(() => {
  const d = selectedDevice.value
  if (!d) return null
  // d 即 store.devices 中的响应式元素：状态 / 方向改动会实时反映
  const status = getDeviceStatus(d)
  return {
    ...d,
    status,
    currentMode: status === 'emergency' ? 'emergency' : (d.currentMode || 'daily'),
    name: devName(d),
    areaPersons: getPersonCountInArea(d),
  }
})

// ============ 交互 ============
// 点击楼层卡片/楼层快速切换：主区直接展开该楼层（无弹窗、无路由跳转）
function zoomToFloorId(floorId) {
  const f = currentFloorData.value.find((x) => x && x.id === floorId)
  if (f) openFloorZoom(f)
}

function openFloorZoom(floor) {
  if (!floor) return
  expandedFloor.value = floor
  zoomScale.value = 1
  zoomPanX.value = 0
  zoomPanY.value = 0
  hoveredDevice.value = null
  viewMode.value = 'floorplan'
}
// 返回六层总览视图
function backToOverview() {
  expandedFloor.value = null
  zoomScale.value = 1
  zoomPanX.value = 0
  zoomPanY.value = 0
  selectedDevice.value = null
  selectedPerson.value = null
  hoveredDevice.value = null
  viewMode.value = 'floors'
}

function selectDevice(dev) {
  selectedDevice.value = dev
  selectedPerson.value = null
}
function selectPerson(p) {
  selectedPerson.value = p
  selectedDevice.value = null
}
function deselectDevice() {
  selectedDevice.value = null
}

function onDeviceHover(dev, e) {
  hoveredDevice.value = dev
  tooltipX.value = e.clientX + 14
  tooltipY.value = e.clientY + 14
}
function onDeviceMove(e) {
  tooltipX.value = e.clientX + 14
  tooltipY.value = e.clientY + 14
}
function onDeviceLeave() {
  hoveredDevice.value = null
}

function emergencyHighlight(device) {
  if (!device) return
  store.updateDeviceStatus && store.updateDeviceStatus(device.id, 'emergency')
  store.addNotification && store.addNotification({
    level: 'warning',
    title: '应急高亮已触发',
    message: `${devName(device)} 已进入应急高亮状态`,
  })
}

function showPerception(device) {
  if (!device) return
  const persons = (store.persons || []).filter(p =>
    p && p.building === currentBuilding.value?.name && p.floor === device.floorId && (p.zone || p.area) === device.area
  )
  if (persons.length > 0) {
    selectedPerson.value = persons[0]
  } else {
    store.addNotification && store.addNotification({
      level: 'info',
      title: '感知详情',
      message: `${currentBuilding.value?.name} ${device.floorId} ${device.area} 当前无感知目标`,
    })
  }
}

function switchDir(dir) {
  if (!selectedDevice.value) return
  store.switchEvacuationDirection(selectedDevice.value.id, dir, '管理员调整疏散方向')
}

function statusLabel(s) {
  return { normal: '正常', warning: '告警', emergency: '应急', fault: '故障' }[s] || s
}
function modeLabel(m) {
  return { daily: '正常照明', induction: '感应增强', emergency: '应急照明', offline: '离线' }[m] || m
}
function directionLabel(d) {
  return { left: '← 向左', right: '→ 向右' }[d] || d
}

function handleSimulateFire() {
  // 五阶段流程起点：仅产生「发现火情」产物，中央弹窗确认后进入联动
  store.detectFireScenario()
}

// ============ 放大视图：本层态势统计（数据均读自 store 同源） ============
function floorSummary(floorId) {
  const devs = getDevicesForFloor(floorId)
  const byType = (t) => devs.filter((d) => d && d.type === t)
  const isEmerg = (d) => d && d.status === 'emergency'
  return {
    total: devs.length,
    evac: byType('evacuation_light').length,
    emLights: byType('emergency_light').length,
    smoke: byType('smoke_detector').length,
    radar: byType('radar_sensor').length,
    exitSigns: byType('exit_sign').length,
    evacEmergency: byType('evacuation_light').filter(isEmerg).length,
    emEmergency: byType('emergency_light').filter(isEmerg).length,
    warning: devs.filter((d) => d && d.status === 'warning').length,
    fault: devs.filter((d) => d && d.status === 'fault').length,
  }
}
const expandedSummary = computed(() =>
  expandedFloor.value && currentBuilding.value ? floorSummary(expandedFloor.value.id) : null
)
function floorPersonMotion(floorId) {
  const b = currentBuilding.value
  if (!b) return { moving: 0, static: 0, risk: 0 }
  const ps = (store.persons || []).filter((p) => p && p.building === b.name && p.floor === floorId)
  return {
    moving: ps.filter((p) => p && p.movementType === 'moving').length,
    static: ps.filter((p) => p && p.movementType === 'static').length,
    risk: ps.filter((p) => p && (p.status === 'warning' || p.status === 'emergency')).length,
  }
}
const expandedMotion = computed(() =>
  expandedFloor.value ? floorPersonMotion(expandedFloor.value.id) : { moving: 0, static: 0, risk: 0 }
)

// 重置演示：完整复位（store.resetEmergencyFlow → clearRouteFire → 停疏散动画/人员复位/阶段归零）
function resetEmergencyDemo() {
  // 同步关闭三个业务弹窗，避免复位后残留
  if (responseDialogTimer) { clearTimeout(responseDialogTimer); responseDialogTimer = null }
  showResponseDialog.value = false
  showRescueDialog.value = false
  store.resetEmergencyFlow()
  backToOverview()
}
// 右侧按钮解除火情：同样走完整复位（保证疏散灯/人员/路线全部还原）
function doClearFire() {
  resetEmergencyDemo()
}

function onBuildingChange() {
  selectedDevice.value = null
  selectedPerson.value = null
  showEmergencyPanel.value = false
  expandedFloor.value = null
  hoveredDevice.value = null
}

// ============ 楼栋总览：进入 / 返回 + 楼栋聚合统计 ============
function enterBuilding(bid) {
  selectedBuildingId.value = bid
  selectedDevice.value = null
  selectedPerson.value = null
  hoveredDevice.value = null
  expandedFloor.value = null
  viewMode.value = 'floors'
}
function selectBuilding(bid) {
  // 仅切换"当前选中楼栋"，不切换 viewMode（在总览页内切换预览目标）
  selectedBuildingId.value = bid
  selectedDevice.value = null
  selectedPerson.value = null
  hoveredDevice.value = null
  expandedFloor.value = null
  if (window.__dtwin?.camera?.focusBuilding) {
    window.__dtwin.camera.focusBuilding(true)
  }
}
function backToBuildings() {
  viewMode.value = 'buildings'
  expandedFloor.value = null
  selectedDevice.value = null
  selectedPerson.value = null
  hoveredDevice.value = null
}
function buildingDeviceCount(bname) {
  const b = store.buildings.find((x) => x && x.name === bname)
  if (!b) return 0
  return (store.devices || []).filter((d) => d && (d.building === bname || d.buildingId === b.id)).length
}
function buildingStatusColor(status) {
  return { normal: '#4361EE', warning: '#F59E0B', emergency: '#EF4444' }[status] || '#4361EE'
}
function buildingStatusText(status) {
  return { normal: '正常', warning: '警告', emergency: '应急' }[status] || '正常'
}


// 应急联动
function doEmergencyHighlight() {
  if (!currentBuilding.value || emFloors.value.length === 0) return
  store.setEmergencyMode(true)
  showEmergencyPanel.value = false
}
function doBatchDir(dir) {
  if (!currentBuilding.value || emFloors.value.length === 0) return
  store.batchSwitchEvacuationDirection(
    { building: currentBuilding.value.name, floors: emFloors.value },
    dir,
    '应急联动批量调整疏散方向'
  )
  showEmergencyPanel.value = false
}
const emPreviewCount = computed(() => {
  if (!currentBuilding.value || emFloors.value.length === 0) return 0
  return store.devices.filter(d =>
    d && d.building === currentBuilding.value.name &&
    emFloors.value.includes(d.floor) &&
    (d.type === 'emergency_light' || d.type === 'evacuation_light')
  ).length
})

// ============ 右侧信息栏（全园区统计 / 实时事件） ============
const personTotal = computed(() => store.personStats?.totalPersons ?? 0)
const personMoving = computed(() => store.personStats?.activeTargets ?? 0)
const personStatic = computed(() => store.personStats?.staticTargets ?? 0)
const personRisk = computed(() => store.personStats?.riskZones ?? 0)
function personOf(buildingName) {
  const dist = store.personStats?.buildingDistribution
  if (!dist) return 0
  return dist[buildingName] ?? 0
}
function personPct(buildingName) {
  const total = personTotal.value
  if (!total) return '0%'
  return Math.max(4, Math.round((personOf(buildingName) / total) * 100)) + '%'
}
const recentNotifications = computed(() =>
  (store.notifications || []).slice(0, 6)
)
function fmtTime(ts) {
  if (!ts) return '--:--:--'
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ============ 拖拽缩放 ============
function onWheel(e) {
  const delta = e.deltaY > 0 ? -0.1 : 0.1
  zoomScale.value = Math.max(0.5, Math.min(3, zoomScale.value + delta))
}
function onPanStart(e) {
  isPanning.value = true
  panStartX = e.clientX - zoomPanX.value
  panStartY = e.clientY - zoomPanY.value
}
function onPanMove(e) {
  if (!isPanning.value) return
  zoomPanX.value = e.clientX - panStartX
  zoomPanY.value = e.clientY - panStartY
}
function onPanEnd() {
  isPanning.value = false
}

onMounted(() => {
  // 恢复综合主页状态
  const saved = store.restoreDashboardView()
  if (saved) {
    if (saved.selectedBuildingId) selectedBuildingId.value = saved.selectedBuildingId
    if (saved.viewMode) viewMode.value = saved.viewMode
    if (saved.selectedFloorId && saved.viewMode !== 'buildings') {
      // 恢复楼层
      const f = currentFloorData.value?.find(x => x.id === saved.selectedFloorId)
      if (f) {
        expandedFloor.value = f
        viewMode.value = 'floorplan'
      }
    }
  }
  if (store.buildings.length > 0 && !selectedBuildingId.value) {
    selectedBuildingId.value = store.buildings.find(b => b?.name === '3号楼')?.id || store.buildings[0]?.id
  }
  // 默认生成 3号楼 / 5F 全区域疏散路线
  if (!store.routeMatrix && store.buildings.length) {
    const b3 = store.buildings.find(b => b?.name === '3号楼')
    store.generateRoutePlans({ buildingId: b3 ? b3.id : store.routeBuildingId, floorId: '5F' })
  }
  store.addOperationLog('进入综合主页', '综合', '', 'info')
  // 3D 查看器：Esc 关闭
  window.addEventListener('keydown', onEscClose3D)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEscClose3D)
})

// ============ 状态持久化：切换即保存 ============
watch(selectedBuildingId, () => {
  store.saveDashboardViewState({ buildingId: selectedBuildingId.value })
})
watch(viewMode, () => {
  store.saveDashboardViewState({ viewMode: viewMode.value })
  // 回到楼栋总览时总览页本身直接展示 3D，浮层无需保留
  if (viewMode.value === 'buildings') close3DViewer()
})
watch(expandedFloor, () => {
  store.saveDashboardViewState({ floorId: expandedFloor.value?.id })
})
</script>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 10px;
  overflow: hidden;
  position: relative;
}

/* ─── 顶部工具栏 ─── */
.top-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  background: #0A0E1A;
  border: 1px solid rgba(76,201,240,0.15);
  border-radius: 10px;
  flex-shrink: 0;
}
.building-selector {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(76,201,240,0.15);
  border: 1px solid rgba(76,201,240,0.2);
  border-radius: 6px;
  padding: 5px 12px;
  color: #4CC9F0;
}
.building-select {
  background: transparent;
  border: none;
  outline: none;
  color: #E2E8F0;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  padding-right: 4px;
  /* 关键：去掉浏览器原生下拉箭头，避免与右侧自定义 SVG 箭头重复出现两个 */
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
}
/* 展开下拉列表：深色底 + 浅色文字（与暗色主题一致） */
.building-select option {
  background: #0F172A;
  color: #E2E8F0;
}
.building-title {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.building-name {
  font-size: 16px;
  font-weight: 800;
  color: #E2E8F0;
  letter-spacing: 1px;
}
.building-subtitle {
  font-size: 12px;
  color: #64748B;
}
.top-actions {
  display: flex;
  gap: 8px;
}
.action-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.2s;
}
.action-btn.route { background: rgba(76,201,240,0.15); border-color: rgba(76,201,240,0.2); color: #4CC9F0; }
.action-btn.route:hover { background: rgba(76,201,240,0.15); }
.action-btn.emergency { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.35); color: var(--fire-red); }
.action-btn.emergency:hover, .action-btn.emergency.active { background: rgba(239,68,68,0.2); border-color: #EF4444; }
.action-btn.fire { background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.35); color: var(--fire-orange); }
.action-btn.fire:hover { background: rgba(245,158,11,0.18); }
.action-btn.warning { background: rgba(76,201,240,0.15); border-color: rgba(76,201,240,0.2); color: #4CC9F0; }
.action-btn.warning:hover { background: rgba(76,201,240,0.15); }
.action-btn.debug { background: rgba(34,197,94,0.1); border-color: rgba(34,197,94,0.3); color: #22C55E; }
.action-btn.debug:hover { background: rgba(34,197,94,0.18); }
.action-btn.debug.active { background: rgba(34,197,94,0.25); border-color: #22C55E; color: #E2E8F0; }

/* ─── 楼层网格（2×3） ─── */
.floor-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  flex: 1;
  overflow-y: auto;
  padding: 2px;
}
.floor-card {
  background: rgba(20,30,50,0.6);
  border: 1px solid rgba(76,201,240,0.15);
  border-radius: 10px;
  padding: 10px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 285px;
}
.floor-card:hover {
  border-color: rgba(76,201,240,0.4);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}
.floor-card.fire-floor {
  border-color: rgba(239,68,68,0.5);
  background: rgba(40,15,15,0.5);
}
.floor-label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.floor-num {
  font-size: 14px;
  font-weight: 800;
  color: #E2E8F0;
  letter-spacing: 1px;
}
.floor-note {
  font-size: 11px;
  color: #64748B;
}
.fire-tag {
  font-size: 11px;
  color: var(--fire-red);
  font-weight: 700;
}
.floor-svg {
  flex: 1;
  width: 100%;
  min-height: 0;
  border-radius: 6px;
  border: 1px solid rgba(76,201,240,0.12);
  background: rgba(10,14,26,0.6);
}

/* ─── 设备节点（关键动画规则） ─── */
.light-node {
  cursor: pointer;
  /* 设备容器禁止位移/缩放晃动：仅允许透明度/发光过渡 */
  transition: filter 0.15s, opacity 0.15s;
}
.light-node:hover { filter: brightness(1.35) drop-shadow(0 0 4px rgba(76, 201, 240, 0.6)); }
/* 正常状态：无动画 */
.light-node.emergency circle:nth-child(1) { animation: pulse-emergency 0.8s infinite; }
/* 疏散指示灯光晕恒绿；应急照明灯光晕暖白（红色光晕仅限告警类设备） */
.light-node.emergency.t-evacuation_light circle:nth-child(1) { animation: pulse-green 0.8s infinite; }
.light-node.emergency.t-emergency_light circle:nth-child(1) { animation: pulse-white 0.8s infinite; }
/* 选中设备：无动画，只有外圈高亮 */
.light-node.selected { filter: drop-shadow(0 0 4px #4361EE); }
/* 应急脉冲光圈：仅透明度 + 发光（禁止 r/scale 抖动设备本体） */
@keyframes pulse-emergency {
  0%,100% { opacity: 0.35; filter: drop-shadow(0 0 2px rgba(255, 59, 48, 0.4)); }
  50%     { opacity: 0.95; filter: drop-shadow(0 0 10px rgba(255, 59, 48, 0.9)); }
}
@keyframes pulse-green {
  0%,100% { opacity: 0.35; filter: drop-shadow(0 0 2px rgba(57, 255, 136, 0.4)); }
  50%     { opacity: 0.95; filter: drop-shadow(0 0 10px rgba(57, 255, 136, 0.9)); }
}
@keyframes pulse-white {
  0%,100% { opacity: 0.35; filter: drop-shadow(0 0 2px rgba(255, 247, 220, 0.4)); }
  50%     { opacity: 0.95; filter: drop-shadow(0 0 10px rgba(255, 247, 220, 0.85)); }
}

.sel-ring { pointer-events: none; }

/* 人员节点 */
.person-node circle:first-child { cursor: pointer; }
.warning-ring { animation: ring-pulse 1s infinite; }

.floor-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 2px;
  flex-shrink: 0;
}
.floor-stat {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #64748B;
}
.normal-count { color: var(--fire-green) !important; }
.warning-count { color: var(--fire-orange) !important; }
.emergency-count { color: var(--fire-red) !important; }
.zoom-btn {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid rgba(76,201,240,0.2);
  background: rgba(76,201,240,0.08);
  color: #4CC9F0;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}
.zoom-btn:hover { background: rgba(76,201,240,0.15); }

.empty-hint {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #64748B;
  font-size: 14px;
}

/* ─── 设备详情面板 ─── */
.device-panel {
  position: fixed;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  width: 280px;
  background: rgba(20,30,50,0.95);
  border: 1px solid rgba(76,201,240,0.15);
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 400;
  max-height: 80vh;
  overflow-y: auto;
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(76,201,240,0.1);
}
.panel-title {
  font-size: 13px;
  font-weight: 700;
  color: #E2E8F0;
  letter-spacing: 1px;
}
.close-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: #64748B;
  padding: 2px;
  border-radius: 4px;
  transition: all 0.15s;
  display: flex;
  align-items: center;
}
.close-btn:hover { color: var(--fire-red); background: rgba(239,68,68,0.06); }
.device-identity {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.device-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.device-icon.normal { background: rgba(76,201,240,0.12); color: #4CC9F0; }
.device-icon.warning { background: rgba(245,158,11,0.1); color: var(--fire-orange); }
.device-icon.emergency { background: rgba(239,68,68,0.1); color: var(--fire-red); }
.device-icon.fault { background: rgba(148,163,184,0.1); color: #64748B; }
.device-name {
  font-size: 13px;
  font-weight: 700;
  color: #E2E8F0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.device-id { font-size: 11px; color: #64748B; margin-top: 2px; }
.status-row { display: flex; gap: 8px; margin-bottom: 12px; }
.status-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
}
.status-badge.normal { background: rgba(34,197,94,0.1); color: var(--fire-green); }
.status-badge.warning { background: rgba(245,158,11,0.1); color: var(--fire-orange); }
.status-badge.emergency { background: rgba(239,68,68,0.1); color: var(--fire-red); }
.status-badge.fault { background: rgba(148,163,184,0.1); color: #64748B; }
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.mode-badge {
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(76,201,240,0.1);
  color: #4CC9F0;
}
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 14px;
}
.info-item { display: flex; flex-direction: column; gap: 2px; }
.info-item.full { grid-column: 1 / -1; }
.i-label { font-size: 10px; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px; }
.i-value { font-size: 13px; color: #64748B; font-weight: 600; }
.i-value.blue { color: #4CC9F0; }
.i-value.green { color: var(--fire-green); }
.i-value.red { color: var(--fire-red); }
.ctrl-section { margin-top: 4px; }
.ctrl-label {
  font-size: 11px;
  color: #64748B;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.dir-pad { display: flex; gap: 8px; }
.dir-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 4px;
  border-radius: 8px;
  border: 1px solid rgba(76,201,240,0.2);
  background: rgba(76,201,240,0.06);
  cursor: pointer;
  transition: all 0.2s;
  color: #64748B;
}
.dir-btn:hover { border-color: #4CC9F0; background: rgba(76,201,240,0.12); color: #4CC9F0; }
.dir-btn.active { border-color: #4CC9F0; background: rgba(76,201,240,0.15); color: #4CC9F0; }
.dir-arrow { font-size: 22px; font-weight: bold; }
.dir-label { font-size: 11px; }
.action-btns { display: flex; gap: 8px; margin-top: 12px; }
.act-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 4px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.2s;
}
.act-btn.emergency { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.4); color: var(--fire-red); }
.act-btn.emergency:hover { background: rgba(239,68,68,0.2); }
.act-btn.perception { background: rgba(76,201,240,0.15); border-color: rgba(76,201,240,0.2); color: #4CC9F0; }
.act-btn.perception:hover { background: rgba(76,201,240,0.15); }

/* ─── 应急联动面板 ─── */
.emergency-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;

}
.emergency-panel {
  width: 400px;
  padding: 20px;
  border-radius: 12px;
  background: rgba(20,30,50,0.95);
  border: 1px solid rgba(76,201,240,0.2);
  box-shadow: 0 12px 32px rgba(0,0,0,0.5);
}
.em-section { margin-bottom: 16px; }
.em-section-title {
  font-size: 12px;
  font-weight: 700;
  color: #64748B;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.em-check-row { display: flex; flex-wrap: wrap; gap: 8px; }
.em-check-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid rgba(76,201,240,0.15);
  background: rgba(76,201,240,0.06);
  font-size: 13px;
  font-weight: 600;
  color: #64748B;
  cursor: pointer;
  transition: all 0.15s;
}
.em-check-item:hover { border-color: #4CC9F0; color: #4CC9F0; }
.em-check-item input { accent-color: #4CC9F0; }
.em-actions { display: flex; gap: 8px; }
.em-action-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.2s;
}
.em-action-btn.emergency { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.4); color: var(--fire-red); }
.em-action-btn.emergency:hover { background: rgba(239,68,68,0.2); }
.em-action-btn.dir-left { background: rgba(76,201,240,0.15); border-color: rgba(76,201,240,0.2); color: #4CC9F0; }
.em-action-btn.dir-left:hover { background: rgba(76,201,240,0.15); }
.em-action-btn.dir-right { background: rgba(76,201,240,0.15); border-color: rgba(76,201,240,0.2); color: #4CC9F0; }
.em-action-btn.dir-right:hover { background: rgba(76,201,240,0.15); }
.em-preview {
  font-size: 12px;
  color: #64748B;
  text-align: center;
  padding: 8px;
  background: rgba(76,201,240,0.06);
  border-radius: 6px;
  margin-top: 12px;
}
.em-preview strong { color: #4CC9F0; }

/* ─── 楼层放大视图（首页内联展开，替代原弹窗；保留 .zoom-controls 缩放工具条） ─── */
.expanded-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: rgba(20,30,50,0.6);
  border: 1px solid rgba(76,201,240,0.15);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.expanded-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  border-bottom: 1px solid rgba(76,201,240,0.15);
  background: rgba(15,23,42,0.8);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid rgba(76,201,240,0.2);
  background: rgba(20,30,50,0.6);
  color: #4CC9F0;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.back-btn:hover { background: rgba(76,201,240,0.1); }
.expanded-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  white-space: nowrap;
}
.expanded-floor-name { color: #E2E8F0; font-size: 18px; font-weight: 800; }
.expanded-sub { color: #64748B; font-size: 12px; }
.fire-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(239,68,68,0.2);
  color: var(--fire-red);
  font-size: 12px;
  font-weight: 700;
}
.floor-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.floor-chip {
  min-width: 38px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(76,201,240,0.2);
  background: rgba(20,30,50,0.6);
  color: #64748B;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.floor-chip:hover { border-color: rgba(67,97,238,0.5); color: #4CC9F0; }
.floor-chip.active { background: #4361EE; border-color: rgba(76,201,240,0.8); color: #E2E8F0; }
.floor-chip.fire { border-color: rgba(239,68,68,0.55); color: var(--fire-red); }
.floor-chip.active.fire { background: var(--fire-red); border-color: var(--fire-red); color: #E2E8F0; }
.zoom-controls { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.zoom-ctrl-btn {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid rgba(76,201,240,0.2);
  background: rgba(76,201,240,0.08);
  color: #4CC9F0;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.zoom-ctrl-btn:hover { background: rgba(76,201,240,0.15); }
.zoom-ctrl-btn.fit { width: auto; padding: 0 10px; font-size: 12px; }
.zoom-pct { font-size: 13px; color: #64748B; min-width: 44px; text-align: center; font-weight: 600; }
.expanded-body {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
  padding: 12px;
}
.expanded-canvas {
  flex: 1;
  min-width: 0;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15,23,42,0.8);
  border: 1px solid rgba(76,201,240,0.15);
  border-radius: 10px;
  user-select: none;
}
.expanded-svg {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  transition: transform 0.1s ease-out;
}
.canvas-hint {
  position: absolute;
  left: 10px;
  bottom: 8px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(15,23,42,0.85);
  border: 1px solid rgba(76,201,240,0.2);
  color: #64748B;
  font-size: 11px;
  pointer-events: none;
  box-shadow: 0 2px 6px rgba(0,0,0,0.3);
}
.floor-info-panel {
  width: 252px;
  flex-shrink: 0;
  min-height: 0;
  max-height: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  padding: 12px;
  background: rgba(15,23,42,0.6);
  border: 1px solid rgba(76,201,240,0.15);
  border-radius: 10px;
}
.fip-head { display: flex; align-items: center; justify-content: space-between; }
.rail-title { font-size: 13px; color: #64748B; font-weight: 700; letter-spacing: 0.05em; }
.fip-fire-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(239,68,68,0.2);
  color: var(--fire-red);
  font-size: 11px;
  font-weight: 700;
}
.fip-ok-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(34,197,94,0.15);
  color: #22C55E;
  font-size: 11px;
  font-weight: 700;
}
.fip-alert {
  border: 1px solid rgba(239,68,68,0.5);
  background: rgba(40,15,15,0.6);
  border-radius: 8px;
  padding: 8px 10px;
}
.fip-alert-title { color: var(--fire-red); font-size: 13px; font-weight: 800; margin-bottom: 6px; }
.fip-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 3px 0; }
.fip-row span { color: #64748B; }
.fip-row b { color: #E2E8F0; font-weight: 700; }
.fip-row .danger-text { color: var(--fire-red); }
.fip-row .ok-text { color: #22C55E; }
.fip-row .warning-text { color: #F59E0B; }
/* 滞留人员清单（阶段5/6） */
.fip-stranded-list { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.fip-stranded-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 8px;
  background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.35);
  font-size: 12px; color: #E2E8F0;
}
.fip-stranded-item .fs-badge { flex: none; }
.fip-stranded-item .fs-name { font-weight: 700; color: #ff8a8a; flex: none; }
.fip-stranded-item .fs-loc { flex: 1; color: #cfe3ff; }
.fip-stranded-item .fs-status { flex: none; color: #F59E0B; font-weight: 700; }
.fip-stranded-item .fs-status.ok-text { color: #22C55E; }
.fip-rescue-done {
  margin-top: 6px; padding: 8px 10px; border-radius: 8px;
  background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.4);
  color: #4ade80; font-size: 12px; font-weight: 700;
}
.fip-clear-btn {
  width: 100%;
  margin-top: 6px;
  padding: 6px 0;
  border-radius: 6px;
  border: 1px solid rgba(239,68,68,0.5);
  background: rgba(20,30,50,0.6);
  color: var(--fire-red);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s;
}
.fip-clear-btn:hover { background: var(--fire-red); color: #E2E8F0; }
.fip-block {
  background: rgba(20,30,50,0.6);
  border: 1px solid rgba(76,201,240,0.15);
  border-radius: 8px;
  padding: 8px 10px;
}
.fip-main-stat { display: flex; align-items: baseline; justify-content: space-between; }
.fip-label { font-size: 12px; color: #64748B; font-weight: 600; }
.fip-big { font-size: 26px; font-weight: 800; color: #4CC9F0; line-height: 1.1; }
.fip-big i { font-style: normal; font-size: 12px; color: #64748B; font-weight: 600; margin-left: 2px; }
.fip-mini-rows { display: flex; gap: 12px; margin-top: 6px; flex-wrap: wrap; }
.fip-mini { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: #64748B; }
.fip-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.fip-dot.moving { background: #4361EE; }
.fip-dot.static { background: #94A3B8; }
.fip-dot.risk { background: #EF4444; }
.fip-mini.risk { color: var(--fire-red); font-weight: 600; }
.fip-sec-title { font-size: 12px; color: #64748B; font-weight: 700; margin-bottom: 6px; }
.fip-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.fip-cell {
  border: 1px solid rgba(76,201,240,0.1);
  border-radius: 6px;
  background: rgba(15,23,42,0.5);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
}
.fc-val { font-size: 18px; font-weight: 800; color: #4CC9F0; line-height: 1.1; }
.fc-lbl { font-size: 11px; color: #64748B; margin-top: 2px; }
.fc-sub { font-size: 10px; color: var(--fire-orange); margin-top: 1px; }
.fip-warn-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.warn-chip { padding: 2px 8px; border-radius: 999px; background: rgba(245,158,11,0.2); color: #F59E0B; font-size: 11px; font-weight: 700; }
.fault-chip { padding: 2px 8px; border-radius: 999px; background: rgba(239,68,68,0.2); color: var(--fire-red); font-size: 11px; font-weight: 700; }
.ok-chip { padding: 2px 8px; border-radius: 999px; background: rgba(34,197,94,0.15); color: #22C55E; font-size: 11px; font-weight: 700; }


/* ─── 人员感知横条已移除（保留 live-dot 供右侧信息栏使用） ─── */
.live-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--fire-green);
  animation: live-blink 1.5s infinite;
}
@keyframes live-blink { 0%,100% { opacity:1; } 50% { opacity:0.3; } }

/* ─── 设备悬浮 Tooltip ─── */
.device-tooltip {
  position: fixed;
  z-index: 800;
  pointer-events: none;
  background: rgba(15,23,42,0.85);
  color: #E2E8F0;
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 11px;
  min-width: 150px;
  box-shadow: 0 8px 20px rgba(0,0,0,0.5);
  border: 1px solid rgba(76,201,240,0.2);
}
.tt-name { font-size: 12px; font-weight: 700; margin-bottom: 4px; color: #4CC9F0; }
.tt-row { display: flex; justify-content: space-between; gap: 12px; line-height: 1.7; }
.tt-label { color: #64748B; }
.tt-status { display: flex; align-items: center; gap: 4px; font-weight: 600; }
.tt-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.tt-status.normal { color: #22C55E; }
.tt-status.warning { color: #F59E0B; }
.tt-status.emergency { color: #F59E0B; }
.tt-status.fault { color: #64748B; }

/* ─── 人员感知详情 Drawer ─── */
.person-detail-panel {
  position: fixed;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  width: 290px;
  max-height: 80vh;
  overflow-y: auto;
  background: rgba(20,30,50,0.95);
  border: 1px solid rgba(76,201,240,0.15);
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 400;
}
.radar-title { font-size: 15px; font-weight: 800; color: #E2E8F0; margin-bottom: 10px; letter-spacing: 0.5px; }
.radar-count {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 10px 14px;
  background: rgba(76,201,240,0.08);
  border-radius: 8px;
  margin-bottom: 12px;
}
.rc-num { font-size: 26px; font-weight: 800; color: #4CC9F0; }
.rc-label { font-size: 12px; color: #64748B; }
.radar-list { display: flex; flex-direction: column; gap: 8px; }
.radar-item { border: 1px solid rgba(76,201,240,0.15); border-radius: 8px; padding: 8px 10px; background: rgba(76,201,240,0.05); }
.ri-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.ri-id { font-size: 12px; font-weight: 700; color: #E2E8F0; }
.ri-status { font-size: 10px; padding: 1px 6px; border-radius: 8px; font-weight: 600; }
.ri-status.normal { background: rgba(34,197,94,0.15); color: var(--fire-green); }
.ri-status.warn { background: rgba(239,68,68,0.2); color: var(--fire-red); }
.ri-rows { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; }
.ri-row { display: flex; justify-content: space-between; font-size: 11px; }
.ri-label { color: #64748B; }

/* ─── 疏散路线绘制 ─── */
.route-active {
  fill: none;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.route-backup {
  fill: none;
  stroke-width: 2;
  stroke-dasharray: 4 3;
  opacity: 0.4;
  stroke-linecap: round;
}
.route-fire {
  fill: none;
  stroke: #EF4444;
  stroke-width: 2.5;
  stroke-dasharray: 5 4;
  opacity: 0.85;
  stroke-linecap: round;
  stroke-linejoin: round;
  animation: route-blink 1s infinite;
}
@keyframes route-blink { 0%,100% { opacity:0.4; } 50% { opacity:0.9; } }
.route-start { fill: #22C55E; stroke: #fff; stroke-width: 1.5; }

/* ─── 动画 ─── */
.fire-zone-pulse { animation: fire-pulse 1.5s infinite; }
.warning-ring { animation: ring-pulse 1s infinite; }
@keyframes fire-pulse { 0%,100% { opacity:0.6; } 50% { opacity:1; } }
@keyframes ring-pulse { 0%,100% { opacity:1; r:10; } 50% { opacity:0.5; r:13; } }

/* ─── 过渡 ─── */
.slide-in-enter-active, .slide-in-leave-active { transition: all 0.25s ease; }
.slide-in-enter-from { transform: translateY(-50%) translateX(30px); opacity: 0; }
.slide-in-leave-to { transform: translateY(-50%) translateX(30px); opacity: 0; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.modal-fade-enter-active, .modal-fade-leave-active { transition: all 0.25s ease; }
.modal-fade-enter-from { opacity: 0; transform: scale(0.95); }
.modal-fade-leave-to { opacity: 0; transform: scale(0.95); }

/* ─── 楼栋总览：3D 主体 + 右侧楼栋列表 ─── */
.building-overview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
  padding: 4px 2px;
}
.bo-head { display: flex; align-items: baseline; gap: 12px; flex-shrink: 0; }
.bo-title { font-size: 18px; font-weight: 800; color: #E2E8F0; letter-spacing: 1px; }
.bo-sub { font-size: 12px; color: #64748B; }

.bo-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 16px;
}
.bo-3d {
  position: relative;
  min-width: 0;
  min-height: 0;
  border-radius: 12px;
  overflow: hidden;
  background: #0E1624;
  border: 1px solid rgba(76,201,240,0.18);
}
.bo-3d-actions {
  position: absolute;
  left: 16px;
  bottom: 16px;
  display: flex;
  gap: 8px;
  z-index: 5;
  pointer-events: none;
}
.bo-action {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 700;
  color: #0E1624;
  background: linear-gradient(135deg, #4CC9F0, #4361EE);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(67,97,238,0.4);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.bo-action:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(67,97,238,0.55);
}

.bo-side {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(15,23,42,0.55);
  border: 1px solid rgba(76,201,240,0.15);
  border-radius: 12px;
  padding: 12px;
  overflow: hidden;
}
.bo-side-title {
  font-size: 13px;
  font-weight: 700;
  color: #94A3B8;
  letter-spacing: 1px;
  flex-shrink: 0;
}
.bo-card-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 4px;
}
.bo-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(20,30,50,0.55);
  border: 1px solid rgba(76,201,240,0.12);
  cursor: pointer;
  transition: all 0.2s ease;
}
.bo-card:hover {
  border-color: rgba(76,201,240,0.35);
  background: rgba(30,45,70,0.65);
}
.bo-card.cur {
  border-color: #4CC9F0;
  background: rgba(76,201,240,0.10);
  box-shadow: 0 0 0 1px rgba(76,201,240,0.25), 0 4px 16px rgba(76,201,240,0.15);
}
.bo-card.emergency { border-left: 3px solid rgba(239,68,68,0.7); }
.bo-card.warning   { border-left: 3px solid rgba(245,158,11,0.7); }
.bo-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.bo-card-name {
  font-size: 16px;
  font-weight: 800;
  color: #E6EDF7;
  letter-spacing: 0.5px;
}
.bo-card.cur .bo-card-name { color: #4CC9F0; }
.bo-card-no {
  font-size: 12px;
  color: #7E93B5;
  font-weight: 700;
}
.bo-card-type { font-size: 12px; color: #9FB2CE; }
.bo-card-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
}
.bo-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.bo-status { font-weight: 700; }
.bo-stat { color: #94A3B8; margin-left: auto; }
.bo-stat b { color: #E6EDF7; font-weight: 800; font-size: 13px; }
.bo-card.emergency .bo-stat b { color: #EF4444; }
.bo-card.warning .bo-stat b   { color: #F59E0B; }

@media (max-width: 1280px) {
  .bo-body { grid-template-columns: minmax(0, 1fr) 280px; }
}

/* 返回楼栋总览按钮 */
.back-to-buildings {
  display: inline-flex; align-items: center; gap: 6px;
  align-self: flex-start;
  padding: 6px 14px;
  margin-bottom: 8px;
  border-radius: 8px;
  border: 1px solid rgba(76,201,240,0.3);
  background: rgba(20,30,50,0.6);
  color: #4CC9F0;
  font-size: 13px; font-weight: 700;
  cursor: pointer;
  transition: all 0.2s;
}
.back-to-buildings:hover { background: rgba(76,201,240,0.12); border-color: rgba(76,201,240,0.6); }

/* 三级视图切换过渡（fade + scale 300ms） */
.view-fade-enter-active, .view-fade-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.view-fade-enter-from, .view-fade-leave-to { opacity: 0; transform: scale(0.96); }
.dash-view { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

/* ─── 主区双栏布局：左楼层网格 + 右侧信息栏 ─── */
.dash-main {
  display: flex;
  gap: 10px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.main-zone {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* ─── 3D 模型入口按钮（楼层平面图上方，按需打开浮层查看器）─── */
.open-3d-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border-radius: 8px;
  border: 1px solid rgba(76, 201, 240, 0.45);
  background: linear-gradient(135deg, rgba(67, 97, 238, 0.25), rgba(76, 201, 240, 0.14));
  color: #7DD3FC;
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.18s;
}
.open-3d-btn:hover {
  background: linear-gradient(135deg, rgba(67, 97, 238, 0.42), rgba(76, 201, 240, 0.24));
  border-color: #4CC9F0;
  color: #E0F2FE;
  box-shadow: 0 0 12px rgba(76, 201, 240, 0.25);
}
.open-3d-btn.active { border-color: #4CC9F0; color: #E0F2FE; }

/* ─── 3D 数字孪生查看浮层 ─── */
.dtwin-modal {
  position: absolute;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  background: rgba(8, 12, 22, 0.72);
  backdrop-filter: blur(3px);
  border-radius: 12px;
}
.dtwin-modal-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #101827;
  border: 1px solid rgba(76, 201, 240, 0.35);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
}
.dtwin-modal-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  background: rgba(15, 23, 42, 0.9);
  border-bottom: 1px solid rgba(76, 201, 240, 0.2);
}
.dtwin-modal-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13.5px;
  font-weight: 800;
  color: #E2E8F0;
  letter-spacing: 0.4px;
}
.dtwin-modal-title svg { color: #4CC9F0; }
.dtwin-modal-sub { font-size: 12px; color: #4CC9F0; font-weight: 600; }
.dtwin-modal-tip { font-size: 11.5px; color: #64748B; margin-left: auto; }
.dtwin-modal-close {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 7px;
  border: 1px solid rgba(76, 201, 240, 0.3);
  background: rgba(20, 30, 50, 0.8);
  color: #CBD5E1;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.18s;
}
.dtwin-modal-close:hover { background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.55); color: #FCA5A5; }
.dtwin-modal-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  overflow: hidden;
}
/* 楼层快捷选择条 */
.floor-tabs {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: rgba(15, 23, 42, 0.7);
  border: 1px solid rgba(76, 201, 240, 0.15);
  border-radius: 10px;
  flex-wrap: wrap;
}
.ft-tabs { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.ft-label { font-size: 12px; color: #64748B; margin-right: 4px; }
.ft-tab {
  background: rgba(76, 201, 240, 0.08);
  border: 1px solid rgba(76, 201, 240, 0.22);
  color: #CBD5E1;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  transition: all 0.15s;
}
.ft-tab:hover { background: rgba(76, 201, 240, 0.18); color: #E2E8F0; }
.ft-tab.cur { background: #4361EE; color: #fff; border-color: #4361EE; }
.ft-tab.fire { border-color: rgba(255, 77, 79, 0.6); color: #FF7875; }
.ft-tab.all { background: rgba(67, 97, 238, 0.1); }
.right-rail {
  width: 300px;
  flex-shrink: 0;
  min-height: 0;
  max-height: 100%;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 2px 2px 2px 0;
}
.rail-card {
  background: rgba(20,30,50,0.6);
  border: 1px solid rgba(76,201,240,0.15);
  border-radius: 10px;
  padding: 10px 12px;
  flex-shrink: 0;
}
.rail-events {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.rail-title {
  font-size: 13px;
  font-weight: 800;
  color: #E2E8F0;
  letter-spacing: 0.5px;
  position: relative;
  padding-left: 10px;
}
.rail-title::before {
  content: '';
  position: absolute;
  left: 0; top: 50%;
  transform: translateY(-50%);
  width: 3px; height: 12px;
  border-radius: 2px;
  background: linear-gradient(180deg, #4361EE, #4CC9F0);
}
.rail-live {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--fire-green);
  font-weight: 700;
  letter-spacing: 1px;
}
.rail-sub {
  font-size: 11px;
  color: #64748B;
  font-weight: 600;
}

/* 卡 1：楼宇实时状态 */
.bldg-rows { display: flex; flex-direction: column; gap: 5px; }
.bldg-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(15,23,42,0.6);
  transition: background 0.15s;
}
.bldg-row.cur { background: rgba(76,201,240,0.12); box-shadow: inset 0 0 0 1px rgba(67,97,238,0.25); }
.bldg-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.bldg-dot.normal { background: rgba(34,197,94,0.25); box-shadow: 0 0 6px rgba(34,197,94,0.8); }
.bldg-dot.warning { background: #F59E0B; box-shadow: 0 0 6px rgba(245,158,11,0.8); }
.bldg-dot.emergency { background: #EF4444; box-shadow: 0 0 6px rgba(239,68,68,0.9); animation: live-blink 1s infinite; }
.bldg-name { font-size: 12px; font-weight: 700; color: #E2E8F0; }
.bldg-fire { font-size: 10px; color: var(--fire-red); font-weight: 700; margin-left: 2px; }
.bldg-num { margin-left: auto; font-size: 13px; color: #4CC9F0; font-weight: 700; }
.bldg-num::after { content: ' 台'; font-size: 10px; color: #64748B; font-weight: 400; }

/* 卡 2：人员分布 */
.pp-rows { display: flex; flex-direction: column; gap: 6px; }
.pp-row { display: flex; align-items: center; gap: 8px; }
.pp-name { width: 44px; font-size: 11px; color: #64748B; font-weight: 600; flex-shrink: 0; }
.pp-track { flex: 1; height: 7px; border-radius: 4px; background: rgba(76,201,240,0.1); overflow: hidden; }
.pp-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #4361EE, #4CC9F0); transition: width 0.4s; }
.pp-num { width: 34px; text-align: right; font-size: 12px; color: #E2E8F0; font-weight: 700; }
.pp-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px dashed rgba(67,97,238,0.15);
  flex-wrap: wrap;
}
.pp-leg { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #64748B; }
.pp-ic { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.pp-ic.moving { background: #4361EE; }
.pp-ic.static { background: #94A3B8; }
.risk-chip { margin-left: auto; font-size: 10px; font-weight: 700; color: var(--fire-orange); }

/* 卡 3：应急状态 */
.em-badge { font-size: 10px; font-weight: 800; padding: 2px 8px; border-radius: 20px; letter-spacing: 1px; }
.em-badge.on { background: rgba(239,68,68,0.2); color: var(--fire-red); animation: live-blink 1.2s infinite; }
.em-badge.off { background: rgba(34,197,94,0.15); color: var(--fire-green); }
.em-fire-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 6px;
  background: rgba(239,68,68,0.05);
  margin-bottom: 9px;
}
.em-fire-dot { width: 7px; height: 7px; border-radius: 50%; background: #EF4444; margin-top: 3px; flex-shrink: 0; animation: live-blink 0.8s infinite; }
.em-fire-text { font-size: 11px; color: var(--fire-red); font-weight: 600; line-height: 1.5; }
.em-ok-dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(34,197,94,0.25); margin-top: 3px; flex-shrink: 0; }
.em-ok-text { font-size: 11px; color: var(--fire-green); font-weight: 600; }
.em-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.em-btn {
  padding: 6px 4px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.15s;
  white-space: nowrap;
}
.em-btn.danger { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.4); color: var(--fire-red); }
.em-btn.danger:hover:not(:disabled) { background: rgba(239,68,68,0.2); }
.em-btn.fire { background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.3); color: var(--fire-orange); }
.em-btn.fire:hover { background: rgba(245,158,11,0.2); }
.em-btn.clear { background: rgba(148,163,184,0.06); border-color: rgba(148,163,184,0.3); color: #64748B; }
.em-btn.clear:hover:not(:disabled) { background: rgba(148,163,184,0.15); }
.em-btn:disabled { opacity: 0.45; cursor: not-allowed; }

/* 卡 4：实时事件 */
.evt-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.evt-empty { font-size: 12px; color: #64748B; text-align: center; padding: 18px 0; }
.evt-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(15,23,42,0.6);
}
.evt-dot { width: 6px; height: 6px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; }
.evt-dot.danger { background: #EF4444; box-shadow: 0 0 4px rgba(239,68,68,0.5); }
.evt-dot.warning { background: #F59E0B; }
.evt-dot.success { background: rgba(34,197,94,0.25); }
.evt-dot.info { background: #4361EE; }
.evt-body { flex: 1; min-width: 0; }
.evt-title { font-size: 11px; font-weight: 700; color: #E2E8F0; }
.evt-msg { font-size: 10px; color: #64748B; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.evt-time { font-size: 10px; color: #64748B; flex-shrink: 0; margin-top: 1px; }

/* ─── 楼层网格滚动约束 + 响应式列数 ─── */
.floor-grid { min-height: 0; }
@media (max-width: 1279px) {
  .right-rail { width: 240px; }
  .floor-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 1023px) {
  .right-rail { width: 220px; }
  .floor-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 860px) {
  .right-rail { width: 210px; }
  .floor-grid { grid-template-columns: 1fr; }
}

/* ══════════ 五阶段应急处置流程：进度条 ══════════ */
.emg-stepper {
  display: flex; align-items: center; gap: 6px;
  padding: 10px 18px; margin: 0 0 10px;
  background: rgba(15,23,42,0.85);
  border: 1px solid rgba(76,201,240,0.2);
  border-radius: 12px;
}
.emg-step { display: flex; align-items: center; gap: 6px; position: relative; }
.emg-ico {
  width: 22px; height: 22px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; color: #64748B; background: rgba(100, 116, 139, 0.14);
  transition: all 0.3s;
}
.emg-step.done .emg-ico { background: rgba(34, 197, 94, 0.18); color: #22C55E; }
.emg-step.cur .emg-ico { background: rgba(239, 68, 68, 0.2); color: #EF4444; box-shadow: 0 2px 8px rgba(239, 68, 68, 0.28); }
.emg-name { font-size: 12px; color: #64748B; white-space: nowrap; }
.emg-step.done .emg-name { color: #22C55E; }
.emg-step.cur .emg-name { color: #E2E8F0; font-weight: 600; }
.emg-line { width: 22px; height: 2px; background: rgba(100, 116, 139, 0.25); margin: 0 2px; }
.emg-step.done + .emg-step .emg-line, .emg-step.cur + .emg-step .emg-line { background: rgba(34, 197, 94, 0.5); }
.emg-reset {
  margin-left: auto; border: 1px solid rgba(239,68,68,0.5); color: #EF4444;
  background: rgba(239,68,68,0.1); border-radius: 8px; padding: 5px 12px;
  font-size: 12px; cursor: pointer; white-space: nowrap;
}
.emg-reset:hover { background: rgba(239,68,68,0.2); }
/* ══════════ 中央决策层（fixed 居中遮罩，半透明可透视平面图） ══════════ */
.stage-overlay {
  position: fixed; inset: 0; z-index: 900;
  background: rgba(10,14,26,0.7);
  display: flex; align-items: center; justify-content: center;
}
.event-card {
  width: 420px; max-width: 90vw;
  background: rgba(15,23,42,0.85);
  border: 1px solid rgba(76,201,240,0.2);
  border-radius: 16px; padding: 26px 28px;
  box-shadow: 0 24px 48px rgba(0,0,0,0.6);
  display: flex; flex-direction: column; align-items: center; text-align: center;
}
.event-card.danger { border-color: rgba(239,68,68,0.5); }
.event-icon {
  width: 54px; height: 54px; border-radius: 50%;
  background: rgba(239,68,68,0.2); color: #EF4444;
  display: flex; align-items: center; justify-content: center;
  font-size: 28px; font-weight: 700; margin-bottom: 12px;
  box-shadow: 0 4px 14px rgba(239, 68, 68, 0.12);
  animation: stage-icon-pulse 1.6s ease-in-out infinite;
}
.event-icon.amber { background: rgba(245, 158, 11, 0.12); color: #B45309; box-shadow: 0 4px 14px rgba(245, 158, 11, 0.12); animation: none; }
.event-icon.blue { background: rgba(76, 201, 240, 0.14); color: #0284C7; box-shadow: 0 4px 14px rgba(76, 201, 240, 0.12); animation: none; }
@keyframes stage-icon-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.event-kicker { font-size: 11px; letter-spacing: 3px; color: #4CC9F0; margin-bottom: 6px; }
.event-card.danger .event-kicker { color: #EF4444; }
.event-title { font-size: 22px; font-weight: 700; color: #E2E8F0; margin-bottom: 10px; }
.event-loc { font-size: 18px; color: #EF4444; font-weight: 700; margin-bottom: 8px; }
.event-desc { font-size: 12px; color: #64748B; line-height: 1.7; margin-bottom: 12px; }
.event-meta { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-bottom: 18px; }
.em-chip {
  font-size: 11px; color: #64748B; background: rgba(76,201,240,0.08);
  border-radius: 6px; padding: 3px 8px; white-space: nowrap;
}
.event-list { list-style: none; padding: 0; margin: 0 0 16px; width: 100%; text-align: left; }
.event-list li {
  font-size: 12px; color: #64748B; line-height: 1.8; padding-left: 20px; position: relative;
}
.event-list li::before { content: '▸'; position: absolute; left: 4px; color: #4CC9F0; }
.event-actions { display: flex; gap: 10px; justify-content: center; width: 100%; }
.event-btn {
  border: none; border-radius: 9px; padding: 9px 22px; font-size: 14px; font-weight: 600;
  cursor: pointer; color: #FFFFFF; transition: all 0.2s;
}
.event-btn.danger { background: #DC2626; box-shadow: 0 4px 12px rgba(239, 68, 68, 0.18); }
.event-btn.danger:hover { filter: brightness(1.08); }
.event-btn.ghost { background: rgba(76,201,240,0.08); color: #64748B; border: 1px solid rgba(76,201,240,0.2); }
.event-btn.ghost:hover { background: rgba(76,201,240,0.15); }
.plan-summary {
  width: 100%; background: rgba(76,201,240,0.08);
  border: 1px dashed rgba(76, 201, 240, 0.3); border-radius: 10px;
  padding: 10px 12px; margin-bottom: 16px;
}
.plan-summary-name { font-size: 14px; font-weight: 700; color: #4CC9F0; margin-bottom: 8px; }
.plan-summary-rows { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
/* ══════════ 展开头部阶段徽标 ══════════ */
.stage-chip {
  font-size: 11px; color: #EF4444; background: rgba(239,68,68,0.2);
  border: 1px solid rgba(239,68,68,0.5); border-radius: 6px;
  padding: 2px 8px; margin-left: 8px; vertical-align: 1px;
}
/* ══════════ 应急灯强闪（仅灯具节点，非整页） ══════════ */
.emg-pulse { animation: emg-flash 0.7s ease-in-out infinite; transform-origin: center; }
@keyframes emg-flash {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
/* ══════════ 执行路线流动动画 ══════════ */
.route-execute {
  fill: none; stroke-width: 3.2; stroke-linecap: round; stroke-linejoin: round;
  stroke-dasharray: 14 8; animation: route-flow 0.9s linear infinite;
  filter: drop-shadow(0 0 6px rgba(76, 201, 240, 0.7));
}
@keyframes route-flow { to { stroke-dashoffset: -22; } }
/* ══════════ 通用微件 ══════════ */
.blink-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: #F59E0B; margin-right: 4px; animation: blink-dot 1s step-start infinite;
}
.blink-dot.red { background: #EF4444; }
@keyframes blink-dot { 50% { opacity: 0.15; } }
.fip-wait-note {
  font-size: 11px; color: #64748B; line-height: 1.6;
  background: rgba(76,201,240,0.08); border-left: 2px solid rgba(76, 201, 240, 0.5);
  padding: 6px 10px; border-radius: 4px; margin: 8px 0;
}
.fip-sub { font-size: 11px; color: #64748B; margin-bottom: 8px; }
.fip-warn-text { color: #F59E0B; font-size: 12px; }

/* A/B/C/D 分区方案组 */
.fip-zone-list { display: flex; flex-direction: column; gap: 10px; margin: 8px 0; }
.fip-zone-group {
  border: 1px solid rgba(76,201,240,0.14);
  border-radius: 10px;
  padding: 8px 10px;
  background: rgba(15,23,42,0.5);
}
.fip-zone-head {
  display: flex; align-items: center; gap: 8px;
  padding-bottom: 6px; margin-bottom: 6px;
  border-bottom: 1px dashed rgba(76,201,240,0.18);
}
.fip-zone-name { font-size: 12px; font-weight: 800; color: #E2E8F0; letter-spacing: 1px; }
.fip-zone-fire {
  font-size: 10px; font-weight: 700; color: #EF4444;
  background: rgba(239,68,68,0.14); border: 1px solid rgba(239,68,68,0.4);
  border-radius: 4px; padding: 1px 6px;
}
.fip-zone-exit { margin-left: auto; font-size: 10px; color: #64748B; }

/* ══════════ 疏散方案卡片（A/B/C） ══════════ */
.fip-plan-list { display: flex; flex-direction: column; gap: 8px; margin: 6px 0 10px; }
.fip-plan {
  width: 100%; text-align: left;
  border: 1px solid rgba(76,201,240,0.2); border-radius: 10px;
  background: rgba(15,23,42,0.85); padding: 9px 12px; cursor: pointer;
  transition: all 0.2s;
  font-family: inherit; color: inherit;
}
.fip-plan:hover { border-color: rgba(76,201,240,0.5); background: rgba(76,201,240,0.12); }
.fip-plan.active { border-color: rgba(76,201,240,0.8); background: rgba(76,201,240,0.12); box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
.fip-plan-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.plan-badge {
  width: 20px; height: 20px; border-radius: 6px; flex: none;
  background: rgba(76,201,240,0.15); color: #64748B;
  font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
}
.fip-plan.active .plan-badge { background: #4361EE; color: #E2E8F0; }
.fip-plan:nth-child(2) .plan-badge { background: rgba(67,97,238,0.2); color: #4CC9F0; }
.plan-name { font-size: 12px; font-weight: 600; color: #E2E8F0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-rec {
  font-size: 10px; color: #E2E8F0; background: rgba(34,197,94,0.25); border-radius: 4px;
  padding: 1px 6px; font-weight: 700; margin-left: auto;
}
.plan-sel {
  font-size: 10px; color: #E2E8F0; background: #4361EE; border-radius: 4px;
  padding: 1px 6px; font-weight: 700;
}
.fip-plan-meta { display: flex; flex-wrap: wrap; gap: 5px; }
/* ══════════ 疏散执行进度 ══════════ */
.run-title { color: #22C55E; }
/* 颜色语义：方案决策=系统蓝；滞留人员=警示橙；协同救援=救援橙；红色仅保留给火灾处置中 */
.plan-title { color: #4CC9F0; }
.warn-title { color: #F59E0B; }
.rescue-title { color: #FB923C; }
.evac-run-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin: 10px 0 8px; }
.evac-cell {
  background: rgba(15,23,42,0.5); border: 1px solid rgba(76,201,240,0.2);
  border-radius: 8px; padding: 8px 4px; text-align: center;
}
.evac-cell span { display: block; font-size: 10px; color: #64748B; margin-bottom: 4px; }
.evac-cell b { font-size: 18px; }
.evac-bar { height: 8px; border-radius: 4px; background: rgba(76,201,240,0.1); overflow: hidden; margin-bottom: 8px; }
.evac-bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #4361EE, #4CC9F0); transition: width 0.4s ease; }
/* 弹层淡入缩放过渡 */
.alert-pop-enter-active, .alert-pop-leave-active { transition: opacity 0.25s ease, transform 0.25s ease; }
.alert-pop-enter-from, .alert-pop-leave-to { opacity: 0; transform: translate(-50%, -50%) scale(0.94); }
.alert-pop-enter-to, .alert-pop-leave-from { opacity: 1; transform: translate(-50%, -50%) scale(1); }

/* ══════════ UI 细节规范覆盖层（明亮专业·克制·字号整体上调） ══════════ */
.top-bar { padding: 10px 16px; gap: 14px; }
.building-select { font-size: 14px; }
.building-name { font-size: 18px; letter-spacing: 0.5px; }
.building-subtitle { font-size: 12.5px; color: #64748B; }
.action-btn { padding: 8px 15px; font-size: 13px; border-radius: 7px; gap: 6px; }
.floor-grid { gap: 12px; }
.floor-card { padding: 11px; gap: 7px; border-radius: 12px; background: rgba(15,23,42,0.85); }
.floor-num { font-size: 17px; }
.floor-note { font-size: 12.5px; color: #64748B; }
.fire-tag { font-size: 12px; }
.floor-svg { border-radius: 8px; }
.floor-stat { font-size: 12.5px; color: #64748B; }
.zoom-btn { font-size: 12.5px; padding: 5px 12px; border-radius: 6px; }
/* 楼层状态 chip（footer）：色由 normal-count/warning-count/emergency-count 提供 */
.st-chip { margin-left: auto; display: inline-flex; align-items: center; font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: 999px; letter-spacing: 0.3px; }
.st-chip.normal-count { background: rgba(34,197,94,0.1); }
.st-chip.warning-count { background: rgba(245,158,11,0.12); }
.st-chip.emergency-count { background: rgba(239,68,68,0.2); animation: live-blink 1.2s infinite; }
/* 右侧 rail：白卡 + 字号上调 */
.rail-card { border-radius: 12px; background: rgba(15,23,42,0.85); }
.rail-events { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rail-title { font-size: 15px; }
.rail-live { font-size: 11px; }
.rail-sub { font-size: 12.5px; }
.bldg-row { padding: 6px 8px; }
.bldg-row.cur { background: rgba(76,201,240,0.1); }
.bldg-name { font-size: 13px; }
.bldg-fire { font-size: 11px; }
.bldg-num { font-size: 14px; }
.pp-rows { gap: 7px; }
.pp-row.cur { background: rgba(76,201,240,0.08); border-radius: 6px; padding: 2px 6px; margin: 0 -6px; }
.pp-name { font-size: 12px; }
.pp-num { font-size: 12.5px; }
.pp-leg { font-size: 11.5px; }
.risk-chip { font-size: 11.5px; }
.em-badge { font-size: 11px; }
.em-fire-text { font-size: 12.5px; }
.em-ok-text { font-size: 12.5px; }
.em-btn { font-size: 12.5px; padding: 8px 4px; border-radius: 7px; }
.evt-divider { height: 1px; background: rgba(76,201,240,0.12); margin: 10px 0 8px; }
.evt-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.evt-title { font-size: 12.5px; }
.evt-msg { font-size: 11.5px; }
.evt-time { font-size: 11px; }
.evt-empty { font-size: 12.5px; padding: 20px 0; }
/* 五阶段 stepper：浅色化修正（当前步白字→深红） + 字号 */
.emg-stepper { padding: 11px 18px; }
.emg-ico { width: 24px; height: 24px; font-size: 13px; }
.emg-name { font-size: 13px; }
.emg-step.cur .emg-name { color: #EF4444; font-weight: 700; }
.emg-reset { font-size: 13px; padding: 6px 14px; border-radius: 8px; }
/* 中央事件卡 */
.event-title { font-size: 24px; }
.event-loc { font-size: 19px; }
.event-desc { font-size: 13px; }
.event-kicker { font-size: 12px; letter-spacing: 2.5px; }
.event-btn { padding: 10px 24px; font-size: 15px; border-radius: 10px; }
.em-chip { font-size: 12px; padding: 4px 10px; }
.event-list li { font-size: 12.5px; }
/* 展开视图 */
.expanded-head { padding: 10px 14px; }
.back-btn { font-size: 13.5px; padding: 7px 13px; }
.expanded-floor-name { font-size: 20px; }
.expanded-sub { font-size: 12.5px; }
.floor-chips .floor-chip { font-size: 12.5px; }
.zoom-ctrl-btn { width: 34px; height: 34px; font-size: 17px; }
.zoom-ctrl-btn.fit { font-size: 12.5px; }
.zoom-pct { font-size: 13px; }
.canvas-hint { font-size: 12px; }
.floor-info-panel { padding: 13px; }
.fip-big { font-size: 28px; }
.fc-val { font-size: 20px; }
.fc-lbl { font-size: 12px; }
.fc-sub { font-size: 11px; color: #64748B; }
.fip-sec-title { font-size: 13px; }
.fip-mini { font-size: 12px; }
.fip-row { font-size: 13px; }
.fip-alert-title { font-size: 14px; }
.fip-warn-row .ok-chip { font-size: 11.5px; }

/* ══════════ 小视口/紧凑 rail 适配（三卡尽量同屏） ══════════ */
.rail-card { padding: 9px 12px; }
.rail-head { margin-bottom: 6px; }
.bldg-row { padding: 5px 8px; }
.pp-rows { gap: 5px; }
.pp-foot { margin-top: 8px; }
.em-btns { gap: 6px; }
.em-btn { padding: 7px 4px; }
.evt-divider { margin: 8px 0 6px; }
.evt-row { padding: 6px 8px; }
.evt-head { margin-bottom: 6px; }

/* ─── 楼栋卡片增强：悬浮反馈 ─── */
.building-card { transition: all 0.25s ease; cursor: pointer; }
.building-card:hover { transform: translateY(-2px); box-shadow: 0 4px 24px rgba(76,201,240,0.15); }

/* ─── 应急强闪动画（仅透明度/亮度/发光，容器绝对不位移不缩放） ───
   视觉语义硬规范：疏散指示灯 = 绿色强闪（箭头永远绿色）；应急照明灯 = 暖白强闪；
   红色强闪仅用于烟感/雷达等告警设备 */
@keyframes emergencyFlash {
  0%   { opacity: 1;   filter: brightness(1.8) drop-shadow(0 0 6px #FF3B30); }
  12%  { opacity: 0.95; filter: brightness(2.5) drop-shadow(0 0 12px #FF3B30); }
  25%  { opacity: 0.4; filter: brightness(0.9); }
  38%  { opacity: 1;   filter: brightness(2.2) drop-shadow(0 0 10px #FF3B30); }
  50%  { opacity: 0.6; filter: brightness(1.2); }
  62%  { opacity: 1;   filter: brightness(2.0) drop-shadow(0 0 9px #FF3B30); }
  75%  { opacity: 0.5; filter: brightness(1.0); }
  88%  { opacity: 1;   filter: brightness(1.7) drop-shadow(0 0 7px #FF3B30); }
  100% { opacity: 1;   filter: brightness(1.8) drop-shadow(0 0 6px #FF3B30); }
}
/* 疏散指示灯应急绿色强闪（箭头 + 灯板发光，颜色恒绿不变红） */
@keyframes evacGreenFlash {
  0%,100% { opacity: 1;    filter: drop-shadow(0 0 7px #39FF88) brightness(1.8); }
  25%     { opacity: 0.5;  filter: drop-shadow(0 0 2px #22C55E) brightness(1.0); }
  50%     { opacity: 1;    filter: drop-shadow(0 0 12px #39FF88) brightness(2.2); }
  75%     { opacity: 0.55; filter: drop-shadow(0 0 3px #22C55E) brightness(1.1); }
}
/* 应急照明灯暖白强闪（白光呼吸 + 强亮发光） */
@keyframes emWhiteFlash {
  0%,100% { opacity: 1;   filter: drop-shadow(0 0 9px rgba(255,247,220,0.95)) brightness(1.6); }
  50%     { opacity: 0.45; filter: drop-shadow(0 0 3px rgba(255,247,220,0.5)) brightness(0.9); }
}

/* 红色强闪仅保留给非灯具类告警设备（烟感/雷达等） */
.light-node.emergency-flash:not(.t-evacuation_light):not(.t-emergency_light) {
  animation: emergencyFlash 0.75s ease-in-out infinite;
}
.light-node.emergency-flash:not(.t-evacuation_light):not(.t-emergency_light) circle:first-child {
  fill: #FF3B30 !important;
  stroke: rgba(255,100,80,0.8) !important;
  stroke-width: 1.5px;
  animation: emergencyFlash 0.75s ease-in-out infinite;
}

/* 疏散指示灯应急：灯板绿光晕 + 箭头绿色强闪（fill 恒绿，禁止变红） */
.light-node.emergency-flash.t-evacuation_light rect {
  filter: drop-shadow(0 0 7px rgba(57,255,136,0.9)) brightness(1.3);
}
.light-node.emergency-flash.t-evacuation_light text {
  fill: #39FF88 !important;
  font-weight: 900;
  animation: evacGreenFlash 0.75s ease-in-out infinite;
}
/* 疏散指示灯常规状态：箭头轻微绿色光晕 */
.light-node.t-evacuation_light text {
  filter: drop-shadow(0 0 2.5px rgba(57,255,136,0.7));
}
.light-node.t-evacuation_light rect {
  filter: drop-shadow(0 0 2px rgba(34,197,94,0.35));
}

/* 应急照明灯应急：暖白强闪（白光，非红） */
.light-node.emergency-flash.t-emergency_light circle {
  fill: #FFF7E0 !important;
  animation: emWhiteFlash 0.7s ease-in-out infinite;
}
/* 应急照明灯常规状态：暖白微光晕（与绿色指示灯一眼区分） */
.light-node.t-emergency_light circle {
  filter: drop-shadow(0 0 3px rgba(255,247,220,0.55));
}

.light-node.emergency-flash.delay-1 { animation-delay: 0.05s; }
.light-node.emergency-flash.delay-2 { animation-delay: 0.15s; }
.light-node.emergency-flash.delay-3 { animation-delay: 0.28s; }
.light-node.emergency-flash.delay-4 { animation-delay: 0.42s; }
.light-node.emergency-flash.delay-5 { animation-delay: 0.55s; }

/* ════════════════════════════════════════════
   关键业务确认弹窗（深色 · 仅 3 个：发现火灾 / 是否启动应急预案 / 启动应急协同救援）
   ════════════════════════════════════════════ */
.biz-dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 2200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4, 8, 18, 0.72);
  backdrop-filter: blur(3px);
}
.biz-dialog {
  width: 400px;
  max-width: calc(100vw - 48px);
  background: linear-gradient(180deg, #16203a 0%, #101827 100%);
  border: 1px solid rgba(76, 201, 240, 0.3);
  border-radius: 14px;
  padding: 26px 24px 20px;
  text-align: center;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(76, 201, 240, 0.08);
}
.biz-dialog.danger { border-color: rgba(239, 68, 68, 0.45); box-shadow: 0 18px 60px rgba(0,0,0,0.6), 0 0 24px rgba(239, 68, 68, 0.18); }
.biz-dialog.warning { border-color: rgba(245, 158, 11, 0.45); box-shadow: 0 18px 60px rgba(0,0,0,0.6), 0 0 24px rgba(245, 158, 11, 0.15); }
.biz-dialog.rescue { border-color: rgba(76, 201, 240, 0.45); }
.biz-dialog-icon {
  width: 58px;
  height: 58px;
  margin: 0 auto 12px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
}
.biz-dialog-icon.fire { background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.4); animation: biz-icon-breathe 1.6s ease-in-out infinite; }
.biz-dialog-icon.warn { background: rgba(245, 158, 11, 0.14); border: 1px solid rgba(245, 158, 11, 0.4); animation: biz-icon-breathe 1.6s ease-in-out infinite; }
.biz-dialog-icon.resc { background: rgba(76, 201, 240, 0.14); border: 1px solid rgba(76, 201, 240, 0.4); }
@keyframes biz-icon-breathe {
  0%, 100% { opacity: 1; box-shadow: 0 0 10px rgba(239, 68, 68, 0.25); }
  50% { opacity: 0.72; box-shadow: 0 0 22px rgba(239, 68, 68, 0.5); }
}
.biz-dialog-title {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #f1f5f9;
}
.biz-dialog-sub {
  font-size: 12.5px;
  color: #7dd3fc;
  margin-top: 4px;
  letter-spacing: 1px;
}
.biz-dialog-body {
  margin: 16px 0 18px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(10, 14, 26, 0.55);
  border: 1px solid rgba(76, 201, 240, 0.12);
  text-align: left;
}
.biz-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  font-size: 13px;
  color: #94a3b8;
  padding: 5px 0;
  border-bottom: 1px dashed rgba(76, 201, 240, 0.1);
}
.biz-row:last-child { border-bottom: none; }
.biz-row b { font-weight: 600; color: #e2e8f0; text-align: right; }
.biz-row b.danger-text { color: #ff6b6b; }
.biz-row b.warning-text { color: #fbbf24; }
.biz-dialog-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}
.biz-btn {
  min-width: 128px;
  padding: 10px 18px;
  border-radius: 9px;
  border: 1px solid transparent;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1px;
  cursor: pointer;
  transition: filter 0.18s ease, background 0.18s ease, border-color 0.18s ease;
}
.biz-btn.danger { background: linear-gradient(180deg, #ff5b5b, #d33); color: #fff; border-color: rgba(255, 90, 90, 0.6); }
.biz-btn.danger:hover { filter: brightness(1.12); box-shadow: 0 0 14px rgba(239, 68, 68, 0.35); }
.biz-btn.primary { background: linear-gradient(180deg, #2f6bff, #1e4fd6); color: #fff; border-color: rgba(76, 201, 240, 0.5); }
.biz-btn.primary:hover { filter: brightness(1.12); box-shadow: 0 0 14px rgba(67, 97, 238, 0.4); }
.biz-btn.ghost { background: transparent; color: #9fb6d4; border-color: rgba(159, 182, 212, 0.4); }
.biz-btn.ghost:hover { background: rgba(159, 182, 212, 0.1); }
/* 弹窗进出场（透明度 + 轻微缩放，仅弹窗本体，不涉及设备容器） */
.biz-fade-enter-active { transition: opacity 0.25s ease; }
.biz-fade-leave-active { transition: opacity 0.18s ease; }
.biz-fade-enter-active .biz-dialog { animation: biz-pop-in 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
.biz-fade-enter-from, .biz-fade-leave-to { opacity: 0; }
@keyframes biz-pop-in {
  from { opacity: 0; transform: scale(0.94) translateY(10px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
</style>
