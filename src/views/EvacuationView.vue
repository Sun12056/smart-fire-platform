<template>
  <div class="evacuation-view">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="header-bar"></div>
      <div class="header-text">
        <h2 class="title-spacing">智能疏散引导</h2>
        <p class="header-sub">动态管控疏散方向，避免火灾后静态指示引向危险区</p>
      </div>
    </div>

    <!-- 主体两栏 -->
    <div class="main-content">
      <!-- 左侧（大）：疏散控制核心 -->
      <div class="left-panel fire-card">
        <!-- 楼层/设备选择区 -->
        <div class="filter-section">
          <div class="filter-group">
            <div class="filter-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/></svg>
              <el-select v-model="evacStore.currentFloor" @change="handleFloorChange" size="small" style="width: 90px">
                <el-option v-for="f in evacStore.floorOpts" :key="f" :label="f" :value="f" />
              </el-select>
            </div>
            <div class="filter-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01"/></svg>
              <el-select v-model="evacStore.currentDeviceId" @change="handleDeviceChange" size="small" style="width: 180px">
                <el-option
                  v-for="d in evacStore.currentFloorDevices"
                  :key="d.id"
                  :label="d.name"
                  :value="d.id"
                />
              </el-select>
            </div>
          </div>
          <div class="filter-info" v-if="evacStore.currentDevice">
            <span class="info-tag">
              <span class="tag-label">编号</span>
              <span class="tag-value num-font">{{ evacStore.currentDevice.id }}</span>
            </span>
            <span class="info-tag">
              <span class="tag-label">控制</span>
              <span class="tag-value text-cyan">{{ evacStore.currentDevice.controllable ? '可远程' : '本地' }}</span>
            </span>
            <span class="info-tag">
              <span class="tag-label">状态</span>
              <span class="tag-value" :class="deviceStatusClass">{{ deviceStatusLabel }}</span>
            </span>
            <span class="info-tag">
              <span class="tag-label">人员</span>
              <span class="tag-value num-font text-cyan">{{ evacStore.evacFloorPersons }} 人</span>
            </span>
            <span class="module-status-tag" :class="statusClass">
              <span class="status-dot" :class="statusClass"></span>
              {{ evacStore.statusLabel }}
            </span>
          </div>
        </div>

        <!-- 核心控制区 -->
        <div class="core-section">
          <!-- 方向控制区 -->
          <div class="direction-control">
            <div class="section-label">当前指示方向</div>

            <!-- 大方向箭头 -->
            <div class="arrow-display" :class="statusClass">
              <div class="arrow-rings" :class="statusClass">
                <div class="ring ring-1"></div>
                <div class="ring ring-2"></div>
              </div>
              <div class="arrow-wrapper" :style="{ transform: `rotate(${currentAngle}deg)` }">
                <svg width="100" height="100" viewBox="0 0 120 120" class="arrow-svg">
                  <defs>
                    <linearGradient id="arrow-grad-normal" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stop-color="#22C55E"/>
                      <stop offset="100%" stop-color="#39FF88"/>
                    </linearGradient>
                    <linearGradient id="arrow-grad-emergency" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stop-color="#2EFF96"/>
                      <stop offset="100%" stop-color="#39FF88"/>
                    </linearGradient>
                    <filter id="arrow-glow-strong">
                      <feGaussianBlur stdDeviation="4" result="blur"/>
                      <feMerge>
                        <feMergeNode in="blur"/>
                        <feMergeNode in="SourceGraphic"/>
                      </feMerge>
                    </filter>
                  </defs>
                  <g filter="url(#arrow-glow-strong)">
                    <path d="M 15 50 L 75 50 L 75 35 L 105 60 L 75 85 L 75 70 L 15 70 Z"
                      :fill="evacStore.fireSimulation ? 'url(#arrow-grad-emergency)' : 'url(#arrow-grad-normal)'"
                      opacity="0.92"/>
                  </g>
                </svg>
              </div>
            </div>

            <!-- 方向标签 -->
            <div class="direction-label">
              <span class="dir-text num-font" :class="statusClass">{{ evacStore.currentDirectionLabel }}</span>
            </div>

            <!-- 设备状态 -->
            <div class="device-status-row">
              <span class="status-tag" :class="deviceStatusClass">{{ deviceStatusLabel }}</span>
              <span class="status-tag" :class="evacStore.currentDevice?.controllable ? 'cyan' : ''">{{ evacStore.currentDevice?.controllable ? '远程可控' : '仅本地控制' }}</span>
            </div>

            <!-- 方向选择（左 / 右） -->
            <div class="direction-pad-wrapper">
              <div class="pad-label">选择疏散方向</div>
              <div class="direction-pad">
                <button
                  class="pad-btn left"
                  :class="{ active: evacStore.currentDevice?.direction === 'left', disabled: evacStore.switching }"
                  @click="selectDirection('left')"
                  title="向左"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 5 5 12 12 19"/></svg>
                  <span>向左</span>
                </button>
                <button
                  class="pad-btn right"
                  :class="{ active: evacStore.currentDevice?.direction === 'right', disabled: evacStore.switching }"
                  @click="selectDirection('right')"
                  title="向右"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                  <span>向右</span>
                </button>
              </div>
            </div>

            <!-- 切换方向按钮 -->
            <button
              class="switch-btn"
              :class="{ switching: evacStore.switching, success: evacStore.switchResult === 'success' }"
              @click="handleSwitchClick"
              :disabled="evacStore.switching"
            >
              <span v-if="evacStore.switching" class="btn-loading">
                <span class="spinner"></span>
                正在下发指令
              </span>
              <span v-else-if="evacStore.switchResult === 'success'" class="btn-success">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                方向切换成功
              </span>
              <span v-else class="btn-normal">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 2v6h-6"/>
                  <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
                  <path d="M3 22v-6h6"/>
                  <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
                </svg>
                切换指示方向
              </span>
            </button>

            <!-- 模拟火源按钮 -->
            <button
              class="fire-sim-btn"
              @click="handleSimulateFire"
              :disabled="evacStore.fireSimulation"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
              </svg>
              {{ evacStore.fireSimulation ? '火源已模拟' : '模拟火源' }}
            </button>

            <!-- 风险提示 -->
            <transition name="fade">
              <div v-if="evacStore.fireSimulation && evacStore.currentDevice?.risk" class="risk-warning">
                <div class="risk-header">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  <span class="risk-title">当前疏散风险</span>
                </div>
                <div class="risk-body">
                  <p class="risk-desc">{{ evacStore.fireLocation }}存在火源风险</p>
                  <div class="risk-suggest">
                    <span class="suggest-label">系统建议</span>
                    <span class="suggest-content">
                      将 {{ evacStore.currentDevice.name }} 由
                      <strong class="dir-old">{{ evacStore.currentDirectionLabel }}</strong>
                      调整为
                      <strong class="dir-new">{{ evacStore.recommendedDirectionLabel }}</strong>
                    </span>
                  </div>
                  <button class="suggest-btn" @click="handleSwitchClick" :disabled="evacStore.switching">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    建议调整
                  </button>
                </div>
              </div>
            </transition>
          </div>

          <!-- 路线对比区 -->
          <div class="route-section">
            <!-- 路线标题 -->
            <div class="route-header">
              <div class="route-title-area">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 11l3 3L22 4"/>
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                </svg>
                <h4 class="title-spacing-sm">疏散路线动态调整</h4>
              </div>
              <div class="mode-tags">
                <span class="mode-tag" :class="{ active: !evacStore.fireSimulation }">常规模式</span>
                <span class="mode-tag emergency" :class="{ active: evacStore.fireSimulation }">应急模式</span>
              </div>
            </div>

            <!-- SVG 路线图 -->
            <div class="route-svg-container">
              <svg viewBox="0 0 400 260" class="route-svg">
                <defs>
                  <linearGradient id="safe-route-grad" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stop-color="#22C55E" stop-opacity="0.8"/>
                    <stop offset="100%" stop-color="#4CC9F0" stop-opacity="0.8"/>
                  </linearGradient>
                  <linearGradient id="danger-route-grad" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stop-color="#EF4444" stop-opacity="0.8"/>
                    <stop offset="100%" stop-color="#F59E0B" stop-opacity="0.8"/>
                  </linearGradient>
                  <filter id="route-glow">
                    <feGaussianBlur stdDeviation="2" result="blur"/>
                    <feMerge>
                      <feMergeNode in="blur"/>
                      <feMergeNode in="SourceGraphic"/>
                    </feMerge>
                  </filter>
                </defs>

                <!-- 网格背景 -->
                <rect width="400" height="260" fill="#0D1526"/>

                <!-- 网格线 -->
                <g opacity="0.08">
                  <line x1="0" y1="65" x2="400" y2="65" stroke="#4CC9F0" stroke-width="0.5"/>
                  <line x1="0" y1="130" x2="400" y2="130" stroke="#4CC9F0" stroke-width="0.5"/>
                  <line x1="0" y1="195" x2="400" y2="195" stroke="#4CC9F0" stroke-width="0.5"/>
                  <line x1="100" y1="0" x2="100" y2="260" stroke="#4CC9F0" stroke-width="0.5"/>
                  <line x1="200" y1="0" x2="200" y2="260" stroke="#4CC9F0" stroke-width="0.5"/>
                  <line x1="300" y1="0" x2="300" y2="260" stroke="#4CC9F0" stroke-width="0.5"/>
                </g>

                <!-- 左侧通道 -->
                <g class="route-left" :class="{ danger: evacStore.fireSimulation }">
                  <rect x="70" y="100" width="130" height="32" rx="3"
                    :fill="evacStore.fireSimulation ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.06)'"
                    :stroke="evacStore.fireSimulation ? '#EF4444' : '#22C55E'"
                    stroke-width="1.5"/>
                  <text x="135" y="121" :fill="evacStore.fireSimulation ? '#EF4444' : '#22C55E'" font-size="10" text-anchor="middle" font-family="sans-serif">A区通道</text>

                  <!-- 左侧出口 -->
                  <rect x="30" y="100" width="40" height="32" rx="3"
                    :fill="evacStore.fireSimulation ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.12)'"
                    :stroke="evacStore.fireSimulation ? '#EF4444' : '#22C55E'"
                    stroke-width="1.5"/>
                  <text x="50" y="121" :fill="evacStore.fireSimulation ? '#EF4444' : '#22C55E'" font-size="9" text-anchor="middle" font-family="sans-serif">出口</text>

                  <!-- 出口图标 -->
                  <g v-if="!evacStore.fireSimulation">
                    <path d="M 45 108 L 50 104 L 55 108 M 50 104 L 50 116" stroke="#22C55E" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                  </g>

                  <!-- 火源标记 -->
                  <g v-if="evacStore.fireSimulation" class="fire-marker" filter="url(#route-glow)">
                    <circle cx="135" cy="116" r="16" fill="rgba(239,68,68,0.15)" class="fire-glow"/>
                    <circle cx="135" cy="116" r="10" fill="rgba(239,68,68,0.3)"/>
                    <path d="M 135 110 C 133 113, 137 115, 135 118 C 133 120, 137 122, 135 124" stroke="#EF4444" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                  </g>

                  <!-- 禁行标记 -->
                  <g v-if="evacStore.fireSimulation" class="forbidden">
                    <circle cx="110" cy="116" r="9" fill="rgba(239,68,68,0.25)" stroke="#EF4444" stroke-width="1.5"/>
                    <line x1="104" y1="110" x2="116" y2="122" stroke="#EF4444" stroke-width="2"/>
                  </g>

                  <!-- 流动箭头 - 常规 -->
                  <g v-if="!evacStore.fireSimulation">
                    <path d="M 200 215 L 200 165 L 135 132" stroke="url(#safe-route-grad)" stroke-width="2" fill="none" stroke-dasharray="5,3" class="flow-line"/>
                    <polygon points="130,130 140,127 138,137" fill="#22C55E" class="flow-dot"/>
                  </g>
                </g>

                <!-- 右侧通道 -->
                <g class="route-right" :class="{ active: evacStore.fireSimulation }">
                  <rect x="200" y="100" width="130" height="32" rx="3"
                    :fill="evacStore.fireSimulation ? 'rgba(76,201,240,0.1)' : 'rgba(76,201,240,0.04)'"
                    :stroke="evacStore.fireSimulation ? '#4CC9F0' : 'rgba(76,201,240,0.3)'"
                    stroke-width="1.5"/>
                  <text x="265" y="121" :fill="evacStore.fireSimulation ? '#4CC9F0' : 'rgba(76,201,240,0.5)'" font-size="10" text-anchor="middle" font-family="sans-serif">B区通道</text>

                  <!-- 右侧出口 -->
                  <rect x="330" y="100" width="40" height="32" rx="3"
                    :fill="evacStore.fireSimulation ? 'rgba(76,201,240,0.15)' : 'rgba(76,201,240,0.06)'"
                    :stroke="evacStore.fireSimulation ? '#4CC9F0' : 'rgba(76,201,240,0.3)'"
                    stroke-width="1.5"/>
                  <text x="350" y="121" :fill="evacStore.fireSimulation ? '#4CC9F0' : 'rgba(76,201,240,0.5)'" font-size="9" text-anchor="middle" font-family="sans-serif">出口</text>

                  <!-- 出口图标 -->
                  <g v-if="evacStore.fireSimulation">
                    <path d="M 345 108 L 350 104 L 355 108 M 350 104 L 350 116" stroke="#4CC9F0" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                  </g>

                  <!-- 流动箭头 - 应急 -->
                  <g v-if="evacStore.fireSimulation">
                    <path d="M 205 215 L 205 165 L 265 132" stroke="url(#safe-route-grad)" stroke-width="2" fill="none" stroke-dasharray="5,3" class="flow-line emergency-flow"/>
                    <polygon points="263,130 270,127 268,137" fill="#4CC9F0" class="flow-dot"/>
                  </g>

                  <!-- 安全标记 -->
                  <g v-if="evacStore.fireSimulation" class="safe-marker">
                    <circle cx="295" cy="116" r="9" fill="rgba(34,197,94,0.25)" stroke="#22C55E" stroke-width="1.5"/>
                    <polyline points="291,116 294,119 300,113" stroke="#22C55E" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                  </g>
                </g>

                <!-- 中央走廊 -->
                <rect x="195" y="132" width="10" height="83" fill="rgba(10,25,45,0.6)" stroke="rgba(76,201,240,0.15)" stroke-width="1"/>

                <!-- 人员起始位置 -->
                <g class="person-group" filter="url(#route-glow)">
                  <circle cx="200" cy="220" r="11" fill="#4CC9F0" class="person-dot"/>
                  <circle cx="200" cy="220" r="6" fill="#1B1F2A"/>
                  <text x="200" y="224" fill="#4CC9F0" font-size="8" text-anchor="middle" font-weight="bold" font-family="sans-serif">人</text>
                </g>

                <!-- 方向指示文字 -->
                <g class="direction-indicator">
                  <g v-if="!evacStore.fireSimulation">
                    <rect x="145" y="78" width="110" height="16" rx="2" fill="rgba(34,197,94,0.1)" stroke="rgba(34,197,94,0.3)" stroke-width="1"/>
                    <text x="200" y="89" fill="#22C55E" font-size="10" text-anchor="middle" font-family="sans-serif">← 常规疏散方向</text>
                  </g>
                  <g v-if="evacStore.fireSimulation">
                    <rect x="135" y="78" width="130" height="16" rx="2" fill="rgba(34,197,94,0.12)" stroke="rgba(57,255,136,0.45)" stroke-width="1"/>
                    <text x="200" y="89" fill="#39FF88" font-size="10" text-anchor="middle" font-family="sans-serif">→ 应急疏散方向</text>
                  </g>
                </g>

                <!-- 底部状态标签 -->
                <g class="bottom-status">
                  <rect v-if="!evacStore.fireSimulation" x="140" y="242" width="120" height="14" rx="2" fill="rgba(34,197,94,0.1)" stroke="rgba(34,197,94,0.3)" stroke-width="1"/>
                  <text v-if="!evacStore.fireSimulation" x="200" y="252" fill="#22C55E" font-size="9" text-anchor="middle" font-family="sans-serif">常规疏散路线</text>
                  <rect v-if="evacStore.fireSimulation" x="125" y="242" width="150" height="14" rx="2" fill="rgba(76,201,240,0.1)" stroke="rgba(76,201,240,0.3)" stroke-width="1"/>
                  <text v-if="evacStore.fireSimulation" x="200" y="252" fill="#4CC9F0" font-size="9" text-anchor="middle" font-family="sans-serif">应急疏散路线已调整</text>
                </g>
              </svg>
            </div>

            <!-- 路线状态说明 -->
            <div class="route-status-info">
              <div v-if="!evacStore.fireSimulation" class="status-info-normal">
                <span class="status-dot normal"></span>
                <span class="status-text">人员 → A区通道 → 左侧安全出口</span>
              </div>
              <div v-else class="status-info-emergency">
                <div class="status-row">
                  <span class="status-dot danger"></span>
                  <span class="status-text danger">A区通道存在火源风险，已禁行</span>
                </div>
                <div class="status-row">
                  <span class="status-dot safe"></span>
                  <span class="status-text safe">人员 → B区通道 → 右侧安全出口</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧：操作日志 + 设备状态 -->
      <div class="right-panel">
        <!-- 疏散设备状态 -->
        <div class="device-status-panel fire-card">
          <div class="panel-header">
            <div class="panel-title-area">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>
              <h3 class="title-spacing-sm">疏散设备状态</h3>
            </div>
            <span class="device-count num-font">{{ evacStore.currentFloorDevices.length }} 台</span>
          </div>
          <div class="device-list">
            <div
              v-for="dev in evacStore.currentFloorDevices"
              :key="dev.id"
              class="device-item"
              :class="{ active: dev.id === evacStore.currentDeviceId, risk: dev.risk }"
              @click="handleDeviceChange(dev.id)"
            >
              <div class="device-item-left">
                <span class="device-status-dot" :class="dev.status === 'normal' ? 'normal' : dev.status === 'warning' ? 'warning' : 'emergency'"></span>
                <span class="device-item-name">{{ dev.name }}</span>
              </div>
              <div class="device-item-right">
                <span class="device-item-dir num-font">{{ directionMap[dev.direction] }}</span>
                <svg v-if="dev.risk" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--fire-red)"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              </div>
            </div>
          </div>
        </div>

        <!-- 操作日志 -->
        <div class="log-panel">
          <OperationLog />
        </div>
      </div>
    </div>

    <!-- 交互流程标注 -->
    <div class="flow-bar fire-card">
      <svg class="flow-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v6a3 3 0 0 0 3 3h6"/></svg>
      <div class="flow-steps">
        <span class="flow-step">确认疏散路径</span>
        <span class="flow-arrow">→</span>
        <span class="flow-step">疏散灯方向联动</span>
        <span class="flow-arrow">→</span>
        <span class="flow-step">应急灯脉冲强闪</span>
        <span class="flow-arrow">→</span>
        <span class="flow-step">人员动态撤离</span>
        <span class="flow-arrow">→</span>
        <span class="flow-step">滞留人员识别</span>
        <span class="flow-arrow">→</span>
        <span class="flow-step">协同消防救援</span>
        <span class="flow-arrow">→</span>
        <span class="flow-step">日志记录</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, reactive } from 'vue'
