<template>
  <div class="device-view">
    <!-- Page Header -->
    <div class="page-header">
      <div class="header-bar"></div>
      <div class="header-text">
        <h2 class="title-spacing">智能设备管理</h2>
        <p class="header-sub">统一管理所有消防智能感知终端</p>
      </div>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar fire-card">
      <div class="filter-item">
        <svg class="filter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <el-input v-model="searchQuery" placeholder="搜索设备编号/名称" clearable style="width: 200px" @keyup.enter="handleSearch" />
      </div>
      <div class="filter-item">
        <svg class="filter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        <el-select v-model="typeFilter" placeholder="设备类型" clearable style="width: 150px">
          <el-option v-for="t in deviceTypes" :key="t" :label="t" :value="t" />
        </el-select>
      </div>
      <div class="filter-item">
        <svg class="filter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 21V7l9-4 9 4v14" />
          <path d="M9 21v-6h6v6" />
        </svg>
        <el-select v-model="buildingFilter" placeholder="所属楼栋" clearable style="width: 120px">
          <el-option v-for="b in ['1号楼','2号楼','3号楼','4号楼']" :key="b" :label="b" :value="b" />
        </el-select>
      </div>
      <div class="filter-item">
        <svg class="filter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4" />
        </svg>
        <el-select v-model="floorFilter" placeholder="全部楼层" clearable style="width: 100px">
          <el-option v-for="f in ['1F','2F','3F','4F','5F','6F']" :key="f" :label="f" :value="f" />
        </el-select>
      </div>
      <div class="filter-item">
        <svg class="filter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        <el-select v-model="statusFilter" placeholder="设备状态" clearable style="width: 120px">
          <el-option label="正常" value="normal" />
          <el-option label="异常" value="warning" />
          <el-option label="应急" value="emergency" />
          <el-option label="离线" value="fault" />
        </el-select>
      </div>
      <el-button type="primary" @click="handleSearch">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12" style="margin-right: 4px">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        查询
      </el-button>
      <el-button @click="handleReset">重置</el-button>
    </div>

    <!-- 统计指标行 -->
    <div class="stat-row">
      <div class="stat-card fire-card">
        <div class="stat-bar" style="background: var(--fire-green); box-shadow: 0 0 6px var(--fire-green);"></div>
        <div class="stat-card-body">
          <div class="stat-card-top">
            <span class="stat-card-label">在线</span>
            <svg class="stat-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10" />
              <polyline points="9 12 11 14 15 10" />
            </svg>
          </div>
          <div class="stat-card-value num-font glow-text-sm" style="color: var(--fire-green)">{{ onlineCount }}</div>
        </div>
      </div>
      <div class="stat-card fire-card">
        <div class="stat-bar" style="background: var(--fire-red); box-shadow: 0 0 6px var(--fire-red);"></div>
        <div class="stat-card-body">
          <div class="stat-card-top">
            <span class="stat-card-label">异常</span>
            <svg class="stat-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div class="stat-card-value num-font glow-text-sm" style="color: var(--fire-red)">{{ abnormalCount }}</div>
        </div>
      </div>
      <div class="stat-card fire-card">
        <div class="stat-bar" style="background: #475569; box-shadow: 0 0 6px rgba(71,85,105,0.5);"></div>
        <div class="stat-card-body">
          <div class="stat-card-top">
            <span class="stat-card-label">离线</span>
            <svg class="stat-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
          </div>
          <div class="stat-card-value num-font" style="color: var(--text-tertiary)">{{ offlineCount }}</div>
        </div>
      </div>
      <div class="stat-card fire-card">
        <div class="stat-bar" style="background: var(--fire-cyan); box-shadow: 0 0 6px var(--fire-cyan);"></div>
        <div class="stat-card-body">
          <div class="stat-card-top">
            <span class="stat-card-label">巡检中</span>
            <svg class="stat-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 12a9 9 0 11-6.219-8.56" />
              <polyline points="21 4 21 10 15 10" />
            </svg>
          </div>
          <div class="stat-card-value num-font glow-text-sm" style="color: var(--fire-cyan)">{{ inspectingCount }}</div>
        </div>
      </div>
    </div>

    <!-- 设备列表 -->
    <div class="device-table fire-card">
      <div class="panel-title-bar">
        <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="4" width="18" height="16" rx="1" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="4" x2="9" y2="20" />
        </svg>
        <span class="panel-title title-spacing-sm">设备列表</span>
        <span class="panel-count num-font">{{ filteredData.length }}</span>
      </div>

      <!-- 表头 -->
      <div class="table-head">
        <div class="th th-id">设备编号</div>
        <div class="th th-name">设备名称</div>
        <div class="th th-type">类型</div>
        <div class="th th-loc">楼栋/楼层</div>
        <div class="th th-battery">电量</div>
        <div class="th th-status">状态</div>
        <div class="th th-comm">通信</div>
        <div class="th th-report">最后上报</div>
        <div class="th th-action">操作</div>
      </div>

      <!-- 表体 -->
      <div class="table-body">
        <div
          v-for="row in pagedData"
          :key="row.id"
          class="table-row"
          :class="rowClass(row.status)"
          @click="handleRowClick(row)"
        >
          <div class="td td-id">
            <span class="num-font">{{ row.id }}</span>
          </div>
          <div class="td td-name">{{ row.name }}</div>
          <div class="td td-type">
            <span class="type-tag">{{ row.type }}</span>
          </div>
          <div class="td td-loc">
            <span class="loc-building">{{ row.building }}</span>
            <span class="loc-sep">/</span>
            <span class="loc-floor num-font">{{ row.floor }}</span>
          </div>
          <div class="td td-battery">
            <div class="battery-wrap">
              <svg class="battery-icon" viewBox="0 0 24 14" fill="none" stroke="currentColor" stroke-width="1">
                <rect x="1" y="2" width="18" height="10" rx="1" />
                <rect x="20" y="5" width="2" height="4" rx="0.5" fill="currentColor" stroke="none" />
                <rect x="2.5" y="3.5" :width="Math.max(0, (row.battery / 100) * 15)" height="7" :fill="batteryColor(row.battery)" stroke="none" rx="0.5" />
              </svg>
              <span class="battery-pct num-font" :style="{ color: batteryColor(row.battery) }">{{ row.battery }}%</span>
            </div>
          </div>
          <div class="td td-status">
            <span class="status-tag" :class="statusTagClass(row.status)">
              {{ statusLabel(row.status) }}
            </span>
          </div>
          <div class="td td-comm">
            <span :class="row.communication === 'online' ? 'comm-online' : 'comm-offline'">
              <span class="comm-dot"></span>
              {{ row.communication === 'online' ? '在线' : '离线' }}
            </span>
          </div>
          <div class="td td-report">{{ row.lastReport }}</div>
          <div class="td td-action" @click.stop>
            <button class="row-btn" @click="handleRowClick(row)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              详情
            </button>
          </div>
        </div>
      </div>

      <!-- 分页 -->
      <div class="pagination-bar">
        <el-pagination
          v-model:current-page="currentPage"
          :page-size="pageSize"
          :total="filteredData.length"
          layout="total, prev, pager, next"
          background
        />
      </div>
    </div>

    <!-- 设备详情弹窗 -->
    <el-dialog v-model="detailVisible" title="消防设备详情" width="720px" :close-on-click-modal="true">
      <template v-if="selectedDevice">
        <!-- 基本信息 -->
        <div class="detail-section">
          <div class="detail-section-title">
            <div class="section-bar"></div>
            <span class="title-spacing-sm">基本信息</span>
          </div>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">设备名称</span>
              <span class="detail-value">{{ selectedDevice.name }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">设备编号</span>
              <span class="detail-value num-font">{{ selectedDevice.id }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">设备类型</span>
              <span class="detail-value">{{ selectedDevice.type }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">所属建筑</span>
              <span class="detail-value">{{ selectedDevice.building }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">所在楼层</span>
              <span class="detail-value num-font">{{ selectedDevice.floor }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">安装位置</span>
              <span class="detail-value">{{ selectedDevice.installPosition }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">当前状态</span>
              <span class="detail-value">
                <span class="status-tag" :class="statusTagClass(selectedDevice.status)">
                  {{ statusLabel(selectedDevice.status) }}
                </span>
              </span>
            </div>
            <div class="detail-item">
              <span class="detail-label">通信状态</span>
              <span class="detail-value" :class="selectedDevice.communication === 'online' ? 'text-green' : 'text-tertiary-c'">
                {{ selectedDevice.communication === 'online' ? '在线' : '离线' }}
              </span>
            </div>
            <div class="detail-item">
              <span class="detail-label">电池电量</span>
              <span class="detail-value num-font">{{ selectedDevice.battery }}%</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">环境温度</span>
              <span class="detail-value num-font">{{ selectedDevice.temperature }}℃</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">工作时长</span>
              <span class="detail-value num-font">{{ selectedDevice.workHours }} h</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">最后上报</span>
              <span class="detail-value">{{ selectedDevice.lastReport }}</span>
            </div>
          </div>
        </div>

        <!-- 感知能力 -->
        <div v-if="selectedDevice.type === 'radar_sensor'" class="detail-section">
          <div class="detail-section-title">
            <div class="section-bar"></div>
            <span class="title-spacing-sm">感知能力</span>
          </div>
          <div class="capability-grid">
            <div class="cap-item">
              <span class="cap-label">毫米波雷达</span>
              <span class="cap-value text-green">在线</span>
            </div>
            <div class="cap-item">
              <span class="cap-label">运动检测</span>
              <span class="cap-value text-green">开启</span>
            </div>
            <div class="cap-item">
              <span class="cap-label">微动检测</span>
              <span class="cap-value text-green">开启</span>
            </div>
            <div class="cap-item">
              <span class="cap-label">当前目标</span>
              <span class="cap-value num-font text-cyan">3 人</span>
            </div>
          </div>
        </div>

        <!-- 照明能力 -->
        <div v-if="['emergency_light', 'evacuation_light'].includes(selectedDevice.type)" class="detail-section">
          <div class="detail-section-title">
            <div class="section-bar"></div>
            <span class="title-spacing-sm">照明能力</span>
          </div>
          <div class="capability-grid">
            <div class="cap-item">
              <span class="cap-label">当前模式</span>
              <span class="cap-value text-cyan">感应增强</span>
            </div>
            <div class="cap-item">
              <span class="cap-label">亮度</span>
              <span class="cap-value num-font text-cyan">85%</span>
            </div>
          </div>
        </div>

        <!-- 通信能力 -->
        <div v-if="selectedDevice.communication === 'online'" class="detail-section">
          <div class="detail-section-title">
            <div class="section-bar"></div>
            <span class="title-spacing-sm">通信能力</span>
          </div>
          <div class="capability-grid">
            <div class="cap-item">
              <span class="cap-label">WiFi</span>
              <span class="cap-value text-green">在线</span>
            </div>
            <div class="cap-item">
              <span class="cap-label">MQTT</span>
              <span class="cap-value text-green">在线</span>
            </div>
          </div>
        </div>

        <!-- 历史曲线 -->
        <div class="detail-section">
          <div class="detail-section-title">
            <div class="section-bar"></div>
            <span class="title-spacing-sm">电量变化趋势</span>
          </div>
          <div class="chart-area">
            <StatusChart type="battery" :data="historyData" />
          </div>
        </div>
        <div class="detail-section">
          <div class="detail-section-title">
            <div class="section-bar"></div>
            <span class="title-spacing-sm">温度变化趋势</span>
          </div>
          <div class="chart-area">
            <StatusChart type="temp" :data="historyData" />
          </div>
        </div>

        <!-- 远程配置 -->
        <div class="detail-section">
          <div class="detail-section-title">
            <div class="section-bar"></div>
            <span class="title-spacing-sm">远程配置</span>
          </div>
          <div class="config-area">
            <div class="config-group">
              <div class="config-group-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="12" r="6" />
                  <circle cx="12" cy="12" r="2" />
                </svg>
                <span class="config-group-title">雷达参数</span>
              </div>
              <div class="config-row">
                <span class="config-label">检测距离</span>
                <el-slider v-model="deviceConfig.radarDetectionRange" :min="0" :max="10" :step="0.5" style="flex:1" />
                <span class="config-value num-font">{{ deviceConfig.radarDetectionRange }}m</span>
              </div>
              <div class="config-row">
                <span class="config-label">灵敏度</span>
                <el-slider v-model="deviceConfig.radarSensitivity" :min="1" :max="5" :step="1" style="flex:1" />
                <span class="config-value num-font">{{ deviceConfig.radarSensitivity }}级</span>
              </div>
            </div>
            <div class="config-group">
              <div class="config-group-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11">
                  <path d="M12 2v8M12 14v8M4.93 4.93l5.66 5.66M13.41 13.41l5.66 5.66M2 12h8M14 12h8M4.93 19.07l5.66-5.66M13.41 10.59l5.66-5.66" />
                </svg>
                <span class="config-group-title">照明参数</span>
              </div>
              <div class="config-row">
                <span class="config-label">默认亮度</span>
                <el-slider v-model="deviceConfig.defaultBrightness" :min="0" :max="100" :step="5" style="flex:1" />
                <span class="config-value num-font">{{ deviceConfig.defaultBrightness }}%</span>
              </div>
              <div class="config-row">
                <span class="config-label">感应亮度</span>
                <el-slider v-model="deviceConfig.inductionBrightness" :min="0" :max="100" :step="5" style="flex:1" />
                <span class="config-value num-font">{{ deviceConfig.inductionBrightness }}%</span>
              </div>
              <div class="config-row">
                <span class="config-label">延时时间</span>
                <el-slider v-model="deviceConfig.delayTime" :min="5" :max="120" :step="5" style="flex:1" />
                <span class="config-value num-font">{{ deviceConfig.delayTime }}s</span>
              </div>
            </div>
            <button class="config-push-btn" @click="handlePushConfig">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              下发配置
            </button>
          </div>
        </div>
      </template>

      <template #footer>
        <div class="dialog-footer">
          <button class="footer-btn" @click="handleSelfCheck">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
              <path d="M21 12a9 9 0 11-6.219-8.56" />
              <polyline points="21 4 21 10 15 10" />
            </svg>
            远程自检
          </button>
          <button class="footer-btn footer-btn-warn" @click="handleSimulateAbnormal">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            模拟异常
          </button>
          <button class="footer-btn" @click="handleReset">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
            </svg>
            设备复位
          </button>
          <button class="footer-btn footer-btn-primary" @click="detailVisible = false">关闭</button>
        </div>
      </template>
    </el-dialog>

    <!-- 底部交互流程标注 -->
    <div class="flow-bar fire-card">
      <div class="flow-step">
        <span class="flow-num num-font">01</span>
        <span class="flow-text">设备筛选</span>
      </div>
      <div class="flow-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="14" height="14">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </div>
      <div class="flow-step">
        <span class="flow-num num-font">02</span>
        <span class="flow-text">列表查看</span>
      </div>
      <div class="flow-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="14" height="14">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </div>
      <div class="flow-step">
        <span class="flow-num num-font">03</span>
        <span class="flow-text">详情查看</span>
      </div>
      <div class="flow-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="14" height="14">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </div>
      <div class="flow-step">
        <span class="flow-num num-font">04</span>
        <span class="flow-text">远程配置</span>
      </div>
      <div class="flow-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="14" height="14">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </div>
      <div class="flow-step">
        <span class="flow-num num-font">05</span>
        <span class="flow-text">参数下发</span>
      </div>
      <div class="flow-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="14" height="14">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </div>
      <div class="flow-step">
        <span class="flow-num num-font">06</span>
        <span class="flow-text">状态更新</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useFireStore } from '../stores/fireStore'
import { dataSource } from '../api'
import { deviceTypes, nodeTypes } from '../mock/devices'
import { generateDeviceHistory } from '../mock/statistics'
import StatusChart from '../components/StatusChart.vue'
// P1.7.3-B3-03：设备筛选口径统一到 canonical（buildingId / floorId），旧别名不再作为第二套筛选依据
import {
  buildingIdOf, floorIdOf, BUILDING_NAME_TO_ID,
} from '../../shared/person/personRuntime.js'

const store = useFireStore()

const searchQuery = ref('')
const typeFilter = ref('')
const buildingFilter = ref('')
const floorFilter = ref('')
const statusFilter = ref('')
const currentPage = ref(1)
const pageSize = 12
const detailVisible = ref(false)
const selectedDevice = ref(null)
const historyData = ref({ labels: [], batteryData: [], tempData: [] })

// 远程配置
const deviceConfig = ref({
  radarDetectionRange: 8,
  radarSensitivity: 3,
  defaultBrightness: 30,
  inductionBrightness: 85,
  delayTime: 30,
})

const filteredData = computed(() => {
  let result = store.devices
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(
      (d) => d.id.toLowerCase().includes(q) || d.name.toLowerCase().includes(q)
    )
  }
  if (typeFilter.value) result = result.filter((d) => nodeTypes[d.type]?.label === typeFilter.value)
  // P1.7.3-B3-03：中文楼栋名先反查成 canonical id，再与设备的 buildingId 比对（别名冲突时以 canonical 为准）
  const wantBid = buildingFilter.value ? (BUILDING_NAME_TO_ID[buildingFilter.value] || '') : ''
  if (wantBid) result = result.filter((d) => buildingIdOf(d) === wantBid)
  const wantFid = floorFilter.value ? floorIdOf({ floorId: floorFilter.value }) : ''
  if (wantFid) result = result.filter((d) => floorIdOf(d) === wantFid)
  if (statusFilter.value) result = result.filter((d) => d.status === statusFilter.value)
  return result
})

const pagedData = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  return filteredData.value.slice(start, start + pageSize)
})

// 统计卡片与设备列表共用同一批筛选结果（含楼栋/楼层真实层级过滤）
const onlineCount = computed(() => filteredData.value.filter((d) => d.status === 'normal').length)
const abnormalCount = computed(
  () => filteredData.value.filter((d) => d.status === 'warning' || d.status === 'emergency' || d.status === 'abnormal').length
)
const offlineCount = computed(() => filteredData.value.filter((d) => d.status === 'fault').length)
const inspectingCount = computed(() =>
  filteredData.value.some((d) => d.communication === 'online' && d.status === 'normal') ? 2 : 0
)

function batteryColor(level) {
  if (level < 20) return '#EF4444'
  if (level < 50) return '#F59E0B'
  return '#22C55E'
}

function handleSearch() {
  currentPage.value = 1
}

function handleReset() {
  searchQuery.value = ''
  typeFilter.value = ''
  buildingFilter.value = ''
  floorFilter.value = ''
  statusFilter.value = ''
  currentPage.value = 1
  if (selectedDevice.value) {
    store.updateDeviceStatus(selectedDevice.value.id, 'normal')
    store.addNotification({
      title: '设备复位成功',
      message: `${selectedDevice.value.name} 已恢复正常运行`,
      level: 'info',
      time: new Date().toLocaleTimeString('zh-CN'),
    })
  }
}

function handleRowClick(row) {
  selectedDevice.value = row
  historyData.value = generateDeviceHistory(row.id)
  detailVisible.value = true
}

// 状态归一：真实数据使用 normal/warning/emergency/fault，兼容旧词 abnormal/offline
function normalizeStatus(raw) {
  if (raw === 'warning' || raw === 'emergency') return 'abnormal'
  if (raw === 'fault') return 'offline'
  return raw
}

function rowClass(raw) {
  const s = normalizeStatus(raw)
  return {
    'row-abnormal': s === 'abnormal',
    'row-offline': s === 'offline',
  }
}

function statusTagClass(raw) {
  const s = normalizeStatus(raw)
  if (s === 'normal') return 'green'
  if (s === 'abnormal') return 'red'
  return 'cyan'
}

function statusLabel(status) {
  const s = normalizeStatus(status)
  const labels = { normal: '正常', abnormal: '异常', offline: '离线' }
  return labels[s] || status
}

function statusTagType(status) {
  const types = { normal: 'success', abnormal: 'danger', offline: 'info' }
  return types[normalizeStatus(status)] || 'info'
}

function handleSelfCheck() {
  store.addNotification({
    title: '自检指令已下发',
    message: `${selectedDevice.value.name} 远程自检已启动`,
    level: 'info',
    time: new Date().toLocaleTimeString('zh-CN'),
  })
}

function handleSimulateAbnormal() {
  // P1.7.3-B1：demo 模式下设备状态只能来自后端快照，页面不得反向写入
  if (dataSource.isDemo) {
    console.warn('[DeviceView] demo 模式禁止本地修改设备状态')
    return
  }
  store.updateDeviceStatus(selectedDevice.value.id, 'warning')
  selectedDevice.value.status = 'warning'
  store.addNotification({
    title: '设备异常模拟',
    message: `${selectedDevice.value.name} 已设置为异常状态`,
    level: 'warning',
    time: new Date().toLocaleTimeString('zh-CN'),
  })
}

function handlePushConfig() {
  const config = {
    deviceId: selectedDevice.value.id,
    radarDetectionRange: deviceConfig.value.radarDetectionRange,
    radarSensitivity: deviceConfig.value.radarSensitivity,
    defaultBrightness: deviceConfig.value.defaultBrightness,
    inductionBrightness: deviceConfig.value.inductionBrightness,
    delayTime: deviceConfig.value.delayTime,
  }
  store.updateDeviceConfig(config)
  store.addNotification({
    title: '配置下发成功',
    message: `${selectedDevice.value.name} 参数配置已下发：检测距离${config.radarDetectionRange}m / 灵敏度${config.radarSensitivity}级 / 默认亮度${config.defaultBrightness}%`,
    level: 'success',
    time: new Date().toLocaleTimeString('zh-CN'),
  })
}
</script>

<style scoped>
/* ========== Page Header ========== */
.page-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 4px 0;
}

.header-bar {
  width: 2px;
  height: 28px;
  background: var(--fire-blue);

  border-radius: 1px;
  flex-shrink: 0;
}

.header-text h2 {
  font-size: 18px;
  color: var(--text-primary);
  font-weight: 600;
  line-height: 1.2;
}

.header-sub {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

/* ========== Layout ========== */
.device-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 10px;
}

/* ========== Filter Bar ========== */
.filter-bar {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  align-items: center;
  flex-shrink: 0;
}

.filter-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.filter-icon {
  width: 13px;
  height: 13px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

/* ========== Stat Row ========== */
.stat-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  flex-shrink: 0;
}

.stat-card {
  display: flex;
  align-items: stretch;
  padding: 0;
  height: 56px;
}

.stat-bar {
  width: 2px;
  border-radius: 1px 0 0 1px;
  flex-shrink: 0;
}

.stat-card-body {
  flex: 1;
  padding: 8px 14px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.stat-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.stat-card-label {
  font-size: 11px;
  color: var(--text-tertiary);
  letter-spacing: 1px;
}

.stat-card-icon {
  width: 13px;
  height: 13px;
  opacity: 0.4;
}

.stat-card-value {
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
}

/* ========== Panel Title Bar ========== */
.panel-title-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--fire-border);
  flex-shrink: 0;
}