import { useFireStore } from '../stores/fireStore'
import { directionMap, directionAngle, floorOptions } from '../mock/evacuation'
import OperationLog from '../components/OperationLog.vue'

const fireStore = useFireStore()

// 疏散演示固定建筑（与 Dashboard 默认展示建筑一致）
const EVAC_BUILDING = '3号楼'

// 本地疏散视图状态
const currentFloor = ref('3F')
const currentDeviceId = ref('')
const switching = ref(false)
const switchResult = ref(null)
const pendingDirection = ref(null)

// 方向选择：仅支持 left / right 两个方向（页面内直接下发，不用弹窗）
function selectDirection(dir) {
  const dev = currentDevice.value
  if (!dev || switching.value) return
  if (dir === dev.direction) return
  pendingDirection.value = dir
  confirmSwitch()
}

// 当前楼栋+楼层疏散设备列表（真实层级过滤，不再混入其他楼栋同层设备）
const currentFloorDevices = computed(() =>
  fireStore.devices
    .filter((d) => d.type === 'evacuation_light' && d.building === EVAC_BUILDING && d.floor === currentFloor.value)
    .sort((a, b) => a.id.localeCompare(b.id))
)

// 楼层/设备变化时，默认选中第一个设备
watch(
  currentFloorDevices,
  (list) => {
    if (list.length && !list.find((d) => d.id === currentDeviceId.value)) {
      currentDeviceId.value = list[0].id
    }
  },
  { immediate: true }
)

// 当前选中设备（兼容模板中的 risk 字段）
const currentDevice = computed(() => {
  const dev = fireStore.devices.find((d) => d.id === currentDeviceId.value)
  if (!dev) return null
  return new Proxy(dev, {
    get(target, prop) {
      if (prop === 'risk') {
        return !!(
          fireStore.fireEvent &&
          fireStore.fireEvent.building === target.building &&
          fireStore.fireEvent.floor === target.floor &&
          fireStore.fireEvent.area === target.area
        )
      }
      return target[prop]
    },
  })
})

const fireSimulation = computed(() => !!fireStore.fireEvent)
const fireLocation = computed(() => fireStore.fireEvent?.area || fireStore.riskAreas[0]?.zone || null)

const currentDirectionLabel = computed(() =>
  currentDevice.value ? directionMap[currentDevice.value.direction] : '—'
)

const recommendedDirection = computed(() => {
  if (!currentDevice.value) return null
  const oppositeMap = { left: 'right', right: 'left' }
  return oppositeMap[currentDevice.value.direction]
})

const recommendedDirectionLabel = computed(() =>
  recommendedDirection.value ? directionMap[recommendedDirection.value] : '—'
)

const moduleStatus = computed(() => {
  if (currentDevice.value?.risk) return 'emergency'
  if (fireSimulation.value) return 'warning'
  return 'normal'
})