.panel-icon {
  width: 14px;
  height: 14px;
  color: var(--fire-cyan);
  flex-shrink: 0;
}

.panel-title {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
  flex: 1;
}

.panel-count {
  font-size: 12px;
  color: var(--text-tertiary);
  background: rgba(76, 201, 240, 0.06);
  padding: 1px 8px;
  border-radius: 2px;
}

/* ========== Device Table ========== */
.device-table {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.table-head {
  display: grid;
  grid-template-columns: 80px 1fr 100px 110px 110px 80px 80px 140px 70px;
  gap: 0;
  padding: 0 14px;
  border-bottom: 1px solid var(--fire-border);
  flex-shrink: 0;
  height: 34px;
  align-items: center;
}

.th {
  font-size: 11px;
  color: var(--text-tertiary);
  letter-spacing: 1px;
  font-weight: 500;
  padding: 0 4px;
}

.table-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 14px;
}

.table-row {
  display: grid;
  grid-template-columns: 80px 1fr 100px 110px 110px 80px 80px 140px 70px;
  gap: 0;
  align-items: center;
  height: 40px;
  border-bottom: 1px solid rgba(76, 201, 240, 0.04);
  cursor: pointer;
  transition: all 0.2s;
  padding: 0;
  position: relative;
}

.table-row:hover {
  background: rgba(76, 201, 240, 0.04);
  transform: translateX(1px);
}