const statusLabel = computed(() => {
  const s = moduleStatus.value
  if (s === 'emergency') return '应急方向已调整'
  if (s === 'warning') return '检测到前方风险，建议调整疏散方向'
  return '疏散路线正常'
})

// 疏散区域人数：当前选中疏散设备所在区域（building+floor+zone）的人员数
// 区域内无人（如楼梯间疏散灯）时回落为该楼层总人数
const evacFloorPersons = computed(() => {
  const dev = fireStore.devices.find((d) => d.id === currentDeviceId.value)
  if (!dev) return 0
  const building = dev.building || EVAC_BUILDING
  const floor = dev.floor || currentFloor.value
  const floorPersons = (fireStore.persons || []).filter(
    (p) => p && p.building === building && p.floor === floor
  )
  const zone = dev.area || ''
  if (zone) {
    const zonePersons = floorPersons.filter((p) => p.zone === zone)
    if (zonePersons.length > 0) return zonePersons.length
  }
  return floorPersons.length
})

// 保持模板变量名不变的兼容对象
const evacStore = reactive({
  currentFloor,
  currentDeviceId,
  floorOpts: floorOptions,
  currentFloorDevices,
  currentDevice,
  currentDirectionLabel,
  recommendedDirectionLabel,
  moduleStatus,
  statusLabel,
  fireSimulation,
  fireLocation,
  evacFloorPersons,
  switching,
  switchResult,
})

const statusClass = computed(() => {
  const s = evacStore.moduleStatus
  if (s === 'emergency') return 'emergency'
  if (s === 'warning') return 'warning'
  return 'normal'
})

const deviceStatusLabel = computed(() => {
  const s = evacStore.currentDevice?.status
  if (s === 'normal') return '在线'
  if (s === 'warning') return '风险预警'
  if (s === 'emergency') return '应急模式'
  return '—'
})

const deviceStatusClass = computed(() => {
  const s = evacStore.currentDevice?.status
  if (s === 'normal') return 'green'
  if (s === 'warning') return 'orange'
  if (s === 'emergency') return 'cyan'
  return ''
})

// 箭头角度
const currentAngle = ref(0)
const targetAngle = ref(0)

watch(
  () => evacStore.currentDevice?.direction,
  (newDir) => {
    if (newDir) {
      const newAngle = directionAngle[newDir]
      let diff = newAngle - targetAngle.value
      if (diff > 180) diff -= 360
      if (diff < -180) diff += 360
      targetAngle.value += diff
      currentAngle.value = targetAngle.value
    }
  },
  { immediate: true }
)

// 操作
function handleFloorChange(floor) {
  currentFloor.value = floor
}

function handleDeviceChange(deviceId) {
  currentDeviceId.value = deviceId
}

function handleSimulateFire() {
  if (fireSimulation.value) return
  const building = currentDevice.value?.building || '3号楼'
  const floor = currentFloor.value
  const area = currentDevice.value?.area || 'A区'
  // 触发火灾场景（回指挥中心时由状态机同步阶段），风险信息通过页面内风险提示面板直接显示
  fireStore.triggerFireScenario(building, floor, area)
}

function handleSwitchClick() {
  if (switching.value) return
  confirmSwitch()
}