.table-row.row-abnormal {
  background: rgba(239, 68, 68, 0.03);
}

.table-row.row-abnormal:hover {
  background: rgba(239, 68, 68, 0.06);
}

.table-row.row-offline {
  opacity: 0.55;
}

.td {
  padding: 0 4px;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.td-id {
  color: var(--fire-cyan);
  font-weight: 600;
}

.td-name {
  color: var(--text-primary);
}

.type-tag {
  font-size: 10px;
  color: var(--text-secondary);
  padding: 1px 6px;
  background: rgba(76, 201, 240, 0.06);
  border: 1px solid var(--fire-border);
  border-radius: 2px;
  white-space: nowrap;
}

.loc-building {
  color: var(--text-secondary);
}

.loc-sep {
  color: var(--text-tertiary);
  margin: 0 2px;
}

.loc-floor {
  color: var(--text-secondary);
}

/* Battery */
.battery-wrap {
  display: flex;
  align-items: center;
  gap: 5px;
}

.battery-icon {
  width: 22px;
  height: 13px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.battery-pct {
  font-size: 11px;
  font-weight: 600;
}

/* Communication */
.comm-online {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--fire-green);
  font-size: 11px;
}

.comm-offline {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-tertiary);
  font-size: 11px;
}

.comm-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 4px currentColor;
}