function confirmSwitch() {
  if (!currentDevice.value || switching.value) return

  const dev = currentDevice.value
  const oppositeMap = { left: 'right', right: 'left' }
  const newDirection = pendingDirection.value || recommendedDirection.value || oppositeMap[dev.direction] || dev.direction
  const reason = dev.risk ? '管理员手动触发方向切换，避开火源' : '管理员手动切换疏散方向'

  switching.value = true
  switchResult.value = null

  setTimeout(() => {
    fireStore.switchEvacuationDirection(dev.id, newDirection, reason)
    switching.value = false
    switchResult.value = 'success'
    pendingDirection.value = null

    // 切换结果在按钮上以「方向切换成功」页面内反馈展示（不用弹窗）
    setTimeout(() => {
      switchResult.value = null
    }, 3000)
  }, 900)
}
</script>

<style scoped>
.evacuation-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 10px;
  overflow: hidden;
}

/* 页面头部 */
.page-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 4px;
}

.header-bar {
  width: 2px;
  height: 32px;
  background: var(--fire-green);

  flex-shrink: 0;
}

.header-text h2 {
  font-size: 18px;
  color: var(--text-primary);
  font-weight: 700;
  letter-spacing: 2px;
  line-height: 1.2;
}

.header-sub {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

/* 主体区域 */
.main-content {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 10px;
  min-height: 0;
}

.left-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.right-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

/* 楼层/设备选择区 */
.filter-section {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--fire-border);
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
}

.filter-group {
  display: flex;
  gap: 10px;
  align-items: center;
}

.filter-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.filter-item svg {
  color: var(--fire-blue);
  flex-shrink: 0;
}

.filter-info {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.info-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 2px;
  background: rgba(76, 201, 240, 0.04);
  border: 1px solid var(--fire-border);
}

.tag-label {
  color: var(--text-tertiary);
}

.tag-value {
  color: var(--text-primary);
}

.text-cyan { color: var(--fire-cyan); }
.text-green { color: var(--fire-green); }
.text-orange { color: var(--fire-orange); }

.module-status-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 2px;
  border: 1px solid transparent;
}

.module-status-tag.normal {
  background: rgba(34, 197, 94, 0.08);
  border-color: rgba(34, 197, 94, 0.3);
  color: var(--fire-green);
}

.module-status-tag.warning {
  background: rgba(245, 158, 11, 0.08);
  border-color: rgba(245, 158, 11, 0.3);
  color: var(--fire-orange);
}