.td-report {
  color: var(--text-tertiary);
  font-size: 11px;
}

.row-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 4px 8px;
  border-radius: 2px;
  border: 1px solid var(--fire-border);
  background: rgba(76, 201, 240, 0.04);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}

.row-btn:hover {
  border-color: var(--fire-cyan);
  color: var(--fire-cyan);
  background: rgba(76, 201, 240, 0.08);
}

/* ========== Pagination ========== */
.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding: 10px 14px;
  border-top: 1px solid var(--fire-border);
  flex-shrink: 0;
}

/* ========== Dialog ========== */
.detail-section {
  margin-bottom: 16px;
}

.detail-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.section-bar {
  width: 2px;
  height: 14px;
  background: var(--fire-cyan);
  box-shadow: 0 0 4px var(--fire-cyan);
  border-radius: 1px;
}

.detail-section-title span {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 600;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.detail-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 12px;
  background: rgba(76, 201, 240, 0.03);
  border: 1px solid var(--fire-border);
  border-radius: 3px;
}

.detail-label {
  font-size: 10px;
  color: var(--text-tertiary);
  letter-spacing: 0.5px;
}

.detail-value {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
}

/* Capability */
.capability-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.cap-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(76, 201, 240, 0.03);
  border: 1px solid var(--fire-border);
  border-radius: 3px;
}

.cap-label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.cap-value {
  font-size: 12px;
  font-weight: 600;
}

/* Chart */
.chart-area {
  height: 160px;
  background: rgba(76, 201, 240, 0.02);
  border: 1px solid var(--fire-border);
  border-radius: 3px;
  padding: 8px;
}

/* Config */
.config-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.config-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: rgba(76, 201, 240, 0.03);
  border: 1px solid var(--fire-border);
  border-radius: 3px;
}

.config-group-header {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-tertiary);
}

.config-group-title {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 600;
}

.config-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.config-label {
  font-size: 12px;
  color: var(--text-tertiary);
  width: 60px;
  flex-shrink: 0;
}

.config-value {
  font-size: 12px;
  color: var(--fire-cyan);
  width: 45px;
  text-align: right;
  flex-shrink: 0;
  font-weight: 600;
}

.config-push-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 3px;
  border: 1px solid rgba(76, 201, 240, 0.3);
  background: linear-gradient(135deg, rgba(76, 201, 240, 0.12), rgba(76, 201, 240, 0.06));
  color: var(--fire-cyan);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
  align-self: flex-start;
}

.config-push-btn:hover {
  background: linear-gradient(135deg, rgba(76, 201, 240, 0.2), rgba(76, 201, 240, 0.1));
  box-shadow: 0 2px 8px rgba(76, 201, 240, 0.12);
}