.module-status-tag.emergency {
  background: rgba(76, 201, 240, 0.08);
  border-color: rgba(76, 201, 240, 0.3);
  color: var(--fire-cyan);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.status-dot.normal { background: var(--fire-green); box-shadow: 0 0 4px var(--fire-green); }
.status-dot.warning { background: var(--fire-orange); box-shadow: 0 0 4px var(--fire-orange); animation: blink 1s ease-in-out infinite; }
.status-dot.emergency { background: var(--fire-cyan); box-shadow: 0 0 4px var(--fire-cyan); }

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* 核心区域 */
.core-section {
  flex: 1;
  display: grid;
  grid-template-columns: 340px 1fr;
  min-height: 0;
}

/* 方向控制区 */
.direction-control {
  padding: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  border-right: 1px solid var(--fire-border);
  gap: 10px;
  overflow-y: auto;
}

.section-label {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 2px;
}

/* 大方向箭头 */
.arrow-display {
  position: relative;
  width: 130px;
  height: 130px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.arrow-rings {
  position: absolute;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ring {
  position: absolute;
  border-radius: 50%;
  border: 1px solid transparent;
}

.ring-1 {
  width: 120px;
  height: 120px;
}

.ring-2 {
  width: 100px;
  height: 100px;
}

.arrow-rings.normal .ring { border-color: rgba(57, 255, 136, 0.15); }
.arrow-rings.normal .ring-1 { animation: ringPulse 3s ease-in-out infinite; }
.arrow-rings.normal .ring-2 { animation: ringPulse 3s ease-in-out infinite 0.5s; }

.arrow-rings.warning .ring { border-color: rgba(57, 255, 136, 0.2); }
.arrow-rings.warning .ring-1 { animation: ringPulse 2s ease-in-out infinite; }
.arrow-rings.warning .ring-2 { animation: ringPulse 2s ease-in-out infinite 0.5s; }

.arrow-rings.emergency .ring { border-color: rgba(57, 255, 136, 0.28); }
.arrow-rings.emergency .ring-1 { animation: ringPulse 2s ease-in-out infinite; }
.arrow-rings.emergency .ring-2 { animation: ringPulse 2s ease-in-out infinite 0.5s; }

@keyframes ringPulse {
  0%, 100% { transform: scale(1); opacity: 0.6; }
  50% { transform: scale(1.1); opacity: 0.2; }
}

/* 疏散指示灯箭头恒绿：正常轻微绿光晕，应急强绿光晕（不变红/不变蓝） */
.arrow-display.normal .arrow-svg { filter: drop-shadow(0 0 10px rgba(57, 255, 136, 0.35)); }
.arrow-display.warning .arrow-svg { filter: drop-shadow(0 0 12px rgba(57, 255, 136, 0.45)); }
.arrow-display.emergency .arrow-svg { filter: drop-shadow(0 0 16px rgba(57, 255, 136, 0.65)); }

.arrow-wrapper {
  width: 100px;
  height: 100px;
  transition: transform 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  z-index: 1;
}

/* 方向标签 */
.direction-label {
  display: flex;
  align-items: center;
}

.dir-text {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 3px;
}

/* 疏散方向文字恒绿（绿色 = 疏散方向语义） */
.dir-text.normal { color: #39FF88; }
.dir-text.warning { color: #39FF88; }
.dir-text.emergency { color: #39FF88; text-shadow: 0 0 8px rgba(57, 255, 136, 0.6); }

/* 四向方向选择面板 */
.direction-pad-wrapper {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.pad-label {
  font-size: 11px;
  color: var(--text-tertiary, #64748b);
  letter-spacing: 1px;
  text-transform: uppercase;
}

.direction-pad {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.pad-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: 1px solid rgba(100, 116, 139, 0.3);
  background: rgba(13, 19, 32, 0.6);
  color: #94a3b8;
  cursor: pointer;
  transition: all 0.18s ease;
}

.pad-btn:hover:not(:disabled) {
  border-color: rgba(76, 201, 240, 0.5);
  color: var(--fire-cyan);
  background: rgba(76, 201, 240, 0.08);
}

.pad-btn.active {
  border-color: var(--fire-cyan);
  color: var(--fire-cyan);
  background: rgba(76, 201, 240, 0.15);
  box-shadow: 0 2px 8px rgba(76, 201, 240, 0.15);
}

.pad-btn.disabled,
.pad-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 左 / 右 两键布局 */
.pad-btn {
  width: 92px;
  height: 56px;
  flex-direction: column;
  gap: 2px;
}

.pad-btn span {
  font-size: 12px;
  font-weight: 600;
}

/* 设备状态行 */
.device-status-row {
  display: flex;
  gap: 6px;
}

/* 切换按钮 */
.switch-btn {
  margin-top: 2px;
  padding: 10px 28px;
  border-radius: 3px;
  border: 1px solid rgba(76, 201, 240, 0.3);
  background: linear-gradient(135deg, rgba(76,201,240,0.15), rgba(76,201,240,0.05));
  color: var(--fire-cyan);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 170px;
  justify-content: center;
  letter-spacing: 1px;
}

.switch-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(76,201,240,0.25), rgba(76,201,240,0.1));
  box-shadow: 0 2px 8px rgba(76, 201, 240, 0.18);
}

.switch-btn:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.switch-btn.switching {
  border-color: rgba(245, 158, 11, 0.3);
  background: linear-gradient(135deg, rgba(245,158,11,0.15), rgba(245,158,11,0.05));
  color: var(--fire-orange);
}

.switch-btn.success {
  border-color: rgba(34, 197, 94, 0.3);
  background: linear-gradient(135deg, rgba(34,197,94,0.15), rgba(34,197,94,0.05));
  color: var(--fire-green);
}

.btn-loading {
  display: flex;
  align-items: center;
  gap: 6px;
}

.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid rgba(245, 158, 11, 0.3);
  border-top-color: var(--fire-orange);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.btn-success {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn-normal {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 模拟火源按钮 */
.fire-sim-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 6px 16px;
  border-radius: 3px;
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: linear-gradient(135deg, rgba(239,68,68,0.12), rgba(239,68,68,0.03));
  color: var(--fire-red);
  cursor: pointer;
  transition: all 0.2s;
}

.fire-sim-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(239,68,68,0.2), rgba(239,68,68,0.08));
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.16);
}

.fire-sim-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 风险提示 */
.risk-warning {
  margin-top: 4px;
  padding: 10px 14px;
  border-radius: 3px;
  background: linear-gradient(135deg, rgba(245,158,11,0.08), rgba(239,68,68,0.03));
  border: 1px solid rgba(245, 158, 11, 0.25);
  width: 100%;
  animation: slideDown 0.3s ease-out;
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

.risk-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.risk-header svg {
  color: var(--fire-orange);
}

.risk-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fire-orange);
  letter-spacing: 1px;
}

.risk-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.risk-desc {
  font-size: 11px;
  color: var(--fire-red);
  margin: 0;
}

.risk-suggest {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 10px;
  background: rgba(27, 31, 42, 0.5);
  border-radius: 3px;
  border: 1px solid var(--fire-border);
}

.suggest-label {
  font-size: 10px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.suggest-content {
  font-size: 11px;
  color: var(--text-secondary);
}

.dir-old { color: var(--fire-orange); }
.dir-new { color: var(--fire-green); }

.suggest-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 3px;
  border: 1px solid rgba(76, 201, 240, 0.3);
  background: linear-gradient(135deg, rgba(76,201,240,0.12), rgba(76,201,240,0.03));
  color: var(--fire-cyan);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.suggest-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(76,201,240,0.2), rgba(76,201,240,0.08));
  box-shadow: 0 2px 8px rgba(76, 201, 240, 0.15);
}

.suggest-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 路线对比区 */
.route-section {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.route-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  border-bottom: 1px solid var(--fire-border);
  flex-shrink: 0;
}

.route-title-area {
  display: flex;
  align-items: center;
  gap: 6px;
}

.route-title-area svg {
  color: var(--fire-blue);
}

.route-header h4 {
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 600;
}

.mode-tags {
  display: flex;
  gap: 5px;
}

.mode-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 2px;
background: rgba(76, 201, 240, 0.08);
  color: var(--text-tertiary);
  border: 1px solid transparent;
  transition: all 0.2s;
}

.mode-tag.active {
  background: rgba(34, 197, 94, 0.1);
  color: var(--fire-green);
  border-color: rgba(34, 197, 94, 0.3);
}

.mode-tag.emergency.active {
  background: rgba(76, 201, 240, 0.1);
  color: var(--fire-cyan);
  border-color: rgba(76, 201, 240, 0.3);
}

.route-svg-container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  min-height: 0;
}