/* Dialog Footer */
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.footer-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 14px;
  border-radius: 3px;
  border: 1px solid var(--fire-border);
  background: rgba(76, 201, 240, 0.04);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.footer-btn:hover {
  border-color: var(--fire-cyan);
  color: var(--fire-cyan);
}

.footer-btn-warn:hover {
  border-color: var(--fire-orange);
  color: var(--fire-orange);
}

.footer-btn-primary {
  border-color: rgba(76, 201, 240, 0.3);
  background: linear-gradient(135deg, rgba(76, 201, 240, 0.15), rgba(76, 201, 240, 0.08));
  color: var(--fire-cyan);
}

.footer-btn-primary:hover {
  background: linear-gradient(135deg, rgba(76, 201, 240, 0.25), rgba(76, 201, 240, 0.12));
  box-shadow: 0 2px 8px rgba(76, 201, 240, 0.12);
}

/* ========== Flow Bar ========== */
.flow-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  flex-shrink: 0;
}

.flow-step {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  background: rgba(76, 201, 240, 0.04);
  border: 1px solid var(--fire-border);
  border-radius: 2px;
}

.flow-num {
  font-size: 11px;
  color: var(--fire-cyan);
  font-weight: 700;
}

.flow-text {
  font-size: 11px;
  color: var(--text-secondary);
  letter-spacing: 1px;
}

.flow-arrow {
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  opacity: 0.5;
}

/* ========== Text Colors ========== */
.text-orange { color: var(--fire-orange); }
.text-green { color: var(--fire-green); }
.text-red { color: var(--fire-red); }
.text-cyan { color: var(--fire-cyan); }
.text-tertiary-c { color: var(--text-tertiary); }
</style>