.route-svg {
  width: 100%;
  max-width: 440px;
  height: auto;
}

/* 路线动画 */
.flow-line {
  animation: flowDash 1s linear infinite;
}

@keyframes flowDash {
  to { stroke-dashoffset: -16; }
}

.flow-dot {
  animation: flowPulse 1.5s ease-in-out infinite;
}

@keyframes flowPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.emergency-flow {
  animation: flowDash 0.6s linear infinite;
}

.fire-glow {
  animation: fireGlow 1s ease-in-out infinite;
}

@keyframes fireGlow {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 0.2; }
}

.person-dot {
  animation: personBreathe 2s ease-in-out infinite;
}

@keyframes personBreathe {
  0%, 100% { filter: drop-shadow(0 0 4px #4CC9F0); }
  50% { filter: drop-shadow(0 0 10px #4CC9F0); }
}

/* 路线状态说明 */
.route-status-info {
  padding: 7px 14px;
  border-top: 1px solid var(--fire-border);
  flex-shrink: 0;
}

.status-info-normal,
.status-info-emergency {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.normal { background: var(--fire-green); box-shadow: 0 0 4px var(--fire-green); }
.status-dot.danger { background: var(--fire-red); box-shadow: 0 0 4px var(--fire-red); }
.status-dot.safe { background: var(--fire-cyan); box-shadow: 0 0 4px var(--fire-cyan); }

.status-text {
  font-size: 11px;
  color: var(--text-secondary);
}

.status-text.danger { color: var(--fire-red); }
.status-text.safe { color: var(--fire-cyan); }

/* 疏散设备状态面板 */
.device-status-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
  max-height: 40%;
}

.panel-header {
  padding: 10px 12px;
  border-bottom: 1px solid var(--fire-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}

.panel-title-area {
  display: flex;
  align-items: center;
  gap: 6px;
}

.panel-title-area svg {
  color: var(--fire-blue);
}

.panel-header h3 {
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 600;
}

.device-count {
  font-size: 11px;
  color: var(--text-tertiary);
  background: rgba(76, 201, 240, 0.04);
  padding: 2px 8px;
  border-radius: 2px;
  border: 1px solid var(--fire-border);
}

.device-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 6px;
}

.device-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 3px;
  margin-bottom: 3px;
background: rgba(20, 27, 46, 0.7);
  border: 1px solid var(--fire-border);
  cursor: pointer;
  transition: all 0.2s;
}

.device-item:hover {
  border-color: rgba(76, 201, 240, 0.25);
  background: rgba(76, 201, 240, 0.04);
}

.device-item.active {
  border-color: rgba(76, 201, 240, 0.4);
  background: rgba(76, 201, 240, 0.06);
}

.device-item.risk {
  border-color: rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.04);
}

.device-item-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.device-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.device-status-dot.normal { background: var(--fire-green); box-shadow: 0 0 4px var(--fire-green); }
.device-status-dot.warning { background: var(--fire-orange); box-shadow: 0 0 4px var(--fire-orange); animation: blink 1s ease-in-out infinite; }
.device-status-dot.emergency { background: var(--fire-cyan); box-shadow: 0 0 4px var(--fire-cyan); }

.device-item-name {
  font-size: 12px;
  color: var(--text-primary);
}

.device-item-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.device-item-dir {
  font-size: 11px;
  color: #39FF88;
}

/* 操作日志面板 */
.log-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 交互流程标注 */
.flow-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  flex-shrink: 0;
}

.flow-icon {
  color: var(--fire-green);
  flex-shrink: 0;
}

.flow-steps {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.flow-step {
  font-size: 11px;
  color: var(--text-secondary);
  letter-spacing: 1px;
  white-space: nowrap;
}

.flow-arrow {
  font-size: 10px;
  color: var(--text-tertiary);
}

/* 风险提示过渡 */
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s, transform 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateY(-8px); }

/* 响应式 */
@media (max-width: 1366px) {
  .core-section {
    grid-template-columns: 300px 1fr;
  }
  .arrow-display {
    width: 110px;
    height: 110px;
  }
  .arrow-wrapper {
    width: 85px;
    height: 85px;
  }
  .dir-text {
    font-size: 20px;
  }
}
</style>
